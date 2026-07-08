// @vitest-environment jsdom
//
// #143: the pending-translation shimmer is capped to a single element via the
// `shimmering` class (the CSS animation — and its prefers-reduced-motion gate —
// keys off `.cap[data-state="pending"].shimmering .tr`). This exercises the
// class-application logic against real DOM nodes.
import { beforeEach, describe, expect, it } from "vitest";

import { applyShimmerCap } from "../src/feed-coalescer";

interface Block {
  key: string;
  state: string;
}

function makeEls(keys: string[]): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const key of keys) {
    const el = document.createElement("div");
    el.className = "cap";
    el.dataset.key = key;
    map.set(key, el);
  }
  return map;
}

describe("applyShimmerCap (#143)", () => {
  let els: Map<string, HTMLElement>;
  const elementFor = (key: string) => els.get(key);

  beforeEach(() => {
    els = makeEls(["a", "b", "c"]);
  });

  it("marks only the newest pending block, none of the others", () => {
    const blocks: Block[] = [
      { key: "a", state: "pending" },
      { key: "b", state: "translated" },
      { key: "c", state: "pending" },
    ];
    const now = applyShimmerCap(blocks, elementFor, null);
    expect(now).toBe(els.get("c"));
    const shimmering = [...els.entries()].filter(([, el]) => el.classList.contains("shimmering"));
    expect(shimmering.map(([k]) => k)).toEqual(["c"]); // exactly one animates
  });

  it("moves the class off the previous block when the latest pending advances", () => {
    const first = applyShimmerCap([{ key: "a", state: "pending" }], elementFor, null);
    expect(els.get("a")!.classList.contains("shimmering")).toBe(true);

    // 'a' translated, 'b' now the newest pending.
    const second = applyShimmerCap(
      [
        { key: "a", state: "translated" },
        { key: "b", state: "pending" },
      ],
      elementFor,
      first,
    );
    expect(second).toBe(els.get("b"));
    expect(els.get("a")!.classList.contains("shimmering")).toBe(false); // moved off
    expect(els.get("b")!.classList.contains("shimmering")).toBe(true);
  });

  it("clears the shimmer when nothing is pending", () => {
    const prev = applyShimmerCap([{ key: "a", state: "pending" }], elementFor, null);
    const now = applyShimmerCap([{ key: "a", state: "translated" }], elementFor, prev);
    expect(now).toBeNull();
    expect(els.get("a")!.classList.contains("shimmering")).toBe(false);
  });

  it("is idempotent — re-applying the same latest pending leaves one shimmer", () => {
    const blocks: Block[] = [{ key: "c", state: "pending" }];
    const once = applyShimmerCap(blocks, elementFor, null);
    const twice = applyShimmerCap(blocks, elementFor, once);
    expect(twice).toBe(once);
    expect(els.get("c")!.classList.contains("shimmering")).toBe(true);
  });
});
