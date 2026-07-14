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
import { aggregateSessions, toSessionIndexEntry, type DashboardStats } from "@livecap/archive/src/dashboard.ts";
import { parseSession, type ParsedSession } from "@livecap/archive/src/parse.ts";
import type { SessionIndexEntry } from "@livecap/archive/src/dashboard.ts";
import type { CaptionEntry } from "@livecap/archive/src/types.ts";

// The review tab's change-highlighting (#82), reused verbatim so persisted
// rewrites look the same here as they did when generated (#114).
import { renderBetter } from "./review";

/** One saved session's FULL document as handed over by the Rust
 *  `list_archived_sessions` / `read_archived_session` commands: a file name +
 *  the raw Markdown to parse. Loaded lazily (detail open) or on demand (search),
 *  never eagerly for the whole archive (#144). */
export interface ArchivedSession {
  name: string;
  markdown: string;
}

/** One saved session's lightweight index row from the Rust `list_session_index`
 *  command (#144): a file name + only the document FRONT MATTER (up to
 *  `## Transcript`) — the H1 title, meta line, and Summary/Board/Metrics — which
 *  is all `parseSession` + `aggregateSessions` need for the history + stats. The
 *  transcript/coaching bodies are omitted so open time is bounded. */
export interface SessionHeader {
  name: string;
  markdown: string;
}

/** A header-parsed session paired with its file name so a history row can lazily
 *  load its full body on click (#144). The parse is FRONT-MATTER-ONLY: `.entries`
 *  is empty here — the transcript loads when the detail opens. */
export interface IndexedSession {
  /** File name, the key for the lazy full-body load (`read_archived_session`). */
  name: string;
  /** Front-matter parse: meta/summary/board/metrics populated, entries empty. */
  session: ParsedSession;
  /** The history-row index entry derived from THIS session (#170) — carried with
   *  the session so a row shows its own duration/langs/cost, never a tied
   *  session's (no positional pairing). */
  entry: SessionIndexEntry;
}

/** A parsed session paired with the dashboard index entry derived from it, so a
 *  history row can map straight back on click. The index order (chronological,
 *  from `aggregateSessions`) is authoritative. */
export interface DashboardModel {
  stats: DashboardStats;
  /** Header-parsed sessions (newest first, reverse of the chronological index),
   *  each carrying its file name for the lazy detail load. Excludes the
   *  in-progress recording so the dashboard only shows finished sessions. */
  sessions: IndexedSession[];
}

const CLOSE_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
const BACK_ICON =
  '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" aria-hidden="true"><path d="M7 2.5 3.5 6 7 9.5"/></svg>';

/**
 * Build the dashboard model from the lightweight session index (pure, testable):
 * parse each session's FRONT MATTER, drop the in-progress recording, aggregate
 * the rest into stats, and keep the header-parsed sessions newest-first — each
 * carrying its file name — to back the history list and the lazy detail load
 * (#144). Reuses the exact same `parseSession`/`aggregateSessions` as before; the
 * only difference is the input is front matter, not full bodies, so `.entries`
 * is empty (the transcript loads on click) while stats stay complete because
 * metrics live in the front matter.
 */
export function buildDashboardModel(index: readonly SessionHeader[]): DashboardModel {
  const parsed = index
    .map((h) => {
      const session = parseSession(h.markdown);
      // Derive each session's index entry HERE, alongside its file name (#170),
      // so a history row pairs with its OWN entry by identity — not by a fragile
      // positional reversal that swaps sessions tied on (date, startClock).
      return { name: h.name, session, entry: toSessionIndexEntry(session) };
    })
    .filter((p) => !p.session.isRecording);
  const stats = aggregateSessions(parsed.map((p) => p.session));
  // History shows newest-first; each session already carries its own entry.
  const sessions = [...parsed].sort((a, b) => compareChronological(b.session, a.session));
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

/** Result of {@link sessionMatches}: whether a session matches a search query,
 *  and a short snippet of the first field that matched (empty when no match). */
export interface SessionMatch {
  matched: boolean;
  snippet: string;
}

/** Max snippet length (~80 chars, counted in code points) shown under a row. */
const SNIPPET_MAX = 80;

/**
 * Whether `session` matches `query` — a case-insensitive substring of the
 * session title, any summary line, any board item (decisions / action items /
 * open questions), or any transcript entry's source/target (#131). Returns the
 * matched flag plus a snippet of the FIRST field that matched (in that field
 * order) so the UI can show WHY it matched.
 *
 * Pure and DOM-free — searches only the already-parsed, in-memory session, never
 * touches disk, and never logs (SECURITY.md / EPIC #1). An empty/whitespace-only
 * query is not a match here; the caller restores the full list for an empty box.
 */
export function sessionMatches(session: ParsedSession, query: string): SessionMatch {
  const q = query.trim().toLowerCase();
  if (q === "") return { matched: false, snippet: "" };

  const fields: string[] = [
    session.meta.title,
    ...session.summary,
    ...session.board.decisions,
    ...session.board.actionItems,
    ...session.board.openQuestions,
  ];
  for (const entry of session.entries) {
    fields.push(entry.source, entry.target);
  }

  for (const field of fields) {
    const at = field.toLowerCase().indexOf(q);
    if (at !== -1) return { matched: true, snippet: snippetAround(field, at, q.length) };
  }
  return { matched: false, snippet: "" };
}

/** A ~{@link SNIPPET_MAX}-char window of `text` centered on the match at
 *  `[at, at+len)`, with leading/trailing ellipses when truncated. Code-point
 *  aware, so a multibyte glyph (Hangul/emoji) is never split. */
function snippetAround(text: string, at: number, len: number): string {
  const cps = [...text];
  if (cps.length <= SNIPPET_MAX) return text;
  // `at` is a UTF-16 index; convert it to a code-point index.
  const cpAt = [...text.slice(0, at)].length;
  const context = Math.max(0, Math.floor((SNIPPET_MAX - len) / 2));
  let start = Math.max(0, cpAt - context);
  const end = Math.min(cps.length, start + SNIPPET_MAX);
  start = Math.max(0, end - SNIPPET_MAX); // pull the window back if it hit the end
  let out = cps.slice(start, end).join("");
  if (start > 0) out = `…${out}`;
  if (end < cps.length) out = `${out}…`;
  return out;
}

/** Tokenized inline styling for the History search box — the file already
 *  inline-styles nodes (e.g. the talk bar), and this uses design tokens only
 *  (no raw color literals; #116/#126 color-guard). */
function styleSearchInput(el: HTMLInputElement): void {
  el.style.width = "100%";
  el.style.boxSizing = "border-box"; // border stays inside → no layout shift
  el.style.padding = "8px 12px";
  // DESIGN-GUIDE §Inputs: a clear default border, accent border on focus.
  el.style.border = "1px solid var(--hairline)";
  el.style.outline = "none"; // replaced by the accent border below (not stripped)
  el.style.borderRadius = "9px";
  el.style.background = "var(--surface-2)";
  el.style.color = "var(--text-original)";
  el.style.fontFamily = "var(--font)";
  el.style.fontSize = "13px";
  el.style.transition = "border-color var(--fade) ease";
  el.addEventListener("focus", () => {
    el.style.borderColor = "var(--accent-live)";
  });
  el.addEventListener("blur", () => {
    el.style.borderColor = "var(--hairline)";
  });
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
  /** Load the lightweight session index for the overview + history list — front
   *  matter only, bounded regardless of archive size (Rust `list_session_index`). */
  loadIndex: () => Promise<SessionHeader[]>;
  /** Load ONE session's full Markdown by name, lazily when its detail opens
   *  (Rust `read_archived_session`). */
  loadSession: (name: string) => Promise<string>;
  /** Load every session's full body, on demand, to back the complete
   *  transcript-body search (#131) without regressing it (Rust
   *  `list_archived_sessions`). Called only when the user searches. */
  loadAll: () => Promise<ArchivedSession[]>;
  /** Close the dashboard (back to the previous view). */
  onClose: () => void;
}

/** Default loader: the Rust command returning the lightweight session index. */
export function loadSessionIndex(): Promise<SessionHeader[]> {
  return invoke<SessionHeader[]>("list_session_index");
}

/** Default loader: the Rust command returning ONE session's full Markdown. */
export function loadArchivedSession(name: string): Promise<string> {
  return invoke<string>("read_archived_session", { name });
}

/** Default loader: the Rust command returning every session's full body (search). */
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

  // Full parsed sessions by file name (#144): the shared cache backing BOTH the
  // lazy detail load and the on-demand full-text search. A detail open fills one
  // entry; the first search fills them all, so later clicks/searches are instant.
  const fullByName = new Map<string, ParsedSession>();
  let allBodiesLoaded = false;
  // Monotonic navigation tokens so a slow async load that resolves after the user
  // has moved on (another row, another query, or back to the overview) is dropped
  // instead of clobbering the view that is now on screen.
  let detailToken = 0;
  let searchToken = 0;

  /** Load + parse ONE session's full body, memoized by name. Null on read error. */
  async function loadFullSession(name: string): Promise<ParsedSession | null> {
    const cached = fullByName.get(name);
    if (cached !== undefined) return cached;
    try {
      const parsed = parseSession(await callbacks.loadSession(name));
      fullByName.set(name, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Load + parse EVERY finished session's full body once, for complete search
   *  (#131). Idempotent; the in-progress recording is excluded like the index. */
  async function ensureAllBodiesLoaded(): Promise<void> {
    if (allBodiesLoaded) return;
    const all = await callbacks.loadAll();
    for (const a of all) {
      const parsed = parseSession(a.markdown);
      if (!parsed.isRecording) fullByName.set(a.name, parsed);
    }
    allBodiesLoaded = true;
  }

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
    // Returning to the overview cancels any in-flight detail load (#144) so a
    // late-resolving transcript can't paint over the overview.
    detailToken += 1;
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

  /**
   * Open a session's detail, lazily fetching its full body the first time (#144).
   * The header parse (title known immediately) drives the head + a loading note
   * while the transcript loads; a cached full body renders synchronously. A stale
   * load (the user clicked another row or went back) is discarded via the token.
   */
  function openDetail(name: string, header: ParsedSession): void {
    detailToken += 1;
    const token = detailToken;
    const cached = fullByName.get(name);
    if (cached !== undefined) {
      showDetail(cached);
      return;
    }
    const title = header.meta.title !== "" ? header.meta.title : "Session";
    setHead(title, true);
    bodyEl.replaceChildren(meta("Loading session…"));
    bodyEl.scrollTop = 0;
    void loadFullSession(name).then((full) => {
      if (token !== detailToken || !root.classList.contains("open")) return;
      if (full !== null) showDetail(full);
      else bodyEl.replaceChildren(meta("Could not read this session."));
    });
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

    // Each session carries its OWN index entry (built alongside it in
    // buildDashboardModel, #170), so a row shows its own duration/langs/cost —
    // never a tied session's, as the old positional index reversal did. The name
    // backs the lazy detail load + search (#144).
    const pairs = m.sessions;

    // Search box (#131): case-insensitive substring over title/summary/board/
    // transcript, debounced. Title/summary/board are already in the header
    // parse, but transcript-body matching needs the full bodies, so a non-empty
    // query loads them on demand (#144) — the search stays COMPLETE across ALL
    // sessions, never regressing to loaded/title-only. The hint is an overlay
    // label that hides once text is typed — the same pattern #qt-input uses for
    // the composer (an input hint element, not an attribute).
    const searchWrap = document.createElement("div");
    searchWrap.className = "dash-search-wrap";
    searchWrap.style.position = "relative";
    searchWrap.style.marginBottom = "8px";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "dash-search";
    search.setAttribute("aria-label", "Search sessions");
    styleSearchInput(search);
    const hint = document.createElement("span");
    hint.className = "dash-search-hint t-meta";
    hint.textContent = "Search sessions…";
    hint.style.position = "absolute";
    hint.style.left = "12px";
    hint.style.top = "50%";
    hint.style.transform = "translateY(-50%)";
    hint.style.pointerEvents = "none";
    searchWrap.append(search, hint);
    wrap.appendChild(searchWrap);

    const rows = document.createElement("div");
    rows.className = "dash-rows";
    wrap.appendChild(rows);

    type Match = { name: string; session: ParsedSession; entry: SessionIndexEntry | undefined; snippet: string };

    const paintRows = (matches: Match[], q: string): void => {
      rows.replaceChildren();
      for (const m2 of matches) {
        rows.appendChild(historyRow(m2.session, m2.name, m2.entry, m2.snippet));
      }
      if (q !== "" && matches.length === 0) {
        rows.appendChild(meta(`No sessions match "${q}"`));
      }
    };

    const renderRows = (query: string): void => {
      const q = query.trim();
      // Every render supersedes any in-flight search load (staleness guard).
      searchToken += 1;
      const token = searchToken;

      if (q === "") {
        // No query: show every session, no bodies needed.
        paintRows(pairs.map((p) => ({ ...p, snippet: "" })), "");
        return;
      }

      // Complete transcript-body search: ensure every session's full body is
      // loaded, then run the SAME `sessionMatches` over the full parse — so the
      // #131 search never regresses to loaded/title-only (#144).
      if (!allBodiesLoaded) rows.replaceChildren(meta("Searching all sessions…"));
      void ensureAllBodiesLoaded().then(
        () => {
          if (token !== searchToken) return; // a newer query is in flight
          const matches: Match[] = [];
          for (const p of pairs) {
            // Full body when available; the header parse (title/summary/board,
            // no transcript) is only a fallback if a single load failed.
            const full = fullByName.get(p.name) ?? p.session;
            const result = sessionMatches(full, q);
            if (result.matched) matches.push({ ...p, snippet: result.snippet });
          }
          paintRows(matches, q);
        },
        () => {
          if (token !== searchToken) return;
          rows.replaceChildren(meta("Could not search sessions."));
        },
      );
    };

    // ~150ms debounce so filtering doesn't re-render on every keystroke. The
    // hint hides immediately (not debounced) as soon as there is text.
    let debounce = 0;
    search.addEventListener("input", () => {
      hint.hidden = search.value !== "";
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => renderRows(search.value), 150);
    });

    renderRows("");
    return wrap;
  }

  /** One History row: title + meta, plus an optional match snippet (#131). Click
   *  lazily loads the full session body before showing its detail (#144). */
  function historyRow(
    session: ParsedSession,
    name: string,
    entry: SessionIndexEntry | undefined,
    snippet: string,
  ): HTMLElement {
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
    if (snippet !== "") {
      const snip = document.createElement("span");
      snip.className = "dash-row-snippet t-meta";
      snip.textContent = snippet;
      row.appendChild(snip);
    }
    row.addEventListener("click", () => openDetail(name, session));
    return row;
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
    // Open loads only the lightweight index (front matter), so open time is
    // bounded regardless of archive size (#144). Bodies load lazily on click /
    // on search.
    callbacks.loadIndex().then(
      (index) => {
        model = buildDashboardModel(index);
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
