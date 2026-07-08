// Per-frame coalescer for the live feed's DOM writes (#143).
//
// The caption/translation → DOM path used to apply a write and then read
// `feedWrap.scrollHeight` (a forced synchronous reflow) on EVERY event. The
// high-frequency source is translation snapshots: they arrive unthrottled at
// 5–20+/s during a batch (partials are already throttled 1.2s upstream), so a
// batch meant that many forced reflows a second, each re-laying-out the feed.
//
// This accumulates which blocks changed — deduped by render key, so a block
// re-translated 20× within one frame is written once — plus whether any block
// was newly appended (drives the "↓ live" snap-back chip). The caller drains it
// inside a single `requestAnimationFrame` and does one scroll-stick read/write
// for the whole frame. WebKit lacks `overflow-anchor`, so this rAF batching —
// not a CSS anchor — is the mechanism.
//
// DOM- and rAF-free by design, so the coalescing logic is unit-testable headless.

/** The changes accumulated for one frame's flush. */
export interface CoalescedFrame<B> {
  /** Distinct changed blocks (deduped by key; the latest value per key wins). */
  dirty: B[];
  /** Whether at least one new block was appended this frame. */
  appended: boolean;
}

export class FeedCoalescer<B extends { key: string }> {
  private readonly dirty = new Map<string, B>();
  private appended = false;

  /** Queue a changed block for the next flush (dedup by key — latest wins). */
  markDirty(block: B): void {
    this.dirty.set(block.key, block);
  }

  /** Note that a new block was appended this frame. */
  markAppended(): void {
    this.appended = true;
  }

  /**
   * Forget a block that has left the DOM (evicted by the render window, or a
   * cleared partial) so the flush never re-materializes it from a stale write.
   */
  drop(key: string): void {
    this.dirty.delete(key);
  }

  /** Take the accumulated changes and reset for the next frame. */
  drain(): CoalescedFrame<B> {
    const frame: CoalescedFrame<B> = { dirty: [...this.dirty.values()], appended: this.appended };
    this.dirty.clear();
    this.appended = false;
    return frame;
  }
}

/**
 * The render key of the newest still-pending block, or null if none (#143).
 * Blocks are held newest-last, so this is the single block nearest the live edge
 * — the only one that should show the pending-translation shimmer.
 */
export function latestPendingKey(blocks: readonly { key: string; state: string }[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].state === "pending") return blocks[i].key;
  }
  return null;
}

/**
 * Apply the shimmer cap (#143): keep the `shimmering` class on ONLY the newest
 * pending block's element, moving it off `previous` if the latest changed.
 * A translation batch leaves many blocks pending at once; without this cap each
 * ran its own infinite animation. Returns the now-shimmering element (or null)
 * so the caller can remember it and skip redundant DOM work next frame. Pure
 * over its inputs — no module state — so it is jsdom-testable.
 */
export function applyShimmerCap(
  blocks: readonly { key: string; state: string }[],
  elementFor: (key: string) => HTMLElement | null | undefined,
  previous: HTMLElement | null,
): HTMLElement | null {
  const key = latestPendingKey(blocks);
  const next = key !== null ? elementFor(key) ?? null : null;
  if (previous === next) return next;
  previous?.classList.remove("shimmering");
  next?.classList.add("shimmering");
  return next;
}
