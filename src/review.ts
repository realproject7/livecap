// Post-meeting review surface (#81) + speech-coaching tab (#82). Rendered in the
// Panel when a session ends (same trigger as the archive finalize). Two tabs:
//
//   • 미팅 요약 / Review — the Summary + Board (already streamed via HostOutbound
//     "summary"), plus the talk-time ratio + Smooth Score (HostOutbound
//     "metrics", computed by #78). Read-only; no new generation.
//   • 표현 배우기 / Coaching — the session's OWN (mic-channel) utterances, listed
//     client-side from FeedState; selecting one (or "review all") calls the host
//     ("coach") which runs #79's batch coach. Each result shows the native
//     "Better" rewrite with the changed spans highlighted + an explanation, and
//     a 발음 듣기 play button (Web Speech API, voice by meeting language).
//
// This module is DOM-only and side-effect-light: it owns its surface element and
// exposes a small imperative API the orchestrator (src/main.ts) drives. The host
// round-trips stay in main.ts; this module only renders and raises callbacks.

import { CLOSE_ICON } from "./icons";
import type { BoardWire, CoachingItemWire } from "./protocol";

/** One of the user's own utterances, as listed in the coaching tab. */
export interface MicUtterance {
  /** Caption id (the host resolves its text by this). */
  id: number;
  /** Source text shown in the list (the "before"). */
  source: string;
  /** Clock label, e.g. "10:45". */
  time: string;
}

export interface ReviewCallbacks {
  /** User asked to coach a batch of utterance ids; returns the cardId to route
   *  the eventual "coaching" result back to (the orchestrator owns the host
   *  round-trip and the requestCounter id namespace). */
  requestCoaching: (ids: number[]) => number;
  /** Copy text to the clipboard (reuses the app's clipboard + toast). */
  copy: (text: string) => void;
  /** Speak `text` aloud via the Web Speech API in the meeting-language voice. */
  speak: (text: string) => void;
  /** Close the review surface (back to the live feed). */
  close: () => void;
}

/** A coaching result card the orchestrator fills once the host replies.
 *  `persistFailed` (#114): the host could not save the rewrites into the
 *  session file — the items still render, plus a one-line status. */
export interface CoachingCard {
  id: number;
  fill: (items: CoachingItemWire[], persistFailed?: boolean) => void;
  fail: (detail: string) => void;
}

export interface ReviewSurface {
  /** The root element to mount in the Panel. */
  readonly el: HTMLElement;
  /** Show the review surface with the final summary/board + metrics + the mic
   *  utterance list. Called once on session end. */
  show: (data: {
    summary: string[];
    board: BoardWire;
    talkRatioMic: number;
    smoothScore: number;
    micMs: number;
    systemMs: number;
    utterances: MicUtterance[];
    archivePath: string | null;
  }) => void;
  /** Hide the surface (new session started, or user closed it). */
  hide: () => void;
  /** Whether the surface is currently shown. */
  isOpen: () => boolean;
  /** Look up a coaching card by id (for routing results / failures). */
  coachingCard: (id: number) => CoachingCard | undefined;
}

/** Render the "Better" rewrite with each changed span highlighted (#82). The
 *  engine returns `changes[]` as {from,to}; we wrap each `to` occurrence in the
 *  better text with a highlight span. Plain-text safe: built via DOM nodes, never
 *  innerHTML, so model output is never interpreted as markup. Exported so the
 *  Dashboard renders persisted rewrites with the same highlighting (#114). */
export function renderBetter(parent: HTMLElement, better: string, changes: { from: string; to: string }[]): void {
  parent.replaceChildren();
  // Collect the distinct, non-empty replacement spans to highlight.
  const needles = [...new Set(changes.map((c) => c.to).filter((t) => t !== ""))].sort(
    (a, b) => b.length - a.length, // longer first so nested matches prefer the longer span
  );
  if (needles.length === 0) {
    parent.textContent = better;
    return;
  }
  let rest = better;
  // Greedy left-to-right scan: at each position find the earliest needle match.
  while (rest !== "") {
    let bestAt = -1;
    let bestNeedle = "";
    for (const needle of needles) {
      const at = rest.indexOf(needle);
      if (at !== -1 && (bestAt === -1 || at < bestAt || (at === bestAt && needle.length > bestNeedle.length))) {
        bestAt = at;
        bestNeedle = needle;
      }
    }
    if (bestAt === -1) {
      parent.appendChild(document.createTextNode(rest));
      break;
    }
    if (bestAt > 0) parent.appendChild(document.createTextNode(rest.slice(0, bestAt)));
    const mark = document.createElement("span");
    mark.className = "coach-change";
    mark.textContent = bestNeedle;
    parent.appendChild(mark);
    rest = rest.slice(bestAt + bestNeedle.length);
  }
}

/**
 * Populate `target` with the meeting board: one `board-row` (label + `<ul>`) per
 * non-empty section — Decisions / Action items / Open questions — or a "—"
 * dash when every section is empty. Clears `target` first, so it is safe
 * to re-run. Exported and shared by the review surface and the dashboard so the
 * two Board renderings can't drift; each caller owns its own container element
 * (the review reuses its board node; the dashboard wraps this in `.dash-board`).
 */
export function renderBoardInto(target: HTMLElement, board: BoardWire): void {
  target.replaceChildren();
  const sections: [string, string[]][] = [
    ["Decisions", board.decisions],
    ["Action items", board.actionItems],
    ["Open questions", board.openQuestions],
  ];
  for (const [label, items] of sections) {
    if (items.length === 0) continue;
    const row = document.createElement("div");
    row.className = "board-row";
    const head = document.createElement("span");
    head.className = "board-head";
    head.textContent = label;
    row.appendChild(head);
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    }
    row.appendChild(ul);
    target.appendChild(row);
  }
  if (target.childElementCount === 0) target.textContent = "—";
}

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

export function buildReview(callbacks: ReviewCallbacks): ReviewSurface {
  const root = document.createElement("div");
  root.id = "review";
  root.innerHTML = `
    <div class="review-head">
      <div class="review-tabs">
        <button class="review-tab" data-tab="summary" aria-selected="true">Review</button>
        <button class="review-tab" data-tab="coaching" aria-selected="false">Coaching</button>
      </div>
      <button class="review-close" title="Close — back to live" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="review-body">
      <div class="review-pane" data-pane="summary">
        <div class="review-metrics">
          <div class="metric">
            <div class="metric-value" id="rv-talk"></div>
            <div class="metric-label t-meta">Talk ratio (me)</div>
          </div>
          <div class="metric">
            <div class="metric-value" id="rv-smooth"></div>
            <div class="metric-label t-meta">Smooth Score</div>
          </div>
        </div>
        <div class="talk-bar" aria-hidden="true"><div class="talk-bar-mic" id="rv-talkbar"></div></div>
        <h3 class="review-h">Summary</h3>
        <ul class="review-summary" id="rv-summary"></ul>
        <h3 class="review-h">Board</h3>
        <div class="review-board" id="rv-board"></div>
        <div class="review-actions">
          <button id="rv-copy" title="Copy the summary">⧉ Copy summary</button>
          <button id="rv-open" title="Copy the saved file path">Open saved file</button>
        </div>
      </div>
      <div class="review-pane" data-pane="coaching" hidden>
        <div class="coach-toolbar">
          <span class="t-meta" id="coach-count"></span>
          <button id="coach-all" title="Coach all your utterances">Review all</button>
        </div>
        <div class="coach-list" id="coach-list"></div>
        <div class="coach-cards" id="coach-cards"></div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const talkEl = $<HTMLDivElement>("#rv-talk");
  const smoothEl = $<HTMLDivElement>("#rv-smooth");
  const talkBarEl = $<HTMLDivElement>("#rv-talkbar");
  const summaryEl = $<HTMLUListElement>("#rv-summary");
  const boardEl = $<HTMLDivElement>("#rv-board");
  const coachCountEl = $<HTMLSpanElement>("#coach-count");
  const coachListEl = $<HTMLDivElement>("#coach-list");
  const coachCardsEl = $<HTMLDivElement>("#coach-cards");
  const copyBtn = $<HTMLButtonElement>("#rv-copy");
  const openBtn = $<HTMLButtonElement>("#rv-open");
  const reviewAllBtn = $<HTMLButtonElement>("#coach-all");

  let open = false;
  let currentSummary: string[] = [];
  let currentArchivePath: string | null = null;
  let utterances: MicUtterance[] = [];
  const coachingCards = new Map<number, CoachingCard>();

  function selectTab(tab: string): void {
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".review-tab")) {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    }
    for (const pane of root.querySelectorAll<HTMLDivElement>(".review-pane")) {
      pane.hidden = pane.dataset.pane !== tab;
    }
  }

  root.addEventListener("click", (e) => {
    const tabBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".review-tab");
    if (tabBtn?.dataset.tab) selectTab(tabBtn.dataset.tab);
  });
  $<HTMLButtonElement>(".review-close").addEventListener("click", () => callbacks.close());

  copyBtn.addEventListener("click", () => callbacks.copy(currentSummary.join("\n")));
  openBtn.addEventListener("click", () => {
    if (currentArchivePath) callbacks.copy(currentArchivePath);
  });

  reviewAllBtn.addEventListener("click", () => {
    if (utterances.length === 0) return;
    runCoaching(utterances.map((u) => u.id));
  });

  /** Append a coaching card and request coaching for `ids`; the orchestrator
   *  routes the result back via the returned card id. */
  function runCoaching(ids: number[]): void {
    const cardId = callbacks.requestCoaching(ids);
    const card = registerCoachingCard(cardId);
    const el = document.createElement("div");
    el.className = "coach-card fading-in";
    el.innerHTML = `
      <button class="card-x" title="Close" aria-label="Close">${CLOSE_ICON}</button>
      <div class="coach-progress t-meta">Coaching ${String(ids.length)} utterance${ids.length === 1 ? "" : "s"}…</div>
      <div class="coach-items"></div>
    `;
    const itemsEl = el.querySelector<HTMLDivElement>(".coach-items") as HTMLDivElement;
    const progressEl = el.querySelector<HTMLDivElement>(".coach-progress") as HTMLDivElement;
    el.querySelector<HTMLButtonElement>(".card-x")?.addEventListener("click", () => {
      coachingCards.delete(cardId);
      el.remove();
    });
    coachCardsEl.prepend(el);
    requestAnimationFrame(() => el.classList.remove("fading-in"));

    card.fill = (items, persistFailed) => {
      // Save failure (#114): the rewrites render normally; the progress line
      // (the tab's status-line for request errors, cf. `fail` below) stays and
      // carries a one-line notice instead of being removed.
      if (persistFailed === true) {
        progressEl.textContent = "couldn't save coaching to the session file";
      } else {
        progressEl.remove();
      }
      itemsEl.replaceChildren();
      for (const item of items) renderCoachItem(itemsEl, item);
      coachingCards.delete(cardId);
    };
    // On failure: show an error state with a Retry that re-runs coaching for the
    // same ids (#5 — extrasFailed must clear the spinner, not hang forever).
    card.fail = (detail) => {
      coachingCards.delete(cardId);
      progressEl.textContent = `Coaching unavailable (${detail})`;
      itemsEl.replaceChildren();
      const retry = document.createElement("button");
      retry.className = "coach-retry";
      retry.title = "Retry";
      retry.textContent = "⟳ Retry";
      retry.addEventListener("click", () => {
        el.remove();
        runCoaching(ids);
      });
      itemsEl.appendChild(retry);
    };
  }

  function renderCoachItem(parent: HTMLElement, item: CoachingItemWire): void {
    const original = utterances.find((u) => u.id === item.id);
    const el = document.createElement("div");
    el.className = "coach-item";
    el.innerHTML = `
      <div class="coach-before t-meta"></div>
      <div class="coach-better-row">
        <div class="coach-better"></div>
        <button class="coach-play" title="발음 듣기 / Play">▶</button>
      </div>
      <div class="coach-explain t-meta"></div>
    `;
    const beforeEl = el.querySelector<HTMLDivElement>(".coach-before") as HTMLDivElement;
    beforeEl.textContent = original?.source ?? "";
    const betterEl = el.querySelector<HTMLDivElement>(".coach-better") as HTMLDivElement;
    renderBetter(betterEl, item.better, item.changes);
    const explainEl = el.querySelector<HTMLDivElement>(".coach-explain") as HTMLDivElement;
    explainEl.textContent = item.explanation;
    el.querySelector<HTMLButtonElement>(".coach-play")?.addEventListener("click", () =>
      callbacks.speak(item.better),
    );
    parent.appendChild(el);
  }

  function registerCoachingCard(id: number): CoachingCard {
    const card: CoachingCard = { id, fill: () => undefined, fail: () => undefined };
    coachingCards.set(id, card);
    return card;
  }

  function renderUtteranceList(): void {
    coachListEl.replaceChildren();
    coachCountEl.textContent =
      utterances.length === 0
        ? "You didn't speak in this session"
        : `${String(utterances.length)} of your utterances`;
    reviewAllBtn.disabled = utterances.length === 0;
    for (const u of utterances) {
      const row = document.createElement("button");
      row.className = "coach-row";
      row.innerHTML = `<span class="coach-row-time t-meta"></span><span class="coach-row-text"></span>`;
      (row.querySelector(".coach-row-time") as HTMLSpanElement).textContent = u.time;
      (row.querySelector(".coach-row-text") as HTMLSpanElement).textContent = u.source;
      row.addEventListener("click", () => runCoaching([u.id]));
      coachListEl.appendChild(row);
    }
  }

  return {
    el: root,
    isOpen: () => open,
    show: (data) => {
      open = true;
      currentSummary = data.summary;
      currentArchivePath = data.archivePath;
      utterances = data.utterances;
      talkEl.textContent = `${String(pct(data.talkRatioMic))}%`;
      smoothEl.textContent = String(data.smoothScore);
      talkBarEl.style.width = `${String(pct(data.talkRatioMic))}%`;
      summaryEl.replaceChildren();
      for (const line of data.summary) {
        const li = document.createElement("li");
        li.textContent = line;
        summaryEl.appendChild(li);
      }
      if (data.summary.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No summary was generated.";
        summaryEl.appendChild(li);
      }
      renderBoardInto(boardEl, data.board);
      renderUtteranceList();
      coachCardsEl.replaceChildren();
      openBtn.disabled = data.archivePath === null;
      selectTab("summary");
      root.classList.add("open");
    },
    hide: () => {
      open = false;
      root.classList.remove("open");
    },
    coachingCard: (id) => coachingCards.get(id),
  };
}
