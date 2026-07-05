// @vitest-environment jsdom
//
// #114: the Dashboard detail view renders PERSISTED coaching rewrites (saved
// into the session file by the review tab via #113) with the review tab's
// visual language — before (struck) → better (changes highlighted) →
// explanation — while entries without a saved rewrite (and whole sessions
// without a "## Coaching" section) keep the before-only rows.

import { beforeEach, describe, expect, it } from "vitest";

import { buildDashboard, type ArchivedSession, type DashboardSurface } from "../src/dashboard";

const COACHED_SESSION = `# Standup
> 2026-06-11 10:00–10:15 (15 min) · EN → KO · engine: Claude CLI ($0.05)

## Summary
- Blockers cleared

## Board
**Decisions** — ship on Friday

## Metrics
**Talk ratio (me)** — 60%
**Smooth Score** — 80

## Transcript
**Me** (10:00) — I goed to the store.
> 가게에 갔어요.

**Them** (10:01) — Nice.
> 좋네요.

**Me** (10:02) — Quick update.
> 빠른 업데이트.

## Coaching

### (10:00 · 1) — I goed to the store.
**Better:** I went to the store.
**Changes:** goed => went
**Explanation:** "goed" is not a word.
`;

const PLAIN_SESSION = `# Retro
> 2026-06-10 09:00–09:30 (30 min) · EN → KO · engine: Claude CLI ($0.10)

## Summary
- All good

## Board

## Metrics
**Talk ratio (me)** — 40%
**Smooth Score** — 70

## Transcript
**Me** (09:00) — Hello there.
> 안녕하세요.
`;

async function openDetail(markdown: string): Promise<DashboardSurface> {
  const archived: ArchivedSession[] = [{ name: "s.md", markdown }];
  const dashboard = buildDashboard({
    load: () => Promise.resolve(archived),
    onClose: () => undefined,
  });
  document.body.replaceChildren(dashboard.el);
  dashboard.open();
  await new Promise((resolve) => setTimeout(resolve, 0)); // let load() settle into the overview
  dashboard.el.querySelector<HTMLButtonElement>(".dash-row")?.click();
  return dashboard;
}

describe("dashboard renders persisted coaching (#114)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("a coached entry renders before → better with highlights + explanation", async () => {
    const dashboard = await openDetail(COACHED_SESSION);

    const item = dashboard.el.querySelector(".coach-item");
    expect(item).not.toBeNull();
    expect(item?.querySelector(".coach-before")?.textContent).toBe("I goed to the store.");
    expect(item?.querySelector(".coach-better")?.textContent).toBe("I went to the store.");
    // The changed span is highlighted exactly like the review tab.
    expect(item?.querySelector(".coach-change")?.textContent).toBe("went");
    expect(item?.querySelector(".coach-explain")?.textContent).toContain("not a word");
    // No play button here — TTS stays review-tab-only.
    expect(item?.querySelector(".coach-play")).toBeNull();

    // The uncoached "me" entry keeps today's before-only row.
    const row = dashboard.el.querySelector(".dash-coach-row");
    expect(row?.textContent).toContain("Quick update.");
    expect(dashboard.el.querySelectorAll(".coach-item").length).toBe(1);
    expect(dashboard.el.querySelectorAll(".dash-coach-row").length).toBe(1);
  });

  it("a session without persisted coaching keeps the before-only view", async () => {
    const dashboard = await openDetail(PLAIN_SESSION);

    expect(dashboard.el.querySelector(".coach-item")).toBeNull();
    const rows = dashboard.el.querySelectorAll(".dash-coach-row");
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("Hello there.");
  });
});
