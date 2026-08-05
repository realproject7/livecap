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

/**
 * Units a channel may have awaiting a translation result at once (#195).
 *
 * Past this, a fast speaker would run the turn count away — the cost guard the
 * ticket makes non-negotiable. Two lets one unit be in flight while the next
 * settles, without building a backlog.
 */
export const MAX_UNITS_IN_FLIGHT_PER_CHANNEL = 2;

/** A unit dispatched for early translation, awaiting its result. */
interface PendingUnit {
  id: number;
  /** Source text, kept so a failed unit can be re-translated in the tail. */
  source: string;
  target: string | null;
  /** Failed BEFORE its utterance finalized: the finalize tail re-translates it. */
  failed: boolean;
  /** Failed AFTER finalize, and a retry turn was dispatched for it. */
  retried: boolean;
  /** Retried and failed again: stop waiting on it, or it wedges the line. */
  abandoned: boolean;
}

/**
 * A span whose early translation failed after its utterance had already
 * finalized, so the tail that would have carried it is already dispatched.
 * The caller must re-translate `source` under the same unit id.
 */
export interface UnitRetry {
  captionId: number;
  source: string;
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

/** How a failed batch's ids split between the two paths that must handle them. */
export interface FailureRouting {
  /** Spans to re-translate under their own id (post-finalize unit failures). */
  retries: { id: number; text: string }[];
  /** Ids that are captions, not units — the caller's existing failure path. */
  captionFailures: number[];
}

/**
 * Split a failed batch into unit failures and caption failures (#195).
 *
 * A failed UNIT is not a failed caption: routing one through the caption path
 * records an empty translation for that span, and assembly then drops the words
 * the speaker actually said. Extracted from `HostSession` — which has no
 * headless harness — so this partition, and the retries it produces, are
 * assertable rather than taken on trust.
 */
export function routeFailures(
  ids: number[],
  assembler: StreamingAssembler,
  isUnit: (id: number) => boolean,
): FailureRouting {
  const routing: FailureRouting = { retries: [], captionFailures: [] };
  for (const id of ids) {
    if (!isUnit(id)) {
      routing.captionFailures.push(id);
      continue;
    }
    const retry = assembler.noteUnitFailed(id);
    if (retry) routing.retries.push({ id, text: retry.source });
  }
  return routing;
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
   * Units on this channel still awaiting a result (#195 backpressure).
   *
   * Counts BOTH the current utterance's pending units and units carried into
   * `awaiting` by a finalize that outran them. Counting only the former let the
   * cap escape across utterance boundaries: finalize moves unresolved units out
   * of `pending`, so the next utterance started from zero and could admit a full
   * cap's worth while the previous utterance's units were still outstanding.
   * The guard the ticket asks for is per channel, not per utterance.
   *
   * An abandoned unit is excluded — its result will never arrive, so counting it
   * would hold a slot shut for the rest of the session.
   *
   * The count lives here rather than in the caller because this class already
   * owns unit lifecycle — a parallel tally in the session would be a second
   * source of truth that can drift, and the drift would be invisible until a
   * channel silently stopped streaming.
   */
  inFlightCount(channel: string): number {
    const outstanding = (u: PendingUnit): boolean => u.target === null && !u.failed && !u.abandoned;
    let count = (this.pending.get(channel) ?? []).filter(outstanding).length;
    for (const entry of this.awaiting.values()) {
      if (entry.channel !== channel) continue;
      count += entry.units.filter(outstanding).length;
    }
    return count;
  }

  /**
   * Decide whether a released span may be dispatched, and record it either way.
   *
   * Returns false when the channel is at {@link MAX_UNITS_IN_FLIGHT_PER_CHANNEL}.
   * The span is still recorded — as a failed unit, so its source folds into the
   * finalize tail. It cannot merely be dropped: the Rust tracker advanced its
   * released-words watermark when it emitted this span and has no way to learn
   * the host declined it, so `pretranslatedWords` at finalize would count the
   * span as already translated and the tail would begin after it. The words
   * would be archived as source and never translated at all.
   *
   * The decision lives here, with the count it depends on and the failed-unit
   * mechanism it reuses, so the cap and its consequence cannot drift apart.
   */
  admitUnit(channel: string, id: number, source: string): boolean {
    if (this.inFlightCount(channel) >= MAX_UNITS_IN_FLIGHT_PER_CHANNEL) {
      this.noteUnit(channel, id, source);
      this.noteUnitFailed(id);
      return false;
    }
    this.noteUnit(channel, id, source);
    return true;
  }

  /** Record a unit dispatched for early translation. */
  noteUnit(channel: string, id: number, source: string): void {
    const list = this.pending.get(channel) ?? [];
    list.push({ id, source, target: null, failed: false, retried: false, abandoned: false });
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
   * The unit is NOT dropped: its source text is re-translated, so a failed early
   * translation costs a retry rather than a hole in the assembled line. Losing a
   * span silently would be worse than paying for it twice, and this is the one
   * place the never-translate-twice rule yields — deliberately, because the
   * alternative is a line that omits what the speaker said.
   *
   * WHEN the failure lands decides how that retry happens, and the two cases are
   * not interchangeable:
   * - **Before finalize** — the unit is still pending, so its source folds into
   *   the tail and the finalize turn re-translates it. Returns null.
   * - **After finalize** — the tail has already been dispatched without this
   *   span, so folding is no longer possible. Returns a {@link UnitRetry} the
   *   caller must dispatch under the SAME unit id; its result arrives through
   *   {@link noteUnitResult} and fills the slot in place.
   *
   * A second failure abandons the unit rather than retrying forever. That drops
   * the span from the *target*, but the caller archives the full source text
   * regardless, so the utterance is still recorded and the existing retranslate
   * path can repair the target.
   */
  noteUnitFailed(id: number): UnitRetry | null {
    for (const list of this.pending.values()) {
      for (const unit of list) {
        if (unit.id === id) {
          unit.failed = true;
          return null;
        }
      }
    }
    for (const [captionId, entry] of this.awaiting) {
      for (const unit of entry.units) {
        if (unit.id !== id) continue;
        if (unit.retried) {
          unit.abandoned = true;
          return null;
        }
        unit.retried = true;
        return { captionId, source: unit.source };
      }
    }
    return null;
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
    // An abandoned unit counts as settled. It contributes nothing, but waiting
    // on a span that will never arrive would hold the whole line until the drain
    // deadline — a wedged line is worse than a short one.
    const unitsIn = entry.units.every((u) => u.target !== null || u.abandoned);
    const tailIn = entry.tailText === "" || entry.tailTarget !== null;
    return unitsIn && tailIn;
  }

  private forEachUnit(visit: (unit: PendingUnit) => void): void {
    for (const list of this.pending.values()) for (const unit of list) visit(unit);
    for (const entry of this.awaiting.values()) for (const unit of entry.units) visit(unit);
  }
}
