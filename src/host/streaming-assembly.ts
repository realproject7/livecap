// Assembly of streamed translation units into one finalized line (#195).
//
// With a streaming mode on, an utterance is translated in pieces: settled
// prefixes go out early as units, and the finalized utterance contributes only
// its untranslated tail. The archive still stores exactly ONE line per
// utterance with one target — #137's 1:1 mapping is a contract, not an
// implementation detail — so something has to put the pieces back together.
//
// That is this module, and it is pure so the ordering can be tested without a
// live engine. The hard part is not concatenation; it is that a unit's
// translation may still be in flight when the utterance finalizes, so assembly
// has to be able to WAIT, and it has to degrade safely when a piece never
// arrives.

/** A unit dispatched for early translation, awaiting its result. */
interface PendingUnit {
  id: number;
  /** Source text, kept so a failed unit can be re-translated in the tail. */
  source: string;
  target: string | null;
  failed: boolean;
}

/** What the caller should do with a finalized utterance. */
export interface FinalizePlan {
  /** Text still needing translation — "" when the units covered everything. */
  tailText: string;
  /**
   * Whether assembly can complete immediately. False when units are still in
   * flight; the caller must call {@link StreamingAssembler.tryAssemble} again
   * as unit results arrive.
   */
  ready: boolean;
}

/**
 * Per-channel assembly of streamed units plus a finalized tail.
 *
 * One instance per session; channels are kept separate internally because mic
 * and system utterances interleave and must never contribute to each other's
 * lines.
 */
export class StreamingAssembler {
  /** Units dispatched for the CURRENT utterance of each channel, in order. */
  private readonly pending = new Map<string, PendingUnit[]>();
  /** Finalized utterances waiting on their units and/or their tail. */
  private readonly awaiting = new Map<
    number,
    { channel: string; units: PendingUnit[]; tailText: string; tailTarget: string | null }
  >();

  /**
   * Units dispatched for this channel's current utterance that are still
   * awaiting a result (#195 backpressure).
   *
   * The count lives here rather than in the caller because this class already
   * owns unit lifecycle — a parallel tally in the session would be a second
   * source of truth that can drift, and the drift would be invisible until a
   * channel silently stopped streaming.
   */
  inFlightCount(channel: string): number {
    const list = this.pending.get(channel) ?? [];
    return list.filter((u) => u.target === null && !u.failed).length;
  }

  /** Record a unit dispatched for early translation. */
  noteUnit(channel: string, id: number, source: string): void {
    const list = this.pending.get(channel) ?? [];
    list.push({ id, source, target: null, failed: false });
    this.pending.set(channel, list);
  }

  /** Record a unit's translation result. */
  noteUnitResult(id: number, target: string): void {
    this.forEachUnit((unit) => {
      if (unit.id === id) unit.target = target;
    });
  }

  /**
   * Record that a unit's translation failed.
   *
   * The unit is NOT dropped: its source text is folded back into the tail, so a
   * failed early translation costs a retry rather than a hole in the archived
   * line. Losing a span silently would be worse than paying for it twice, and
   * this is the one place the never-translate-twice rule yields — deliberately,
   * because the alternative is an archive that omits what the speaker said.
   */
  noteUnitFailed(id: number): void {
    this.forEachUnit((unit) => {
      if (unit.id === id) unit.failed = true;
    });
  }

  /**
   * Begin assembling a finalized utterance.
   *
   * `fullText` is archived verbatim by the caller — this only decides what still
   * needs translating. Any failed unit's source is prepended to the tail so it
   * is retried as part of the finalize turn.
   */
  onFinalized(channel: string, captionId: number, fullText: string, pretranslatedWords: number): FinalizePlan {
    const units = this.pending.get(channel) ?? [];
    this.pending.delete(channel);

    const words = fullText.split(/\s+/).filter((w) => w !== "");
    // Clamp: a recognizer that revised text downward at finalize must never
    // cause real words to be skipped as "already translated".
    const covered = Math.max(0, Math.min(pretranslatedWords, words.length));
    let tailText = words.slice(covered).join(" ");

    const failed = units.filter((u) => u.failed);
    if (failed.length > 0) {
      // Re-translate the failed spans with the tail, in spoken order.
      tailText = [...failed.map((u) => u.source), tailText].filter((t) => t !== "").join(" ");
    }

    const live = units.filter((u) => !u.failed);
    this.awaiting.set(captionId, { channel, units: live, tailText, tailTarget: null });
    return { tailText, ready: this.isReady(captionId) };
  }

  /** Record the finalize turn's translation of the tail. */
  noteTailResult(captionId: number, target: string): void {
    const entry = this.awaiting.get(captionId);
    if (entry) entry.tailTarget = target;
  }

  /**
   * The assembled target, or null while pieces are outstanding.
   *
   * Consumes the entry when it returns a string, so a caller cannot archive the
   * same line twice.
   */
  tryAssemble(captionId: number): string | null {
    if (!this.isReady(captionId)) return null;
    const entry = this.awaiting.get(captionId);
    if (!entry) return null;
    this.awaiting.delete(captionId);
    const parts = entry.units.map((u) => u.target ?? "");
    if (entry.tailText !== "") parts.push(entry.tailTarget ?? "");
    return parts.filter((p) => p !== "").join(" ");
  }

  /**
   * Give up waiting and assemble from whatever arrived.
   *
   * The caller uses this on a drain deadline so a wedged unit can never hold an
   * archive line hostage — a partial line is recoverable, a lost one is not.
   */
  forceAssemble(captionId: number): string | null {
    const entry = this.awaiting.get(captionId);
    if (!entry) return null;
    this.awaiting.delete(captionId);
    const parts = entry.units.map((u) => u.target ?? "");
    if (entry.tailTarget !== null) parts.push(entry.tailTarget);
    const assembled = parts.filter((p) => p !== "").join(" ");
    return assembled === "" ? null : assembled;
  }

  /** Drop a channel's in-flight units — a dropped partial (#56/#62) cancels
   *  its utterance, so its units must not attach to the next one. */
  dropChannel(channel: string): void {
    this.pending.delete(channel);
  }

  /** Whether every piece of a finalized utterance has arrived. */
  private isReady(captionId: number): boolean {
    const entry = this.awaiting.get(captionId);
    if (!entry) return false;
    const unitsIn = entry.units.every((u) => u.target !== null);
    const tailIn = entry.tailText === "" || entry.tailTarget !== null;
    return unitsIn && tailIn;
  }

  private forEachUnit(visit: (unit: PendingUnit) => void): void {
    for (const list of this.pending.values()) for (const unit of list) visit(unit);
    for (const entry of this.awaiting.values()) for (const unit of entry.units) visit(unit);
  }
}
