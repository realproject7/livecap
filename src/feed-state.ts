// Pure caption-feed state (#11): maps the bridge event stream onto the five
// caption-block states of the design system (design/system/design-system.png):
// 1 streaming partial · 2 finalized/translation-pending · 3 translated ·
// 4 low-confidence (?) · 5 pinned. No DOM, no Tauri — unit-tested headless.
//
// #57: the feed is WINDOWED — only the newest FEED_WINDOW blocks stay in the
// model (and therefore the DOM); older blocks are evicted oldest-first. Every
// finalized caption is already durable in the session archive (#11), so
// eviction loses nothing. Pinned blocks and live partials are never evicted.

import type { CaptionBridgeEvent, Channel, TranslationItem } from "./protocol";

export type BlockState = "streaming" | "pending" | "translated" | "failed";

/** Rendered-block cap (#57): keeps a 3-hour meeting's DOM flat. */
export const FEED_WINDOW = 200;

export interface CaptionBlock {
  /** Stable render key (DOM identity). */
  key: string;
  /** Sentence id once finalized; null while streaming. */
  id: number | null;
  channel: Channel;
  state: BlockState;
  source: string;
  translation: string;
  lowConfidence: boolean;
  pinned: boolean;
  epochMs: number | null;
}

export class FeedState {
  readonly blocks: CaptionBlock[] = [];
  private readonly byId = new Map<number, CaptionBlock>();
  private readonly partials = new Map<Channel, CaptionBlock>();
  private keyCounter = 0;
  private evicted = 0;

  constructor(private readonly windowSize: number = FEED_WINDOW) {}

  /** How many blocks have been evicted into history (archive-only). */
  get evictedCount(): number {
    return this.evicted;
  }

  /**
   * Clear ALL state so a new session starts empty (#171). The feed is a
   * long-lived webview singleton; without this, a second session in the same app
   * run inherits the first's blocks, ids, live partials, keys, and eviction
   * count. Nothing is lost — every finalized caption is already durable in the
   * session archive (#11). Mutates the `blocks` array in place so existing
   * references (shimmer cap, heartbeat) observe the empty feed.
   */
  reset(): void {
    this.blocks.length = 0;
    this.byId.clear();
    this.partials.clear();
    this.keyCounter = 0;
    this.evicted = 0;
  }

  /**
   * Enforce the render window (#57): while more than `windowSize` blocks are
   * held, drop the oldest ones — skipping pinned blocks and live partials,
   * which are never evicted (so the total may exceed the window when old
   * pins accumulate). Returns the evicted blocks so the caller can drop
   * their DOM nodes; evicted ids stop resolving (late translations for them
   * are ignored here — the archive still records them in the host).
   */
  evictOverflow(): CaptionBlock[] {
    const dropped: CaptionBlock[] = [];
    let overflow = this.blocks.length - this.windowSize;
    if (overflow <= 0) return dropped;
    const live = new Set(this.partials.values());
    let index = 0;
    while (overflow > 0 && index < this.blocks.length) {
      const block = this.blocks[index];
      if (block.pinned || live.has(block)) {
        index += 1;
        continue;
      }
      this.blocks.splice(index, 1);
      if (block.id !== null) this.byId.delete(block.id);
      dropped.push(block);
      overflow -= 1;
    }
    this.evicted += dropped.length;
    return dropped;
  }

  /**
   * Drop the channel's in-progress streaming partial WITHOUT finalizing it
   * (#62): a mic utterance suppressed as speaker bleed (#56) emits no finalized
   * event, so the streaming block it already pushed would otherwise linger and
   * be reused by the next genuine utterance. Returns the removed block (so the
   * caller can drop its DOM node), or null if nothing was streaming. The block
   * carried no id (never finalized), so it is not in `byId` and resolves to
   * nothing for translation.
   */
  clearPartial(channel: Channel): CaptionBlock | null {
    const block = this.partials.get(channel);
    if (!block) return null;
    this.partials.delete(channel);
    const index = this.blocks.indexOf(block);
    if (index !== -1) this.blocks.splice(index, 1);
    return block;
  }

  /**
   * Apply a caption event. A finalized event REUSES the channel's streaming
   * block (text settles in place — no layout jump, rule 4); returns the
   * affected block.
   */
  applyCaption(event: Exclude<CaptionBridgeEvent, { type: "cleared" }>): CaptionBlock {
    if (event.type === "partial") {
      let block = this.partials.get(event.channel);
      if (!block) {
        block = this.newBlock(event.channel);
        this.partials.set(event.channel, block);
        this.blocks.push(block);
      }
      block.source = event.text;
      return block;
    }

    let block = this.partials.get(event.channel);
    if (block) {
      this.partials.delete(event.channel);
    } else {
      block = this.newBlock(event.channel);
      this.blocks.push(block);
    }
    block.id = event.id;
    block.state = "pending";
    block.source = event.text;
    block.lowConfidence = event.lowConfidence;
    block.epochMs = event.epochMs;
    this.byId.set(event.id, block);
    return block;
  }

  /** Apply a (possibly partial) translation snapshot. Returns changed blocks. */
  applyTranslation(items: TranslationItem[], done: boolean): CaptionBlock[] {
    const changed: CaptionBlock[] = [];
    for (const item of items) {
      const block = this.byId.get(item.id);
      if (!block) continue;
      if (block.translation === item.text && !done) continue;
      block.translation = item.text;
      block.state = done ? "translated" : "pending";
      changed.push(block);
    }
    return changed;
  }

  /** A batch failed: discard any streamed partial translation (engine contract). */
  applyFailed(ids: number[]): CaptionBlock[] {
    const changed: CaptionBlock[] = [];
    for (const id of ids) {
      const block = this.byId.get(id);
      if (!block || block.state === "translated") continue;
      block.translation = "";
      block.state = "failed";
      changed.push(block);
    }
    return changed;
  }

  /** The user asked for a retranslation: back to the pending shimmer. */
  markRetranslating(id: number): CaptionBlock | null {
    const block = this.byId.get(id);
    if (!block) return null;
    block.state = "pending";
    return block;
  }

  setPinned(id: number, pinned: boolean): CaptionBlock | null {
    const block = this.byId.get(id);
    if (!block) return null;
    block.pinned = pinned;
    return block;
  }

  get(id: number): CaptionBlock | null {
    return this.byId.get(id) ?? null;
  }

  pinnedBlocks(): CaptionBlock[] {
    return this.blocks.filter((block) => block.pinned);
  }

  /** Latest block (streaming or finalized) — feeds Strip/Capsule modes. */
  latest(): CaptionBlock | null {
    return this.blocks.length > 0 ? this.blocks[this.blocks.length - 1] : null;
  }

  /**
   * The session's own (mic) finalized utterances, oldest first (#82 coaching
   * list). Client-side, no host round-trip — only finalized "me" blocks with a
   * resolved id. Bounded by the render window (#57) like the live feed; the full
   * transcript lives in the archive.
   */
  micUtterances(): (CaptionBlock & { id: number })[] {
    return this.blocks.filter(
      (block): block is CaptionBlock & { id: number } =>
        block.id !== null && block.channel === "me",
    );
  }

  private newBlock(channel: Channel): CaptionBlock {
    this.keyCounter += 1;
    return {
      key: `b${this.keyCounter}`,
      id: null,
      channel,
      state: "streaming",
      source: "",
      translation: "",
      lowConfidence: false,
      pinned: false,
      epochMs: null,
    };
  }
}
