// Session dashboard (#90): browse past sessions saved in the archive folder.
// Rendered as an opaque overlay INSIDE the Panel window (mirrors the settings
// sheet, #12 / #96) — no separate window. Two views:
//
//   • Overview — stats (total sessions, total captioned time, talk-ratio +
//     Smooth-Score trends, total cost) over every saved session, plus the
//     session history list (date · title · duration · languages). Click a row
//     to open its detail.
//   • Detail — one session's full transcript (original + translation), the
//     post-meeting review (summary / board + talk-ratio + Smooth Score), and
//     coaching (the user's own "Me" utterances; entries whose rewrites were
//     persisted by the review tab (#113/#114) render before → better with the
//     changed spans highlighted + the explanation, others stay before-only).
//
// The data layer is REUSED from @livecap/archive (#98): `parseSession` parses a
// saved Markdown file back to structure; `aggregateSessions` rolls the parsed
// sessions into the overview stats. This module is DOM-only and never logs
// caption content (SECURITY.md / EPIC #1) — text flows into DOM nodes only.

import { invoke } from "@tauri-apps/api/core";
// Import the #98 data layer DIRECTLY from its source modules rather than the
// package barrel: `parse`/`dashboard` are pure (they only touch `./types`), so
// the webview never pulls the package's Node-only `fs` writer into the bundle.
import { aggregateSessions, type DashboardStats } from "@livecap/archive/src/dashboard.ts";
import { parseSession, type ParsedSession } from "@livecap/archive/src/parse.ts";
import type { SessionIndexEntry } from "@livecap/archive/src/dashboard.ts";
import type { CaptionEntry } from "@livecap/archive/src/types.ts";

// The review tab's change-highlighting (#82), reused verbatim so persisted
// rewrites look the same here as they did when generated (#114).
import { renderBetter } from "./review";

/** One saved session as handed over by the Rust `list_archived_sessions`
 *  command: a file name + the raw Markdown to parse. */
export interface ArchivedSession {
  name: string;
  markdown: string;
}

/** A parsed session paired with the dashboard index entry derived from it, so a
 *  history row can map straight back to the full {@link ParsedSession} on click.
 *  The index order (chronological, from `aggregateSessions`) is authoritative. */
export interface DashboardModel {
  stats: DashboardStats;
  /** Parsed sessions keyed by the same identity used in the index, newest first
   *  (the reverse of the chronological index). Excludes the in-progress
   *  recording so the dashboard only shows finished sessions. */
  sessions: ParsedSession[];
}

const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
const BACK_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M7 2.5 3.5 6 7 9.5"/></svg>';

/**
 * Build the dashboard model from the raw archived sessions (pure, testable):
 * parse each file, drop the in-progress recording, aggregate the rest into
 * stats, and keep the parsed sessions newest-first to back the history list.
 */
export function buildDashboardModel(archived: readonly ArchivedSession[]): DashboardModel {
  const parsed = archived.map((a) => parseSession(a.markdown)).filter((s) => !s.isRecording);
  const stats = aggregateSessions(parsed);
  // `stats.index` is chronological (oldest first); the history list shows newest
  // first. Sort the parsed sessions the same way the aggregator orders the index
  // so a row's position maps to the same session.
  const sessions = [...parsed].sort((a, b) => compareChronological(b, a));
  return { stats, sessions };
}

/** Same ordering key the aggregator uses (date, then start clock). */
function compareChronological(a: ParsedSession, b: ParsedSession): number {
  if (a.meta.headerDate !== b.meta.headerDate) {
    return a.meta.headerDate < b.meta.headerDate ? -1 : 1;
  }
  if (a.meta.startClock !== b.meta.startClock) {
    return a.meta.startClock < b.meta.startClock ? -1 : 1;
  }
  return 0;
}

/** Whole minutes → a compact "Hh Mm" / "Mm" label. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total === 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${String(m)}m`;
  if (m === 0) return `${String(h)}h`;
  return `${String(h)}h ${String(m)}m`;
}

/** Cost in USD → "$X.XX", or "—" when nothing was recorded. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "—";
  return `$${usd.toFixed(2)}`;
}

/** A fraction in [0,1] → a whole-percent label, or "—" when absent. */
function formatRatio(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  return `${String(Math.round(fraction * 100))}%`;
}

/** A "date · title · duration · languages" subtitle for a history row. */
function rowMeta(entry: SessionIndexEntry): string {
  const parts: string[] = [];
  const when = [entry.date, entry.startClock].filter((s) => s !== "").join(" ");
  if (when !== "") parts.push(when);
  parts.push(formatDuration(entry.durationMin));
  const langs = [entry.sourceLang, entry.targetLang].filter((s) => s !== "").join(" → ");
  if (langs !== "") parts.push(langs);
  return parts.join(" · ");
}

export interface DashboardSurface {
  /** The root element to mount in the Panel. */
  readonly el: HTMLElement;
  /** Open the dashboard (loads the saved sessions) and show the overview. */
  open: () => void;
  /** Hide the dashboard. */
  close: () => void;
  isOpen: () => boolean;
}

export interface DashboardCallbacks {
  /** Load the saved sessions from disk (the Rust `list_archived_sessions`). */
  load: () => Promise<ArchivedSession[]>;
  /** Close the dashboard (back to the previous view). */
  onClose: () => void;
}

/** Default loader: the Rust command that lists + reads the archive folder. */
export function loadArchivedSessions(): Promise<ArchivedSession[]> {
  return invoke<ArchivedSession[]>("list_archived_sessions");
}

export function buildDashboard(callbacks: DashboardCallbacks): DashboardSurface {
  const root = document.createElement("div");
  root.id = "dashboard";
  root.innerHTML = `
    <div class="dash-head">
      <button class="dash-back" id="dash-back" title="Back" aria-label="Back" hidden>${BACK_ICON}</button>
      <span class="dash-title" id="dash-title">DASHBOARD</span>
      <button class="dash-close" id="dash-close" title="Close" aria-label="Close dashboard">${CLOSE_ICON}</button>
    </div>
    <div class="dash-body" id="dash-body"></div>
  `;

  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const backBtn = $<HTMLButtonElement>("#dash-back");
  const titleEl = $<HTMLSpanElement>("#dash-title");
  const bodyEl = $<HTMLDivElement>("#dash-body");

  let model: DashboardModel | null = null;

  backBtn.addEventListener("click", () => showOverview());
  $<HTMLButtonElement>("#dash-close").addEventListener("click", () => callbacks.onClose());

  function setHead(title: string, showBack: boolean): void {
    titleEl.textContent = title;
    backBtn.hidden = !showBack;
  }

  function showLoading(): void {
    setHead("DASHBOARD", false);
    bodyEl.replaceChildren(meta("Loading saved sessions…"));
  }

  function showError(detail: string): void {
    setHead("DASHBOARD", false);
    bodyEl.replaceChildren(meta(`Could not read the archive (${detail})`));
  }

  function showOverview(): void {
    setHead("DASHBOARD", false);
    bodyEl.replaceChildren();
    bodyEl.scrollTop = 0;
    if (model === null) {
      bodyEl.appendChild(meta("Loading saved sessions…"));
      return;
    }
    if (model.sessions.length === 0) {
      bodyEl.appendChild(renderEmpty());
      return;
    }
    bodyEl.appendChild(renderStats(model.stats));
    bodyEl.appendChild(renderHistory(model));
  }

  function showDetail(session: ParsedSession): void {
    const title = session.meta.title !== "" ? session.meta.title : "Session";
    setHead(title, true);
    bodyEl.replaceChildren(renderDetail(session));
    bodyEl.scrollTop = 0;
  }

  function renderEmpty(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "dash-empty";
    const h = document.createElement("div");
    h.className = "dash-empty-h";
    h.textContent = "No sessions yet";
    const p = document.createElement("div");
    p.className = "dash-empty-p t-meta";
    p.textContent = "Saved transcripts will appear here after you finish a captioning session.";
    wrap.append(h, p);
    return wrap;
  }

  function renderStats(stats: DashboardStats): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "dash-stats";
    const cards: [string, string][] = [
      ["Sessions", String(stats.completedSessions)],
      ["Captioned time", formatDuration(stats.totalDurationMin)],
      ["Avg talk ratio", formatRatio(stats.averageTalkRatioMic)],
      ["Avg Smooth Score", stats.averageSmoothScore === null ? "—" : String(Math.round(stats.averageSmoothScore))],
      ["Total cost", formatCost(stats.totalCostUsd)],
    ];
    for (const [label, value] of cards) {
      const card = document.createElement("div");
      card.className = "dash-stat";
      const v = document.createElement("div");
      v.className = "dash-stat-value";
      v.textContent = value;
      const l = document.createElement("div");
      l.className = "dash-stat-label t-meta";
      l.textContent = label;
      card.append(v, l);
      wrap.appendChild(card);
    }
    return wrap;
  }

  function renderHistory(m: DashboardModel): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "dash-history";
    const h = document.createElement("h3");
    h.className = "dash-h";
    h.textContent = "History";
    wrap.appendChild(h);

    // `m.sessions` is newest-first; the chronological index is oldest-first, so
    // walk it in reverse to pair each row with its session.
    const index = m.stats.index;
    for (let i = 0; i < m.sessions.length; i++) {
      const session = m.sessions[i];
      if (session === undefined) continue;
      const entry = index[index.length - 1 - i];
      const row = document.createElement("button");
      row.className = "dash-row";
      row.type = "button";
      const titleSpan = document.createElement("span");
      titleSpan.className = "dash-row-title";
      titleSpan.textContent = session.meta.title !== "" ? session.meta.title : "Session";
      const metaSpan = document.createElement("span");
      metaSpan.className = "dash-row-meta t-meta";
      metaSpan.textContent = entry ? rowMeta(entry) : "";
      row.append(titleSpan, metaSpan);
      row.addEventListener("click", () => showDetail(session));
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderDetail(session: ParsedSession): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "dash-detail";

    // Meta line.
    const metaLine = [
      [session.meta.headerDate, session.meta.startClock].filter((s) => s !== "").join(" "),
      formatDuration(session.meta.durationMin),
      [session.meta.sourceLang, session.meta.targetLang].filter((s) => s !== "").join(" → "),
      session.meta.engineName !== "" ? `${session.meta.engineName} (${formatCost(session.meta.costUsd)})` : "",
      session.meta.channels ?? "",
    ]
      .filter((s) => s !== "")
      .join(" · ");
    if (metaLine !== "") wrap.appendChild(meta(metaLine, "dash-detail-meta"));

    // Review: metrics + summary + board.
    if (session.metrics) {
      const metrics = document.createElement("div");
      metrics.className = "dash-metrics";
      metrics.appendChild(metric(formatRatio(session.metrics.talkRatioMic), "Talk ratio (me)"));
      metrics.appendChild(metric(String(session.metrics.smoothScore), "Smooth Score"));
      wrap.appendChild(metrics);
      const bar = document.createElement("div");
      bar.className = "talk-bar";
      const fill = document.createElement("div");
      fill.className = "talk-bar-mic";
      fill.style.width = `${String(Math.round(session.metrics.talkRatioMic * 100))}%`;
      bar.appendChild(fill);
      wrap.appendChild(bar);
    }

    wrap.appendChild(sectionHeading("Summary"));
    if (session.summary.length === 0) {
      wrap.appendChild(meta("No summary was generated."));
    } else {
      const ul = document.createElement("ul");
      ul.className = "dash-summary";
      for (const line of session.summary) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    wrap.appendChild(sectionHeading("Board"));
    wrap.appendChild(renderBoard(session));

    // Coaching: the user's own utterances. Entries whose rewrite was persisted
    // by the review tab (#113/#114) render before → better with the review
    // tab's own visual language; the rest keep the before-only row.
    const mine = session.entries.filter((e) => e.speaker === "me");
    wrap.appendChild(sectionHeading("Coaching"));
    if (mine.length === 0) {
      wrap.appendChild(meta("You didn't speak in this session."));
    } else {
      wrap.appendChild(meta(`${String(mine.length)} of your utterances`));
      const list = document.createElement("div");
      list.className = "dash-coach-list";
      for (const e of mine) {
        list.appendChild(e.coaching ? renderCoachedEntry(e, e.coaching) : renderBeforeOnlyEntry(e));
      }
      wrap.appendChild(list);
    }

    // Full transcript (original + translation), every speaker.
    wrap.appendChild(sectionHeading("Transcript"));
    if (session.entries.length === 0) {
      wrap.appendChild(meta("No transcript was recorded."));
    } else {
      const tx = document.createElement("div");
      tx.className = "dash-transcript";
      for (const e of session.entries) {
        const block = document.createElement("div");
        block.className = `dash-line ${e.speaker === "me" ? "me" : "them"}`;
        const headRow = document.createElement("div");
        headRow.className = "dash-line-head";
        const who = document.createElement("span");
        who.className = "dash-line-who";
        who.textContent = e.speaker === "me" ? "Me" : "Them";
        const tEl = document.createElement("span");
        tEl.className = "dash-line-time t-meta";
        tEl.textContent = e.timestamp;
        headRow.append(who, tEl);
        const src = document.createElement("div");
        src.className = "dash-line-src";
        src.textContent = e.lowConfidence ? `${e.source} (?)` : e.source;
        block.append(headRow, src);
        if (e.target !== "") {
          const tr = document.createElement("div");
          tr.className = "dash-line-tr";
          tr.textContent = e.target;
          block.appendChild(tr);
        }
        tx.appendChild(block);
      }
      wrap.appendChild(tx);
    }

    return wrap;
  }

  function renderBoard(session: ParsedSession): HTMLElement {
    const boardEl = document.createElement("div");
    boardEl.className = "dash-board";
    const sections: [string, string[]][] = [
      ["Decisions", session.board.decisions],
      ["Action items", session.board.actionItems],
      ["Open questions", session.board.openQuestions],
    ];
    for (const [label, items] of sections) {
      if (items.length === 0) continue;
      const rowEl = document.createElement("div");
      rowEl.className = "board-row";
      const head = document.createElement("span");
      head.className = "board-head";
      head.textContent = label;
      rowEl.appendChild(head);
      const ul = document.createElement("ul");
      for (const item of items) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      rowEl.appendChild(ul);
      boardEl.appendChild(rowEl);
    }
    if (boardEl.childElementCount === 0) boardEl.textContent = "—";
    return boardEl;
  }

  /** A "me" utterance without a persisted rewrite: today's before-only row. */
  function renderBeforeOnlyEntry(e: CaptionEntry): HTMLElement {
    const item = document.createElement("div");
    item.className = "dash-coach-row";
    const time = document.createElement("span");
    time.className = "dash-coach-time t-meta";
    time.textContent = e.timestamp;
    const text = document.createElement("span");
    text.className = "dash-coach-text";
    text.textContent = e.source;
    item.append(time, text);
    return item;
  }

  /** A "me" utterance with a persisted rewrite (#114): the review tab's
   *  coach-item — before (struck through) → better (changes highlighted via
   *  the shared renderBetter) → explanation. Text flows into DOM nodes only. */
  function renderCoachedEntry(e: CaptionEntry, coaching: NonNullable<CaptionEntry["coaching"]>): HTMLElement {
    const item = document.createElement("div");
    item.className = "coach-item";
    const before = document.createElement("div");
    before.className = "coach-before t-meta";
    before.textContent = e.source;
    const betterRow = document.createElement("div");
    betterRow.className = "coach-better-row";
    const better = document.createElement("div");
    better.className = "coach-better";
    renderBetter(better, coaching.better, coaching.changes);
    betterRow.appendChild(better);
    item.append(before, betterRow);
    if (coaching.explanation !== "") {
      const explain = document.createElement("div");
      explain.className = "coach-explain t-meta";
      explain.textContent = coaching.explanation;
      item.appendChild(explain);
    }
    return item;
  }

  function sectionHeading(text: string): HTMLElement {
    const h = document.createElement("h3");
    h.className = "dash-h";
    h.textContent = text;
    return h;
  }

  function metric(value: string, label: string): HTMLElement {
    const m = document.createElement("div");
    m.className = "metric";
    const v = document.createElement("div");
    v.className = "metric-value";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "metric-label t-meta";
    l.textContent = label;
    m.append(v, l);
    return m;
  }

  function meta(text: string, cls = ""): HTMLElement {
    const d = document.createElement("div");
    d.className = cls !== "" ? `dash-note t-meta ${cls}` : "dash-note t-meta";
    d.textContent = text;
    return d;
  }

  function open(): void {
    root.classList.add("open");
    showLoading();
    callbacks.load().then(
      (archived) => {
        model = buildDashboardModel(archived);
        if (root.classList.contains("open")) showOverview();
      },
      (error: unknown) => {
        if (root.classList.contains("open")) showError(String(error));
      },
    );
  }

  function close(): void {
    root.classList.remove("open");
  }

  return {
    el: root,
    open,
    close,
    isOpen: () => root.classList.contains("open"),
  };
}
