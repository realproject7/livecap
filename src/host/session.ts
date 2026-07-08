// The per-meeting session host (#11): wires the engine tiers (#5/#6) behind
// the loss-free FallbackRouter (#7), the credit accountant (#7), the extras
// pipeline (#9), and the crash-safe archive writer (#8) to the JSONL protocol
// the Rust shell speaks (src/protocol.ts). One process per session; stdout is
// the event stream, stderr stays content-free.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  ClaudeCliEngine,
  computeMeetingMetrics,
  CreditAccountant,
  ExtrasBudget,
  ExtrasBudgetExceededError,
  ExtrasPipeline,
  FallbackRouter,
  nodeLedgerFs,
  SummaryCadence,
} from "@livecap/engine";
import type {
  EngineHealthEvent,
  FinalizedRecord,
  GaugeState,
  MeetingMetrics,
  ReplyIntent,
  TranslationEngine,
  Usage,
} from "@livecap/engine";
import {
  adoptOrphanRecordings,
  nodeArchiveFs,
  SessionArchiveWriter,
  sweepOldArchives,
} from "@livecap/archive";
import type { BoardData, CaptionEntry, MetricsData } from "@livecap/archive";

import type { Channel, CoachingItemWire, GaugeWire, HostInbound, HostOutbound } from "../protocol.ts";
import { coachingAmendKeys } from "./coaching-keys.ts";
import { detectClaudeCli } from "./detect-cli.ts";
import { toFinalizedRecords } from "./metrics-records.ts";
import { LazyLocalEngine } from "./local-tier.ts";
import { SILENCE_THRESHOLD_MS, SilenceWatchdog } from "./silence.ts";
import { resolveStartConfig } from "./start-config.ts";
import { withTimeout } from "./timeout.ts";
import { TranslationRunner } from "./translation-runner.ts";

const CLI_ENGINE_LABEL = "Claude CLI";
const LOCAL_ENGINE_LABEL = "Local (Qwen3 4B)";
const SUMMARY_TICK_MS = 5_000;
/** Recent transcript lines fed as context to a targeted analysis (#80). */
const ANALYZE_CONTEXT_LINES = 10;
const WATCHDOG_TICK_MS = 15_000;
const DRAIN_TIMEOUT_MS = 20_000;
/** Liveness heartbeat for the in-progress recording (#69): the writer touches
 *  its working file this often so a concurrent session start sees it as ALIVE. */
const RECORDING_HEARTBEAT_MS = 10_000;
/** A recording untouched for longer than this is treated as a crashed orphan
 *  eligible for adoption (#69). Wide margin over RECORDING_HEARTBEAT_MS so a live
 *  session's heartbeat always keeps its file comfortably "fresh". */
const RECORDING_STALE_AFTER_MS = 60_000;
/** Hard backstop on engine startup (#65). The per-chunk download stall detection
 *  (ensureModel) is the primary guard; no healthy first-run download approaches
 *  this. If it fires, the session start fails with a content-free status instead
 *  of wedging the host's message chain (and blocking every queued caption). */
const ENGINE_READY_TIMEOUT_MS = 15 * 60_000;

type StartConfig = Extract<HostInbound, { type: "start" }>;

interface CaptionMeta {
  channel: Channel;
  text: string;
  lowConfidence: boolean;
  epochMs: number;
  /** Spoken duration in ms (#81/#78) — accumulated into the FinalizedRecord[]
   *  the post-meeting metrics consume. */
  durationMs: number;
}

function clockLabel(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fileNamePrefix(epochMs: number): string {
  const date = new Date(epochMs);
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${hh}${mm}`;
}

function errorDetail(error: unknown): string {
  // Engine errors carry content-free messages by contract (#23).
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Merge a (re)translation result into an already-archived entry, in place.
 * A FAILED or empty result (`text === ""`) is IGNORED so a failed retranslate
 * never erases a previously-good archived target (#139) — the archive keeps the
 * good value while the UI shows "failed". Returns true when the entry actually
 * changed, so the caller re-persists the brief only on a real rewrite.
 */
export function applyRetranslation(existing: CaptionEntry, text: string): boolean {
  if (text === "") return false;
  existing.target = text;
  return true;
}

/** The slice of an engine {@link meterEngines} needs — every tier exposes it. */
interface UsageMeterable {
  onUsage(listener: (usage: Usage) => void): () => void;
}

/**
 * Meter every DISTINCT engine whose usage must be summed for the session (#142).
 * The CLI-tier two-lane split runs two `ClaudeCliEngine` sessions (live
 * translation + summary/extras) that both fall back to ONE shared local engine.
 * Attaching each engine exactly once makes usage/cost sum across both lanes
 * without double-counting the shared local (which appears in both lanes). The
 * internal identity set guards against an engine being passed twice.
 *
 * `attach` wires the credit ledger; `addTurnCost` tallies the session cost.
 */
export function meterEngines(
  engines: Iterable<UsageMeterable>,
  attach: (engine: UsageMeterable) => void,
  addTurnCost: (turnCostUsd: number) => void,
): void {
  const seen = new Set<UsageMeterable>();
  for (const engine of engines) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    attach(engine);
    engine.onUsage((usage) => addTurnCost(usage.turnCostUsd));
  }
}

export class HostSession {
  /** Routers for the two CLI lanes (null on the local-only path). A credit- or
   *  health-driven fallback switches BOTH to the shared local engine (#142). */
  private translationRouter: FallbackRouter | null = null;
  private extrasRouter: FallbackRouter | null = null;
  /** Distinct engines started this session — the teardown set (#142): the two
   *  routers on the CLI tier, or the single shared local engine otherwise. */
  private readonly startedEngines = new Set<TranslationEngine>();
  private accountant: CreditAccountant | null = null;
  private extras: ExtrasPipeline | null = null;
  private extrasBudget: ExtrasBudget | null = null;
  private runner: TranslationRunner | null = null;
  private writer: SessionArchiveWriter | null = null;
  private watchdog: SilenceWatchdog | null = null;
  private readonly cadence = new SummaryCadence();

  private readonly metaById = new Map<number, CaptionMeta>();
  private readonly entriesById = new Map<number, CaptionEntry>();
  private readonly pendingPins = new Set<number>();
  private readonly transcriptLines: string[] = [];
  private sessionCostUsd = 0;
  private startedAtMs = 0;
  private summaryRunning = false;
  /** How many transcript lines are already folded into `lastSummary` — the
   *  boundary for the incremental summary delta (#55). */
  private summarizedLineCount = 0;
  /** Latch so the "extras budget reached" notice is surfaced exactly once. */
  private extrasBudgetNoticeSent = false;
  private lastSummary: { summary: string[]; board: BoardData } | null = null;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private stopping = false;
  private started = false;
  /** §8.7 auto-switch toggle: gates both the credit- and health-driven (#135)
   *  fallback to the local tier. */
  private autoSwitch = false;
  /** Archive folder for the periodic orphan-adoption pass (#69). */
  private archiveDir = "";

  constructor(private readonly emit: (event: HostOutbound) => void) {}

  async handle(message: HostInbound): Promise<void> {
    switch (message.type) {
      case "start":
        await this.start(message);
        return;
      case "caption":
        this.onCaption(message);
        return;
      case "quickTranslate":
        // Not awaited: an engine turn takes seconds and captions queued
        // behind it in the message chain must keep flowing.
        void this.onQuickTranslate(message.id, message.text);
        return;
      case "reply":
        void this.onReply(message.id, message.intent);
        return;
      case "analyze":
        void this.onAnalyze(message.cardId, message.captionId);
        return;
      case "coach":
        void this.onCoach(message.cardId, message.captionIds);
        return;
      case "retranslate":
        this.onRetranslate(message.id);
        return;
      case "pin":
        this.onPin(message.id, message.pinned);
        return;
      case "silenceSnooze":
        this.watchdog?.snooze(Date.now());
        return;
      case "stop":
        await this.stop();
        return;
    }
  }

  private async start(config: StartConfig): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAtMs = Date.now();

    // Settings → subsystem mapping (#12): language names, gauge config,
    // router default, archive policy.
    const resolved = resolveStartConfig(config);
    this.autoSwitch = resolved.autoSwitch;

    const accountant = new CreditAccountant({
      fs: nodeLedgerFs(),
      ledgerPath: join(config.appDataDir, "credit-ledger.json"),
      poolUsd: resolved.poolUsd,
      resetDay: resolved.resetDay,
      now: Date.now,
    });
    this.accountant = accountant;

    const local = new LazyLocalEngine({
      dataDir: config.appDataDir,
      targetLanguage: resolved.targetLanguage,
      onStatus: (detail) => this.emit({ type: "status", detail }),
    });

    // Engine preference (§8.7 segmented control): "local" leads with the
    // local tier outright; "cli" detects the CLI and routes through the
    // fallback router (never a dead end — no CLI still means local).
    const cli = resolved.enginePref === "cli" ? await detectClaudeCli(process.env.PATH) : null;
    let engineLabel: string;
    let translationEngine: TranslationEngine;
    let extrasEngine: TranslationEngine;
    // Distinct engines whose usage must be summed — attached once each below so
    // the shared local fallback is never double-counted across the two lanes.
    const metered: UsageMeterable[] = [];
    if (cli) {
      const cwd = join(config.appDataDir, "cli-session");
      mkdirSync(cwd, { recursive: true });
      // Dedicated translation lane (#142): TWO persistent CLI sessions — one for
      // live translation, one for summary/extras — so a summary turn (awaited,
      // ~1–5s) no longer head-of-line-blocks live captions through a single
      // shared turn mutex. Both fall back to the SAME local engine: the split is
      // CLI-tier only; running two 4B llama-servers is not worth it, so on the
      // local path summary still contends there (documented, unchanged).
      const engineConfig = {
        bin: cli.bin,
        cwd,
        env: process.env,
        includePartialMessages: cli.includePartialMessages,
        targetLanguage: resolved.targetLanguage,
      };
      // Each ClaudeCliEngine mints its own session id (config.sessionId omitted),
      // so the two persistent `claude -p` conversations stay independent.
      const translationPrimary = new ClaudeCliEngine(engineConfig);
      const extrasPrimary = new ClaudeCliEngine(engineConfig);
      // Health/error-driven recovery (#135) preserved on BOTH lanes: a respawn
      // surfaces a content-free status; a `degraded` streak drives fallback to
      // local, alongside the credit-threshold path wired below. The per-turn
      // watchdog rides inside each ClaudeCliEngine, so it too carries to both.
      translationPrimary.onHealthEvent((event) => this.onEngineHealthEvent(event));
      extrasPrimary.onHealthEvent((event) => this.onEngineHealthEvent(event));
      const startOnFallback = () => resolved.autoSwitch && accountant.isBelowThreshold();
      this.translationRouter = new FallbackRouter({ primary: translationPrimary, fallback: local, startOnFallback });
      this.extrasRouter = new FallbackRouter({ primary: extrasPrimary, fallback: local, startOnFallback });
      translationEngine = this.translationRouter;
      extrasEngine = this.extrasRouter;
      // Meter each concrete engine (not the routers): the shared local appears
      // once, so its usage isn't summed twice across the two lanes (#142).
      metered.push(translationPrimary, extrasPrimary, local);
      engineLabel = CLI_ENGINE_LABEL;
    } else {
      if (resolved.enginePref === "cli") {
        this.emit({ type: "status", detail: "no Claude CLI found — using the local model" });
      }
      // Local-only path: both lanes converge on the ONE shared local engine
      // (summary still contends with translation here, as before) (#142).
      translationEngine = local;
      extrasEngine = local;
      metered.push(local);
      engineLabel = LOCAL_ENGINE_LABEL;
    }
    this.startedEngines.add(translationEngine);
    this.startedEngines.add(extrasEngine);

    // Sum usage/cost across every lane (#142): attach the ledger and the
    // session-cost tally to each distinct engine exactly once.
    meterEngines(
      metered,
      (engine) => accountant.attach(engine),
      (turnCostUsd) => {
        this.sessionCostUsd += turnCostUsd;
      },
    );
    accountant.onEvent((event) => {
      if (event.type === "gauge") {
        this.emit({ type: "gauge", gauge: this.withExtrasBudget(event.gauge) });
      } else if (event.type === "engine-switch") {
        // §8.7 auto-switch toggle: when off, the gauge still updates but the
        // session stays on the CLI tier.
        if (resolved.autoSwitch) this.switchToLocal();
      } else {
        this.emit({ type: "status", detail: "credit ledger write failed — accounting paused" });
      }
    });

    this.emit({ type: "status", detail: "starting translation engine…" });
    try {
      // Bound engine readiness (#65): a wedged first-run model acquisition must
      // not hang the host's serialized message chain forever (the #13 symptom —
      // captions queued behind start were never processed). Start every distinct
      // lane (two CLI sessions, or the single shared local engine).
      await withTimeout(
        Promise.all(Array.from(this.startedEngines, (engine) => engine.start())),
        ENGINE_READY_TIMEOUT_MS,
      );
    } catch (error) {
      // Terminal: surface a content-free failure the Rust shell acts on — it
      // tears the half-started session down to idle with a durable status
      // (instead of leaving it "live" with captions but no translation, #65).
      this.emit({
        type: "startFailed",
        detail: `translation engine did not start (${errorDetail(error)})`,
      });
      return;
    }
    // Both lanes share one startOnFallback predicate, so they begin on the same
    // tier; the translation router reflects it.
    if (this.translationRouter?.onFallback) {
      engineLabel = LOCAL_ENGINE_LABEL;
      this.emit({ type: "engineSwitch", engine: LOCAL_ENGINE_LABEL });
    }

    // Retention sweep (§8.9): enforced on every session start, so a Settings
    // change applies on the next session without an app restart.
    if (resolved.archiveRetentionDays > 0) {
      sweepOldArchives({
        fs: nodeArchiveFs(),
        folder: config.archiveDir,
        maxAgeDays: resolved.archiveRetentionDays,
        nowMs: Date.now(),
      });
    }

    // Adopt orphaned recordings (#69): a prior session that crashed before
    // finalize() left a `(recording).md` the sweep above intentionally spared
    // (#63). Promote each STALE orphan to a titled archive now — AFTER the sweep
    // (so the sweep never reaps a fresh promotion) and BEFORE this session opens
    // its own working file (so the first pass never sees our own recording). A
    // recording crashed moments ago is still "fresh" and skipped here; the
    // periodic pass below promotes it once it ages past the staleness window,
    // WITHIN this same session (no later session start required).
    this.archiveDir = config.archiveDir;
    this.runAdoptionPass();

    if (resolved.archiveAutoSave) {
      const writer = new SessionArchiveWriter({
        fs: nodeArchiveFs(),
        folder: config.archiveDir,
        meta: {
          fileNamePrefix: fileNamePrefix(this.startedAtMs),
          headerDate: new Date(this.startedAtMs).toISOString().slice(0, 10),
          startClock: clockLabel(this.startedAtMs),
          sourceLang: resolved.sourceLangCode,
          targetLang: resolved.targetLangCode,
          engineName: engineLabel,
          // #53: header notes the channel config when one channel is off.
          channels: resolved.channelsNote ?? undefined,
        },
      });
      writer.open();
      this.writer = writer;
    }

    // Per-session extras budget cap (#55): the recurring auto-summary stops
    // calling the model once this is reached, so a long session can't run away
    // with the monthly pool the way #13 observed.
    this.extrasBudget = new ExtrasBudget({ capUsd: resolved.extrasBudgetUsd });
    this.extras = new ExtrasPipeline({
      // Summary/reply/analyze/coach/quick-translate run on the DEDICATED extras
      // lane (#142) so they never head-of-line-block live translation.
      engine: extrasEngine,
      summaryLanguage: resolved.summaryLanguage,
      meetingLanguage: resolved.meetingLanguage,
      budget: this.extrasBudget,
    });

    this.runner = new TranslationRunner({
      // Live translation runs on its OWN lane, contending with nothing (#142).
      engine: translationEngine,
      callbacks: {
        onSnapshot: (items, done) => this.emit({ type: "translation", items, done }),
        onBatchDone: (results) => this.recordBatch(results),
        onFailed: (ids, detail) => {
          this.emit({ type: "translationFailed", ids, detail });
          // Keep the archive complete: sources land even when translation fails;
          // a later retranslate fills the target in place.
          this.recordBatch(ids.map((id) => ({ id, source: this.metaById.get(id)?.text ?? "", text: "" })));
        },
      },
    });

    this.watchdog = new SilenceWatchdog(SILENCE_THRESHOLD_MS, (sinceMs) =>
      this.emit({ type: "silence", sinceMs }),
    );
    this.watchdog.activity(Date.now());

    this.intervals.push(setInterval(() => void this.summaryTick(), SUMMARY_TICK_MS));
    this.intervals.push(setInterval(() => this.watchdog?.check(Date.now()), WATCHDOG_TICK_MS));
    // Keep this recording's working file warm so a concurrent session start does
    // not mistake it for a crashed orphan and adopt it (#69). Cleared on stop()
    // before finalize(), so it never races the rename.
    this.intervals.push(setInterval(() => this.writer?.heartbeat(), RECORDING_HEARTBEAT_MS));
    // Retry adoption periodically (#69): an orphan that was still "fresh" at
    // start (immediate crash-restart) ages past the staleness window during this
    // session and is promoted here — no later session start needed. This
    // session's own recording stays warm via the heartbeat above, so it is never
    // adopted by these passes.
    this.intervals.push(setInterval(() => this.runAdoptionPass(), RECORDING_STALE_AFTER_MS));

    this.emit({ type: "gauge", gauge: this.withExtrasBudget(accountant.gauge()) });
    this.emit({ type: "ready", engine: engineLabel });
  }

  /** Fold the per-session extras budget (#55) into a gauge snapshot before it
   *  goes on the wire, so the cap + extras spend ride along with the gauge. */
  private withExtrasBudget(gauge: GaugeState): GaugeWire {
    if (!this.extrasBudget) return gauge;
    const snapshot = this.extrasBudget.snapshot();
    return { ...gauge, extrasSpentUsd: snapshot.spentUsd, extrasCapUsd: snapshot.capUsd };
  }

  private emitGauge(): void {
    if (!this.accountant) return;
    this.emit({ type: "gauge", gauge: this.withExtrasBudget(this.accountant.gauge()) });
  }

  /** Content-free CLI health signals (#135). A `respawned` event surfaces a
   *  single status so the user knows translation blipped and recovered; a
   *  `degraded` event (repeated timeouts/crashes) falls back to the local tier,
   *  gated by the same §8.7 auto-switch toggle as the credit path. */
  private onEngineHealthEvent(event: EngineHealthEvent): void {
    if (this.stopping) return;
    if (event.kind === "respawned") {
      this.emit({ type: "status", detail: "translation engine restarted" });
      return;
    }
    // degraded
    if (this.autoSwitch) {
      this.switchToLocal();
    } else {
      this.emit({ type: "status", detail: "translation engine unresponsive" });
    }
  }

  private switchToLocal(): void {
    // Switch BOTH lanes to the (single, shared) local engine (#142): if only the
    // translation lane fell back while summary/extras stayed on the CLI, the
    // always-on summary load would keep draining CLI credits — defeating the
    // credit auto-fallback policy. Idempotent: routers already on local are
    // skipped, and both switchToFallback calls converge on the one local engine.
    const routers = [this.translationRouter, this.extrasRouter].filter(
      (router): router is FallbackRouter => router !== null && !router.onFallback,
    );
    if (routers.length === 0) return;
    void Promise.all(routers.map((router) => router.switchToFallback()))
      .then(() => this.emit({ type: "engineSwitch", engine: LOCAL_ENGINE_LABEL }))
      .catch((error: unknown) =>
        this.emit({ type: "status", detail: `local fallback unavailable (${errorDetail(error)})` }),
      );
  }

  private onCaption(message: Extract<HostInbound, { type: "caption" }>): void {
    if (!this.runner || this.stopping) return;
    this.metaById.set(message.id, {
      channel: message.channel,
      text: message.text,
      lowConfidence: message.lowConfidence,
      epochMs: message.epochMs,
      durationMs: message.durationMs,
    });
    const speaker = message.channel === "me" ? "Me" : "Them";
    this.transcriptLines.push(`${speaker}: ${message.text}`);
    this.watchdog?.activity(Date.now());
    this.runner.enqueue({ id: message.id, text: message.text });
  }

  /** Persist a completed batch (ascending id order keeps the transcript chronological). */
  private recordBatch(results: { id: number; source: string; text: string }[]): void {
    const writer = this.writer;
    if (!writer) return;
    let rewroteExisting = false;
    for (const result of results.slice().sort((a, b) => a.id - b.id)) {
      const existing = this.entriesById.get(result.id);
      if (existing) {
        // Retranslation: update in place; a failed/empty result is ignored so it
        // never erases a good archived target (#139). The next brief rewrite
        // persists a real change.
        if (applyRetranslation(existing, result.text)) rewroteExisting = true;
        continue;
      }
      const meta = this.metaById.get(result.id);
      const entry: CaptionEntry = {
        speaker: meta?.channel === "me" ? "me" : "them",
        timestamp: clockLabel(meta?.epochMs ?? Date.now()),
        source: result.source !== "" ? result.source : (meta?.text ?? ""),
        target: result.text,
        pinned: this.pendingPins.has(result.id),
        lowConfidence: meta?.lowConfidence ?? false,
      };
      try {
        writer.appendCaption(entry);
        this.entriesById.set(result.id, entry);
      } catch (error) {
        this.emit({ type: "status", detail: `archive write failed (${errorDetail(error)})` });
      }
    }
    if (rewroteExisting) this.persistBrief();
  }

  private onPin(id: number, pinned: boolean): void {
    if (pinned) this.pendingPins.add(id);
    else this.pendingPins.delete(id);
    const entry = this.entriesById.get(id);
    if (entry) {
      entry.pinned = pinned;
      this.persistBrief();
    }
  }

  private onRetranslate(id: number): void {
    const meta = this.metaById.get(id);
    if (!meta || !this.runner || this.stopping) return;
    // User "fix this line" gesture: jump the live queue, dedup against any
    // still-pending original, and keep the result out of live context (#139).
    this.runner.retranslate({ id, text: meta.text });
  }

  private async onQuickTranslate(id: number, text: string): Promise<void> {
    if (!this.extras) return;
    try {
      const result = await this.extras.quickTranslate(text);
      this.emit({ type: "quickTranslateResult", id, text: result.text });
      this.emitGauge(); // extras spend changed → refresh the gauge
    } catch (error) {
      this.emit({ type: "extrasFailed", id, detail: errorDetail(error) });
    }
  }

  private async onReply(id: number, intent: ReplyIntent): Promise<void> {
    if (!this.extras) return;
    try {
      const result = await this.extras.suggestReply(intent, this.transcriptLines.slice(-10));
      this.emit({ type: "replyResult", id, intent, text: result.text });
      this.emitGauge(); // extras spend changed → refresh the gauge
    } catch (error) {
      this.emit({ type: "extrasFailed", id, detail: errorDetail(error) });
    }
  }

  /** Targeted analysis of ONE caption block (#80). Resolves the clicked
   *  caption's text via `metaById` and asks the engine for a strategy read + a
   *  suggested reply, using the recent transcript as context. On-demand only;
   *  cost flows through the gauge like the other extras. */
  private async onAnalyze(cardId: number, captionId: number): Promise<void> {
    if (!this.extras) return;
    const meta = this.metaById.get(captionId);
    if (!meta) {
      // The clicked caption aged out of the host's map — surface it on the card.
      this.emit({ type: "extrasFailed", id: cardId, detail: "caption no longer available" });
      return;
    }
    try {
      const result = await this.extras.analyzeAndRespond(
        meta.text,
        this.transcriptLines.slice(-ANALYZE_CONTEXT_LINES),
      );
      this.emit({ type: "analysis", cardId, analysis: result.analysis, reply: result.reply });
      this.emitGauge(); // extras spend changed → refresh the gauge
    } catch (error) {
      this.emit({ type: "extrasFailed", id: cardId, detail: errorDetail(error) });
    }
  }

  /** Speech coaching for a batch of the user's own (mic) utterances (#82).
   *  Resolves each id's text via `metaById` and runs the engine's batch coach;
   *  ids that aged out are skipped. On-demand only; cost flows through the gauge. */
  private async onCoach(cardId: number, captionIds: number[]): Promise<void> {
    if (!this.extras) return;
    const resolved = captionIds
      .map((id) => ({ id, meta: this.metaById.get(id) }))
      .filter((entry): entry is { id: number; meta: CaptionMeta } => entry.meta !== undefined);
    if (resolved.length === 0) {
      this.emit({ type: "extrasFailed", id: cardId, detail: "utterances no longer available" });
      return;
    }
    try {
      const results = await this.extras.coachUtterances(resolved.map((entry) => entry.meta.text));
      const items = results.map((result, index) => ({
        id: resolved[index].id,
        better: result.better,
        changes: result.changes,
        explanation: result.explanation,
      }));
      // Persist into the finalized session file (#114) BEFORE emitting, so the
      // result message can carry the save outcome; a failure never blocks the
      // rewrites from rendering (the card shows a one-line status instead).
      if (await this.persistCoaching(items)) {
        this.emit({ type: "coaching", cardId, items });
      } else {
        this.emit({ type: "coaching", cardId, items, persistFailed: true });
      }
      this.emitGauge(); // extras spend changed → refresh the gauge
    } catch (error) {
      this.emit({ type: "extrasFailed", id: cardId, detail: errorDetail(error) });
    }
  }

  /** Save coaching results into the finalized session file via the #113 amend
   *  API. Single attempt, best-effort: returns false on failure so the caller
   *  can flag it on the wire. No writer (auto-save off) or no coached item that
   *  maps to an archived `me` entry means nothing to save → success. Re-coached
   *  utterances overwrite their persisted entry (amendCoaching last-write-wins). */
  private async persistCoaching(items: CoachingItemWire[]): Promise<boolean> {
    const writer = this.writer;
    if (!writer) return true;
    // `entriesById` insertion order IS the archived entry order (each id is set
    // right after its successful appendCaption), so the occurrence indices match
    // the ones the writer computes when it renders the Coaching section.
    const keys = coachingAmendKeys(
      Array.from(this.entriesById, ([id, entry]) => ({
        id,
        speaker: entry.speaker,
        timestamp: entry.timestamp,
      })),
      items.map((item) => item.id),
    );
    const updates = items.flatMap((item) => {
      const key = keys.get(item.id);
      if (!key) return [];
      return [
        {
          timestamp: key.timestamp,
          occurrence: key.occurrence,
          coaching: { better: item.better, changes: item.changes, explanation: item.explanation },
        },
      ];
    });
    if (updates.length === 0) return true;
    try {
      await writer.amendCoaching(updates);
      return true;
    } catch (error) {
      // Content-free by contract (#23): errorDetail never carries caption or
      // rewrite text — only the error class/message from the fs layer.
      this.emit({ type: "status", detail: `coaching save failed (${errorDetail(error)})` });
      return false;
    }
  }

  /** Build the FinalizedRecord[] the post-meeting metrics consume (#81/#78)
   *  from the per-id meta accumulated over the session. */
  private finalizedRecords(): FinalizedRecord[] {
    return toFinalizedRecords(this.metaById.values());
  }

  private async summaryTick(): Promise<void> {
    if (!this.extras || this.summaryRunning || this.stopping) return;
    // Per-session cap reached (#55): stand the auto-summary loop down (surfacing
    // it once) so we stop polling the model for the rest of the session.
    if (this.extrasBudget && !this.extrasBudget.canSpend()) {
      this.noteExtrasBudgetReached();
      return;
    }
    const now = Date.now();
    const lines = this.transcriptLines;
    const lineCountAtRun = lines.length;
    const fullTranscript = lines.join("\n");
    // The cadence sees the FULL transcript so its unchanged-detection / idle
    // backoff still works; only the engine payload is the incremental delta.
    if (!this.cadence.shouldRun(now, fullTranscript)) return;
    this.summaryRunning = true;
    try {
      // Incremental after the first summary (#55): send only the new lines since
      // the last summary plus the previous summary/board, not the whole growing
      // transcript. The first run (no previous) summarizes in full.
      const previous = this.lastSummary
        ? { summary: this.lastSummary.summary, board: this.lastSummary.board }
        : null;
      const payload = previous
        ? lines.slice(this.summarizedLineCount, lineCountAtRun).join("\n")
        : fullTranscript;
      const result = await this.extras.generateSummaryBoard(payload, { previous });
      this.cadence.markRun(now, fullTranscript);
      // Captions that arrived during the await belong to the NEXT delta.
      this.summarizedLineCount = lineCountAtRun;
      this.lastSummary = { summary: result.summary, board: result.board };
      this.emit({ type: "summary", summary: result.summary, board: result.board });
      this.emitGauge(); // extras spend changed → refresh the gauge
      this.persistBrief();
    } catch (error) {
      if (error instanceof ExtrasBudgetExceededError) {
        this.noteExtrasBudgetReached();
      } else {
        this.emit({ type: "status", detail: `summary failed (${errorDetail(error)})` });
      }
    } finally {
      this.summaryRunning = false;
    }
  }

  /** Surface the per-session extras cap exactly once (#55). */
  private noteExtrasBudgetReached(): void {
    if (this.extrasBudgetNoticeSent) return;
    this.extrasBudgetNoticeSent = true;
    this.emit({ type: "status", detail: "extras budget reached — pausing auto-summary for this session" });
  }

  /** Promote any STALE orphaned `(recording).md` to a titled archive (#69).
   *  Run once at start and then periodically; only files idle past the staleness
   *  window are touched, so a live session's heartbeated file is never adopted. */
  private runAdoptionPass(): void {
    const adoption = adoptOrphanRecordings({
      fs: nodeArchiveFs(),
      folder: this.archiveDir,
      nowMs: Date.now(),
      staleAfterMs: RECORDING_STALE_AFTER_MS,
    });
    for (const { to } of adoption.adopted) {
      this.emit({ type: "status", detail: `adopted a recovered recording: ${to}` });
    }
    for (const name of adoption.failed) {
      this.emit({ type: "status", detail: `could not adopt a recovered recording (${name})` });
    }
  }

  /** Rewrite the archive's front sections from current session state. */
  private persistBrief(): void {
    const writer = this.writer;
    if (!writer) return;
    const now = Date.now();
    try {
      writer.updateBrief({
        summary: this.lastSummary?.summary,
        board: this.lastSummary?.board,
        endClock: clockLabel(now),
        durationMin: Math.round((now - this.startedAtMs) / 60_000),
        costUsd: this.sessionCostUsd,
      });
    } catch (error) {
      this.emit({ type: "status", detail: `archive write failed (${errorDetail(error)})` });
    }
  }

  private async stop(): Promise<void> {
    if (this.stopping || !this.started) return;
    this.stopping = true;
    for (const handle of this.intervals.splice(0)) clearInterval(handle);

    // Let the backlog finish (bounded) so the archive's last lines carry
    // translations; sources are already durable either way.
    if (this.runner) {
      await Promise.race([
        this.runner.drain(),
        new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
      ]);
    }

    // Final summary → archive title (PROPOSAL §8.9: title = first summary line).
    // Incremental like the live ticks (#55): fold only the tail since the last
    // summary into the previous one rather than re-summarizing the whole
    // transcript. Skipped silently if the per-session extras cap is reached.
    const lines = this.transcriptLines;
    const transcript = lines.join("\n");
    let finalSummary = this.lastSummary;
    if (this.extras && transcript !== "" && (!this.extrasBudget || this.extrasBudget.canSpend())) {
      try {
        const previous = this.lastSummary
          ? { summary: this.lastSummary.summary, board: this.lastSummary.board }
          : null;
        const tail = lines.slice(this.summarizedLineCount).join("\n");
        // Nothing new since the last summary → the last one is already final.
        if (!previous || tail !== "") {
          const result = await this.extras.generateSummaryBoard(previous ? tail : transcript, {
            previous,
          });
          finalSummary = { summary: result.summary, board: result.board };
        }
      } catch {
        // Keep the last good summary; the archive still finalizes.
      }
    }

    // Post-meeting metrics (#81/#78): talk-time ratio + Smooth Score from the
    // per-id meta accumulated this session. Computed once, emitted on the wire
    // for the review screen and persisted into the archive.
    const metrics: MeetingMetrics = computeMeetingMetrics(this.finalizedRecords());
    this.emit({
      type: "metrics",
      talkRatioMic: metrics.talkTime.micShare,
      smoothScore: metrics.smoothScore,
      micMs: metrics.talkTime.micMs,
      systemMs: metrics.talkTime.systemMs,
    });
    const archiveMetrics: MetricsData = {
      talkRatioMic: metrics.talkTime.micShare,
      smoothScore: metrics.smoothScore,
    };

    const now = Date.now();
    if (this.writer) {
      try {
        const path = this.writer.finalize({
          title: finalSummary?.summary[0] ?? "",
          summary: finalSummary?.summary ?? [],
          board: finalSummary?.board ?? { decisions: [], actionItems: [], openQuestions: [] },
          metrics: archiveMetrics,
          endClock: clockLabel(now),
          durationMin: Math.round((now - this.startedAtMs) / 60_000),
          costUsd: this.sessionCostUsd,
        });
        this.emit({ type: "archived", path });
      } catch (error) {
        this.emit({ type: "status", detail: `archive finalize failed (${errorDetail(error)})` });
      }
    }

    this.accountant?.recordMeetingTime(now - this.startedAtMs);

    // NOTE (#82): the engine is intentionally NOT stopped here. The post-meeting
    // review screen (which opens AFTER this `stopped` event) has a Coaching tab
    // that round-trips through the live engine; tearing it down on stop is what
    // made coaching hang forever (the host process used to exit, too). The engine
    // is reaped instead on process teardown — `dispose()` (signal/exit) or when
    // the Rust shell closes stdin and a fresh session starts. Captures and the
    // pipeline are already gone (Rust side); only the cheap engine handle lingers.
    // `stopping` stays latched (a second stop is a no-op); post-meeting `onCoach`
    // doesn't gate on it, so coaching still runs after the session ends.
    this.emit({ type: "stopped" });
  }

  /**
   * Synchronous, best-effort teardown for process termination (#66). The
   * graceful {@link stop} can stall (a wedged drain/summary, or a half-built
   * start), so the host's signal/exit handlers call this to force-kill the
   * spawned llama-server before the process dies — guaranteeing it is never
   * orphaned. Idempotent and safe before/after start.
   */
  dispose(): void {
    this.stopping = true;
    for (const handle of this.intervals.splice(0)) clearInterval(handle);
    // Reap the engines here (#82): since `stop()` now keeps them warm for
    // post-meeting coaching, teardown is the one place they are torn down. Both
    // lanes are reaped (#142) — the two routers force-kill their CLI children and
    // the shared local llama-server child. `dispose()` is the synchronous
    // force-kill; `stop()` SIGTERMs and awaits it (best-effort, fire-and-forget).
    for (const engine of this.startedEngines) {
      engine.dispose?.();
      void engine.stop().catch(() => undefined);
    }
  }
}
