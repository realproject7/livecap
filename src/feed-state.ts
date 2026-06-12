// Pure caption-feed state (#11): maps the bridge event stream onto the five
// caption-block states of the design system (design/system/design-system.png):
// 1 streaming partial · 2 finalized/translation-pending · 3 translated ·
// 4 low-confidence (?) · 5 pinned. No DOM, no Tauri — unit-tested headless.

import type { CaptionBridgeEvent, Channel, TranslationItem } from "./protocol";

export type BlockState = "streaming" | "pending" | "translated" | "failed";

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

  /**
   * Apply a caption event. A finalized event REUSES the channel's streaming
   * block (text settles in place — no layout jump, rule 4); returns the
   * affected block.
   */
  applyCaption(event: CaptionBridgeEvent): CaptionBlock {
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

  /** Most recent finalized source lines, oldest first (reply-chip context). */
  recentSources(count: number): string[] {
    return this.blocks
      .filter((block) => block.id !== null)
      .slice(-count)
      .map((block) => block.source);
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
