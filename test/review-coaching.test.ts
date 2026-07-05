// @vitest-environment jsdom
//
// #82 / #5: the post-meeting Coaching tab must NEVER hang on a per-row result.
// A failed coach round-trip (host emits `extrasFailed`, OR the host request is
// rejected because the session ended) has to clear the spinner and show an error
// state with a Retry — these tests pin that failure-routing path, plus the happy
// path (a "coaching" result fills the card).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildReview, type ReviewCallbacks, type ReviewSurface } from "../src/review";

function makeReview(overrides: Partial<ReviewCallbacks> = {}): {
  review: ReviewSurface;
  requestCoaching: ReturnType<typeof vi.fn>;
} {
  const requestCoaching = vi.fn<(ids: number[]) => number>(() => 1);
  const review = buildReview({
    requestCoaching,
    copy: vi.fn(),
    speak: vi.fn(),
    close: vi.fn(),
    ...overrides,
  });
  document.body.replaceChildren(review.el);
  return { review, requestCoaching };
}

function show(review: ReviewSurface): void {
  review.show({
    summary: ["A meeting happened"],
    board: { decisions: [], actionItems: [], openQuestions: [] },
    talkRatioMic: 0.5,
    smoothScore: 80,
    micMs: 1000,
    systemMs: 1000,
    utterances: [{ id: 7, source: "so uh I think we should um ship", time: "10:45" }],
    archivePath: null,
  });
}

describe("coaching failure routing (#5/#82)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    // requestAnimationFrame is used for the fade-in; jsdom provides it, but make
    // it synchronous so the card is in the DOM immediately for assertions.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  it("clicking a row shows a spinner, then an error+retry when coaching fails", () => {
    const { review, requestCoaching } = makeReview();
    show(review);

    const row = review.el.querySelector<HTMLButtonElement>(".coach-row");
    expect(row).not.toBeNull();
    row?.click();

    // The card is registered and shows the in-progress spinner.
    expect(requestCoaching).toHaveBeenCalledTimes(1);
    const cardId = requestCoaching.mock.results[0]?.value as number;
    let progress = review.el.querySelector(".coach-progress");
    expect(progress?.textContent).toContain("Coaching 1 utterance");

    // The host reports the failure (e.g. session ended → engine unreachable).
    review.coachingCard(cardId)?.fail("no active session");

    progress = review.el.querySelector(".coach-progress");
    expect(progress?.textContent).toContain("unavailable");
    expect(progress?.textContent).toContain("no active session");
    // It must NOT still be the infinite spinner.
    expect(progress?.textContent).not.toContain("Coaching 1 utterance…");
    // A Retry control is offered.
    const retry = review.el.querySelector<HTMLButtonElement>(".coach-retry");
    expect(retry).not.toBeNull();

    // Retry re-runs coaching (new request) and removes the failed card.
    retry?.click();
    expect(requestCoaching).toHaveBeenCalledTimes(2);
  });

  it("a successful coaching result fills the card with items", () => {
    const { review, requestCoaching } = makeReview();
    show(review);

    review.el.querySelector<HTMLButtonElement>(".coach-row")?.click();
    const cardId = requestCoaching.mock.results[0]?.value as number;

    review.coachingCard(cardId)?.fill([
      {
        id: 7,
        better: "I think we should ship it.",
        changes: [{ from: "um ship", to: "ship it" }],
        explanation: "Removed the filler word.",
      },
    ]);

    const item = review.el.querySelector(".coach-item");
    expect(item).not.toBeNull();
    expect(item?.querySelector(".coach-better")?.textContent).toContain("ship it");
    expect(item?.querySelector(".coach-explain")?.textContent).toContain("filler");
    // The spinner is gone.
    expect(review.el.querySelector(".coach-progress")).toBeNull();
  });

  it("a save failure (#114) still renders the rewrites, plus a one-line status", () => {
    const { review, requestCoaching } = makeReview();
    show(review);

    review.el.querySelector<HTMLButtonElement>(".coach-row")?.click();
    const cardId = requestCoaching.mock.results[0]?.value as number;

    review.coachingCard(cardId)?.fill(
      [
        {
          id: 7,
          better: "I think we should ship it.",
          changes: [{ from: "um ship", to: "ship it" }],
          explanation: "Removed the filler word.",
        },
      ],
      true, // the host could not amend the session file
    );

    // The rewrites render normally…
    const item = review.el.querySelector(".coach-item");
    expect(item?.querySelector(".coach-better")?.textContent).toContain("ship it");
    // …and the status line (the same element request errors use) carries the
    // one-line notice instead of the spinner.
    const progress = review.el.querySelector(".coach-progress");
    expect(progress?.textContent).toBe("couldn't save coaching to the session file");
    // No retry control — persistence is a single attempt, not retried.
    expect(review.el.querySelector(".coach-retry")).toBeNull();
  });

  it("the card's top-right ✕ closes it", () => {
    const { review, requestCoaching } = makeReview();
    show(review);
    review.el.querySelector<HTMLButtonElement>(".coach-row")?.click();
    const cardId = requestCoaching.mock.results[0]?.value as number;

    expect(review.el.querySelector(".coach-card")).not.toBeNull();
    review.el.querySelector<HTMLButtonElement>(".coach-card .card-x")?.click();
    expect(review.el.querySelector(".coach-card")).toBeNull();
    // The card is deregistered, so a late result is a no-op (no throw).
    expect(() => review.coachingCard(cardId)?.fill([])).not.toThrow();
  });
});
