// @vitest-environment jsdom
//
// #144: the dashboard opens from a lightweight front-matter index and loads full
// session bodies LAZILY (one on detail open) or ON DEMAND (all, on first search)
// — never a full-archive slurp on open. These integration tests pin two things:
//
//   1. Opening does NOT call the full-body loaders; clicking a row loads exactly
//      that one session's body.
//   2. The #131 transcript-body search stays COMPLETE across ALL sessions — a
//      term present only in an as-yet-unloaded transcript still matches — so
//      lazy loading does not regress search to loaded/title-only (the pinned
//      acceptance criterion, issue #144 review amendment).

import { beforeEach, describe, expect, it } from "vitest";

import { buildDashboard, type ArchivedSession, type SessionHeader } from "../src/dashboard";

/** A saved session whose transcript carries `bodyWord` (absent from the front
 *  matter), so a search hit on it can only come from loading the full body. */
function session(title: string, dateClock: string, bodyWord: string): { name: string; full: string; header: string } {
  const [date, clock] = dateClock.split(" ");
  const full = `# ${title}
> ${date} ${clock?.slice(0, 2)}:${clock?.slice(2)}–${clock?.slice(0, 2)}:${clock?.slice(2)} (30 min) · EN → KO · engine: Claude CLI ($0.10)

## Summary
- routine notes

## Metrics
**Talk ratio (me)** — 40%
**Smooth Score** — 70

## Transcript
**Me** (${clock?.slice(0, 2)}:${clock?.slice(2)}) — the ${bodyWord} appeared today.
> 오늘 ${bodyWord} 나타났다.
`;
  return { name: `${date} ${clock} — ${title}.md`, full, header: full.slice(0, full.indexOf("## Transcript")) };
}

const ALPHA = session("Alpha", "2026-06-10 0900", "zebra");
const BETA = session("Beta", "2026-06-11 1000", "giraffe");

interface Harness {
  el: HTMLElement;
  indexCalls: number;
  sessionLoads: string[];
  allCalls: number;
}

function mount(): Harness {
  const h: Harness = { el: document.createElement("div"), indexCalls: 0, sessionLoads: [], allCalls: 0 };
  const index: SessionHeader[] = [
    { name: ALPHA.name, markdown: ALPHA.header },
    { name: BETA.name, markdown: BETA.header },
  ];
  const bodies: Record<string, string> = { [ALPHA.name]: ALPHA.full, [BETA.name]: BETA.full };
  const all: ArchivedSession[] = [
    { name: ALPHA.name, markdown: ALPHA.full },
    { name: BETA.name, markdown: BETA.full },
  ];
  const dashboard = buildDashboard({
    loadIndex: () => {
      h.indexCalls += 1;
      return Promise.resolve(index);
    },
    loadSession: (name) => {
      h.sessionLoads.push(name);
      return Promise.resolve(bodies[name] ?? "");
    },
    loadAll: () => {
      h.allCalls += 1;
      return Promise.resolve(all);
    },
    onClose: () => undefined,
  });
  h.el = dashboard.el;
  document.body.replaceChildren(dashboard.el);
  dashboard.open();
  return h;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Type into the search box and let the ~150ms debounce + the on-demand body
 *  load settle. */
async function search(el: HTMLElement, query: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(".dash-search");
  if (input === null) throw new Error("no search box");
  input.value = query;
  input.dispatchEvent(new Event("input"));
  await tick(200); // debounce (150ms) + margin
  await tick(0); // let ensureAllBodiesLoaded's promise chain flush
  await tick(0);
}

function rowTitles(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".dash-row-title")].map((n) => n.textContent ?? "");
}

describe("#144 lazy load + on-demand search", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("opens from the index without loading any full body; a row click loads exactly one", async () => {
    const h = mount();
    await tick(0); // loadIndex → overview

    // Two rows from the index, and NO full bodies were fetched on open.
    expect(rowTitles(h.el)).toEqual(["Beta", "Alpha"]); // newest first
    expect(h.sessionLoads).toEqual([]);
    expect(h.allCalls).toBe(0);

    // Clicking Alpha loads exactly that one session's body, then renders its
    // transcript in the detail.
    const alphaRow = [...h.el.querySelectorAll<HTMLButtonElement>(".dash-row")].find(
      (r) => r.textContent?.includes("Alpha"),
    );
    alphaRow?.click();
    await tick(0);

    expect(h.sessionLoads).toEqual([ALPHA.name]);
    expect(h.allCalls).toBe(0); // still no full-archive slurp
    expect(h.el.querySelector(".dash-transcript")?.textContent).toContain("zebra");
  });

  it("search stays COMPLETE across all sessions — a body-only term in an unloaded session still matches (#131 non-regression)", async () => {
    const h = mount();
    await tick(0);

    // "zebra" appears only in Alpha's TRANSCRIPT (never in any front matter), and
    // no body was loaded on open — so a hit proves the full bodies were loaded on
    // demand and searched completely.
    await search(h.el, "zebra");
    expect(h.allCalls).toBe(1); // loaded on demand, once
    expect(rowTitles(h.el)).toEqual(["Alpha"]);

    // "giraffe" is only in Beta's transcript — also matched, from the same load.
    await search(h.el, "giraffe");
    expect(h.allCalls).toBe(1); // cached; not reloaded
    expect(rowTitles(h.el)).toEqual(["Beta"]);

    // A term absent everywhere yields the empty-search note, not a false match.
    await search(h.el, "nonexistent-term");
    expect(rowTitles(h.el)).toEqual([]);
    expect(h.el.querySelector(".dash-rows")?.textContent).toContain("No sessions match");

    // Clearing the box restores the full list without another load.
    await search(h.el, "");
    expect(rowTitles(h.el)).toEqual(["Beta", "Alpha"]);
    expect(h.allCalls).toBe(1);
  });
});
