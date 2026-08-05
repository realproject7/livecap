import { describe, expect, it } from "vitest";

import { MAX_UNITS_IN_FLIGHT_PER_CHANNEL, StreamingAssembler } from "../src/host/streaming-assembly";

// #195: a streamed utterance is translated in pieces, but the archive stores ONE
// line per utterance (#137's 1:1 mapping). These cover the ordering that puts
// the pieces back together — including the cases where a piece is late, never
// arrives, or belongs to a cancelled utterance.

const MIC = "mic";

describe("StreamingAssembler — the happy path", () => {
  it("joins unit translations with the tail, in spoken order", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "we are committed to the dual mandate.");
    a.noteUnitResult(1, "우리는 이중 책무에 전념합니다.");

    // 7 words already covered; the finalized line has 11.
    const plan = a.onFinalized(MIC, 100, "we are committed to the dual mandate. and we will adjust", 7);
    expect(plan.tailText).toBe("and we will adjust");
    expect(plan.ready).toBe(false); // the tail is not translated yet

    a.noteTailResult(100, "그리고 우리는 조정할 것입니다");
    expect(a.tryAssemble(100)).toBe("우리는 이중 책무에 전념합니다. 그리고 우리는 조정할 것입니다");
  });

  it("needs no tail turn when the units covered the whole utterance", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "we are committed to the dual mandate.");
    a.noteUnitResult(1, "우리는 이중 책무에 전념합니다.");

    const plan = a.onFinalized(MIC, 100, "we are committed to the dual mandate.", 7);
    expect(plan.tailText).toBe("");
    // Everything is in hand, so the finalize turn costs nothing.
    expect(plan.ready).toBe(true);
    expect(a.tryAssemble(100)).toBe("우리는 이중 책무에 전념합니다.");
  });

  it("assembles several units in dispatch order", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    a.noteUnit(MIC, 2, "second clause.");
    a.noteUnitResult(2, "두 번째.");
    a.noteUnitResult(1, "첫 번째.");
    a.onFinalized(MIC, 100, "first clause. second clause.", 4);
    // Result ORDER follows dispatch order, not arrival order.
    expect(a.tryAssemble(100)).toBe("첫 번째. 두 번째.");
  });
});

describe("StreamingAssembler — pieces that are late or missing", () => {
  it("waits for a unit that is still in flight at finalize", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "we are committed to the dual mandate.");
    // No result yet — the utterance finalizes first.
    const plan = a.onFinalized(MIC, 100, "we are committed to the dual mandate. and more words here", 7);
    expect(plan.ready).toBe(false);

    a.noteTailResult(100, "그리고 더");
    // Tail is in, but the unit is not: still not assemblable.
    expect(a.tryAssemble(100)).toBeNull();

    a.noteUnitResult(1, "우리는 이중 책무에 전념합니다.");
    expect(a.tryAssemble(100)).toBe("우리는 이중 책무에 전념합니다. 그리고 더");
  });

  // A failed unit must not leave a hole in the archived line. Re-translating
  // that span is a deliberate exception to never-translate-twice: paying twice
  // is recoverable, an archive missing what the speaker said is not.
  it("folds a failed unit's source back into the tail for retry", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "we are committed to the dual mandate.");
    a.noteUnitFailed(1);

    const plan = a.onFinalized(MIC, 100, "we are committed to the dual mandate. and we will adjust", 7);
    expect(plan.tailText).toBe("we are committed to the dual mandate. and we will adjust");
    a.noteTailResult(100, "전체 번역");
    expect(a.tryAssemble(100)).toBe("전체 번역");
  });

  // RE2's finding on #212: WHEN the failure lands changes what has to happen.
  // Folding into the tail only works while the unit is still pending; once the
  // utterance has finalized, that turn is already dispatched without the span.
  it("asks for a retry when a unit fails AFTER its utterance finalized", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "we are committed to the dual mandate.");
    const plan = a.onFinalized(MIC, 100, "we are committed to the dual mandate. and we will adjust", 7);
    expect(plan.tailText).toBe("and we will adjust");
    a.noteTailResult(100, "그리고 우리는 조정할 것입니다");

    // The unit's turn fails only now, with the tail already out.
    const retry = a.noteUnitFailed(1);
    expect(retry).toEqual({ captionId: 100, source: "we are committed to the dual mandate." });
    // Still not assemblable: the span is owed, not abandoned.
    expect(a.tryAssemble(100)).toBeNull();

    a.noteUnitResult(1, "우리는 이중 책무에 전념합니다.");
    expect(a.tryAssemble(100)).toBe("우리는 이중 책무에 전념합니다. 그리고 우리는 조정할 것입니다");
  });

  it("returns no retry while the unit is still pending, so it folds into the tail", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    expect(a.noteUnitFailed(1)).toBeNull();
  });

  // The wedge RE2 named: a failed post-finalize unit that is never resolved used
  // to leave isReady() false forever, so the line waited for the drain deadline
  // and THEN dropped the span anyway.
  it("gives up after one retry instead of wedging the line", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    a.noteUnit(MIC, 2, "second clause.");
    a.noteUnitResult(2, "두 번째.");
    a.onFinalized(MIC, 100, "first clause. second clause.", 4);

    expect(a.noteUnitFailed(1)).not.toBeNull(); // retry dispatched
    expect(a.tryAssemble(100)).toBeNull();
    expect(a.noteUnitFailed(1)).toBeNull(); // the retry failed too: abandoned
    // Assembles on its own rather than waiting for the drain deadline.
    expect(a.tryAssemble(100)).toBe("두 번째.");
  });

  it("does not retry a unit belonging to an utterance that was cancelled", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "bleed clause.");
    a.dropChannel(MIC);
    expect(a.noteUnitFailed(1)).toBeNull();
  });

  it("force-assembles from what arrived rather than losing the line", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    a.noteUnit(MIC, 2, "second clause.");
    a.noteUnitResult(1, "첫 번째.");
    a.onFinalized(MIC, 100, "first clause. second clause.", 4);
    // Unit 2 never returns and the drain deadline fires.
    expect(a.tryAssemble(100)).toBeNull();
    expect(a.forceAssemble(100)).toBe("첫 번째.");
  });

  it("returns null rather than an empty line when nothing arrived", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    a.onFinalized(MIC, 100, "first clause.", 2);
    expect(a.forceAssemble(100)).toBeNull();
  });

  it("cannot assemble the same caption twice", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    a.noteUnitResult(1, "첫 번째.");
    a.onFinalized(MIC, 100, "first clause.", 2);
    expect(a.tryAssemble(100)).toBe("첫 번째.");
    expect(a.tryAssemble(100)).toBeNull();
  });
});

// #195 backpressure. RE1's blocker was that nothing capped units per channel;
// the count lives here rather than in the session so it is testable and cannot
// drift from the unit lifecycle it describes.
describe("StreamingAssembler — in-flight accounting", () => {
  it("counts only units still awaiting a result", () => {
    const a = new StreamingAssembler();
    expect(a.inFlightCount(MIC)).toBe(0);
    a.noteUnit(MIC, 1, "first clause.");
    a.noteUnit(MIC, 2, "second clause.");
    expect(a.inFlightCount(MIC)).toBe(2);

    a.noteUnitResult(1, "첫 번째.");
    expect(a.inFlightCount(MIC)).toBe(1);
    // A FAILED unit is no longer in flight either — otherwise a channel whose
    // units keep failing would wedge at the cap and stop streaming silently.
    a.noteUnitFailed(2);
    expect(a.inFlightCount(MIC)).toBe(0);
  });

  it("counts per channel, so one channel cannot starve the other", () => {
    const a = new StreamingAssembler();
    a.noteUnit("mic", 1, "mic clause.");
    a.noteUnit("mic", 2, "mic clause two.");
    a.noteUnit("system", 3, "system clause.");
    expect(a.inFlightCount("mic")).toBe(2);
    expect(a.inFlightCount("system")).toBe(1);
  });

  it("clears the count when the utterance finalizes or is cancelled", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "first clause.");
    a.onFinalized(MIC, 100, "first clause. and more", 2);
    expect(a.inFlightCount(MIC)).toBe(0);

    a.noteUnit(MIC, 2, "next clause.");
    expect(a.inFlightCount(MIC)).toBe(1);
    a.dropChannel(MIC);
    expect(a.inFlightCount(MIC)).toBe(0);
  });
});

// RE1's blocker on `5d79490`: refusing a unit at the cap is not free. The Rust
// tracker advanced its released-words watermark when it EMITTED the span, and
// never learns the host declined it — so pretranslatedWords counts the span as
// translated and the tail begins after it. Refuse without folding and the words
// are archived as source and never translated at all.
describe("StreamingAssembler — the cap (#195 backpressure)", () => {
  it("admits up to the cap and refuses past it", () => {
    const a = new StreamingAssembler();
    for (let i = 1; i <= MAX_UNITS_IN_FLIGHT_PER_CHANNEL; i += 1) {
      expect(a.admitUnit(MIC, i, `clause ${i}.`)).toBe(true);
    }
    expect(a.admitUnit(MIC, 99, "one clause too many.")).toBe(false);
    // The refused unit does not itself occupy a slot, or the cap would ratchet
    // shut and the channel would never stream again.
    expect(a.inFlightCount(MIC)).toBe(MAX_UNITS_IN_FLIGHT_PER_CHANNEL);
  });

  it("re-translates a refused span in the finalize tail instead of losing it", () => {
    const a = new StreamingAssembler();
    expect(a.admitUnit(MIC, 1, "alpha beta.")).toBe(true);
    expect(a.admitUnit(MIC, 2, "gamma delta.")).toBe(true);
    // Refused: dispatched nowhere, but the watermark upstream already counted it.
    expect(a.admitUnit(MIC, 3, "epsilon zeta.")).toBe(false);
    a.noteUnitResult(1, "A.");
    a.noteUnitResult(2, "B.");

    // The recognizer reports all six released words as pretranslated.
    const plan = a.onFinalized(MIC, 100, "alpha beta. gamma delta. epsilon zeta. eta theta", 6);
    // The refused span rides the tail, ahead of the genuinely-new words.
    expect(plan.tailText).toBe("epsilon zeta. eta theta");

    a.noteTailResult(100, "EZ. ET.");
    expect(a.tryAssemble(100)).toBe("A. B. EZ. ET.");
  });

  it("frees a slot as each unit resolves", () => {
    const a = new StreamingAssembler();
    a.admitUnit(MIC, 1, "one.");
    a.admitUnit(MIC, 2, "two.");
    expect(a.admitUnit(MIC, 3, "three.")).toBe(false);
    a.noteUnitResult(1, "1.");
    expect(a.admitUnit(MIC, 4, "four.")).toBe(true);
  });
});

describe("StreamingAssembler — channel and utterance boundaries", () => {
  it("keeps channels separate", () => {
    const a = new StreamingAssembler();
    a.noteUnit("mic", 1, "mic clause.");
    a.noteUnit("system", 2, "system clause.");
    a.noteUnitResult(1, "마이크.");
    a.noteUnitResult(2, "시스템.");

    a.onFinalized("mic", 100, "mic clause.", 2);
    expect(a.tryAssemble(100)).toBe("마이크.");
    a.onFinalized("system", 101, "system clause.", 2);
    expect(a.tryAssemble(101)).toBe("시스템.");
  });

  // #56/#62: a suppressed mic utterance is cancelled after streaming partials.
  // Its units must not attach to whatever the channel says next.
  it("drops a cancelled utterance's units instead of attaching them to the next", () => {
    const a = new StreamingAssembler();
    a.noteUnit(MIC, 1, "bleed clause.");
    a.noteUnitResult(1, "누출.");
    a.dropChannel(MIC);

    const plan = a.onFinalized(MIC, 100, "a completely different utterance follows here now", 0);
    expect(plan.tailText).toBe("a completely different utterance follows here now");
    a.noteTailResult(100, "완전히 다른 발화");
    expect(a.tryAssemble(100)).toBe("완전히 다른 발화");
  });

  // A recognizer that revises text downward at finalize must never cause real
  // words to be skipped as "already translated".
  it("clamps a pretranslated count larger than the finalized text", () => {
    const a = new StreamingAssembler();
    const plan = a.onFinalized(MIC, 100, "three words only", 99);
    expect(plan.tailText).toBe("");
    expect(plan.ready).toBe(true);
  });

  it("treats a zero pretranslated count as the whole line needing translation", () => {
    const a = new StreamingAssembler();
    const plan = a.onFinalized(MIC, 100, "we are committed to the dual mandate", 0);
    expect(plan.tailText).toBe("we are committed to the dual mandate");
    expect(plan.ready).toBe(false);
  });
});
