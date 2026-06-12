// The per-meeting session host (#11): wires the engine tiers (#5/#6) behind
// the loss-free FallbackRouter (#7), the credit accountant (#7), the extras
// pipeline (#9), and the crash-safe archive writer (#8) to the JSONL protocol
// the Rust shell speaks (src/protocol.ts). One process per session; stdout is
// the event stream, stderr stays content-free.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  ClaudeCliEngine,
  CreditAccountant,
  ExtrasPipeline,
  FallbackRouter,
  nodeLedgerFs,
  SummaryCadence,
} from "@livecap/engine";
import type { ReplyIntent, TranslationEngine, Usage } from "@livecap/engine";
import { nodeArchiveFs, SessionArchiveWriter, sweepOldArchives } from "@livecap/archive";
import type { BoardData, CaptionEntry } from "@livecap/archive";

import type { Channel, HostInbound, HostOutbound } from "../protocol.ts";
import { detectClaudeCli } from "./detect-cli.ts";
import { LazyLocalEngine } from "./local-tier.ts";
import { SILENCE_THRESHOLD_MS, SilenceWatchdog } from "./silence.ts";
import { resolveStartConfig } from "./start-config.ts";
import { TranslationRunner } from "./translation-runner.ts";

const CLI_ENGINE_LABEL = "Claude CLI";
const LOCAL_ENGINE_LABEL = "Local (Qwen3 4B)";
const SUMMARY_TICK_MS = 5_000;
const WATCHDOG_TICK_MS = 15_000;
const DRAIN_TIMEOUT_MS = 20_000;

type StartConfig = Extract<HostInbound, { type: "start" }>;

interface CaptionMeta {
  channel: Channel;
  text: string;
  lowConfidence: boolean;
  epochMs: number;
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

export class HostSession {
  private engine: TranslationEngine | null = null;
  private router: FallbackRouter | null = null;
  private accountant: CreditAccountant | null = null;
  private extras: ExtrasPipeline | null = null;
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
  private lastSummary: { summary: string[]; board: BoardData } | null = null;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private stopping = false;
  private started = false;

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
    if (cli) {
      const cwd = join(config.appDataDir, "cli-session");
      mkdirSync(cwd, { recursive: true });
      const primary = new ClaudeCliEngine({
        bin: cli.bin,
        cwd,
        env: process.env,
        includePartialMessages: cli.includePartialMessages,
        targetLanguage: resolved.targetLanguage,
      });
      this.router = new FallbackRouter({
        primary,
        fallback: local,
        startOnFallback: () => resolved.autoSwitch && accountant.isBelowThreshold(),
      });
      this.engine = this.router;
      engineLabel = CLI_ENGINE_LABEL;
    } else {
      if (resolved.enginePref === "cli") {
        this.emit({ type: "status", detail: "no Claude CLI found — using the local model" });
      }
      this.engine = local;
      engineLabel = LOCAL_ENGINE_LABEL;
    }
    const engine = this.engine;

    accountant.attach(engine);
    engine.onUsage((usage: Usage) => {
      this.sessionCostUsd += usage.turnCostUsd;
    });
    accountant.onEvent((event) => {
      if (event.type === "gauge") {
        this.emit({ type: "gauge", gauge: event.gauge });
      } else if (event.type === "engine-switch") {
        // §8.7 auto-switch toggle: when off, the gauge still updates but the
        // session stays on the CLI tier.
        if (resolved.autoSwitch) this.switchToLocal();
      } else {
        this.emit({ type: "status", detail: "credit ledger write failed — accounting paused" });
      }
    });

    this.emit({ type: "status", detail: "starting translation engine…" });
    await engine.start();
    if (this.router?.onFallback) {
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
        },
      });
      writer.open();
      this.writer = writer;
    }

    this.extras = new ExtrasPipeline({
      engine,
      summaryLanguage: resolved.summaryLanguage,
      meetingLanguage: resolved.meetingLanguage,
    });

    this.runner = new TranslationRunner({
      engine,
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

    this.emit({ type: "gauge", gauge: accountant.gauge() });
    this.emit({ type: "ready", engine: engineLabel });
  }

  private switchToLocal(): void {
    const router = this.router;
    if (!router || router.onFallback) return;
    void router
      .switchToFallback()
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
        // Retranslation: update in place; the next brief rewrite persists it.
        existing.target = result.text;
        rewroteExisting = true;
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
    this.runner.enqueue({ id, text: meta.text });
  }

  private async onQuickTranslate(id: number, text: string): Promise<void> {
    if (!this.extras) return;
    try {
      const result = await this.extras.quickTranslate(text);
      this.emit({ type: "quickTranslateResult", id, text: result.text });
    } catch (error) {
      this.emit({ type: "extrasFailed", id, detail: errorDetail(error) });
    }
  }

  private async onReply(id: number, intent: ReplyIntent): Promise<void> {
    if (!this.extras) return;
    try {
      const result = await this.extras.suggestReply(intent, this.transcriptLines.slice(-10));
      this.emit({ type: "replyResult", id, intent, text: result.text });
    } catch (error) {
      this.emit({ type: "extrasFailed", id, detail: errorDetail(error) });
    }
  }

  private async summaryTick(): Promise<void> {
    if (!this.extras || this.summaryRunning || this.stopping) return;
    const transcript = this.transcriptLines.join("\n");
    const now = Date.now();
    if (!this.cadence.shouldRun(now, transcript)) return;
    this.summaryRunning = true;
    try {
      const result = await this.extras.generateSummaryBoard(transcript);
      this.cadence.markRun(now, transcript);
      this.lastSummary = { summary: result.summary, board: result.board };
      this.emit({ type: "summary", summary: result.summary, board: result.board });
      this.persistBrief();
    } catch (error) {
      this.emit({ type: "status", detail: `summary failed (${errorDetail(error)})` });
    } finally {
      this.summaryRunning = false;
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
    const transcript = this.transcriptLines.join("\n");
    let finalSummary = this.lastSummary;
    if (this.extras && transcript !== "") {
      try {
        const result = await this.extras.generateSummaryBoard(transcript);
        finalSummary = { summary: result.summary, board: result.board };
      } catch {
        // Keep the last good summary; the archive still finalizes.
      }
    }

    const now = Date.now();
    if (this.writer) {
      try {
        const path = this.writer.finalize({
          title: finalSummary?.summary[0] ?? "",
          summary: finalSummary?.summary ?? [],
          board: finalSummary?.board ?? { decisions: [], actionItems: [], openQuestions: [] },
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

    try {
      await this.engine?.stop();
    } catch (error) {
      this.emit({ type: "status", detail: `engine stop failed (${errorDetail(error)})` });
    }
    this.emit({ type: "stopped" });
  }
}
