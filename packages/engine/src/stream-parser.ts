// stream-json parser: claude -p --output-format stream-json JSONL → ParsedEvent[].
// Reference for edge cases: nexu-io/open-design apps/daemon/src/claude-stream.ts
// (Apache-2.0). Ours is far smaller — no tool_use. Ground truth is the recorded
// fixtures in test/fixtures/claude-stream/.
//
// Two CLI modes are supported from one parser:
//   - WITH --include-partial-messages: text arrives as `stream_event`
//     content_block_delta(text_delta); a trailing `assistant` wrapper repeats
//     the full text and must NOT be re-emitted.
//   - WITHOUT the flag (older builds): no stream events; the `assistant`
//     wrapper carries the only copy of the text, which we emit.
// Per-turn state disambiguates the two; a `result` event closes the turn.

import type { ParsedEvent } from "./types";

interface ContentBlock {
  type?: string;
  text?: string;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Incremental, line-oriented parser. Feed one JSONL line at a time; each call
 * returns zero or more events. Malformed/partial lines yield nothing (the live
 * stream must never crash on a stray byte). State persists across turns within
 * one process, which is exactly the lifetime of a meeting session.
 */
export class StreamJsonParser {
  /** Message id of the in-flight assistant turn (from message_start). */
  private currentMessageId: string | null = null;
  /** Whether any text_delta has been emitted for the current message. */
  private textEmittedForMessage = false;

  /** Drop any in-flight per-message state. Called when the underlying process is
   *  (re)spawned so a crash mid-message can't desync the fresh stream (#135). */
  reset(): void {
    this.currentMessageId = null;
    this.textEmittedForMessage = false;
  }

  /** Parse one raw JSONL line. */
  pushLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Malformed or half-flushed line — skip it, keep the stream alive.
      return [];
    }
    if (obj === null || typeof obj !== "object") return [];

    switch (obj.type) {
      case "stream_event":
        return this.handleStreamEvent(obj.event as Record<string, unknown> | undefined);
      case "assistant":
        return this.handleAssistant(obj.message as Record<string, unknown> | undefined);
      case "result":
        return this.handleResult(obj);
      default:
        // system/status, system/init, post_turn_summary, rate_limit_event, … —
        // not text or accounting, so nothing to emit.
        return [];
    }
  }

  private handleStreamEvent(event: Record<string, unknown> | undefined): ParsedEvent[] {
    if (!event) return [];
    switch (event.type) {
      case "message_start": {
        const message = event.message as { id?: string } | undefined;
        this.currentMessageId = message?.id ?? null;
        this.textEmittedForMessage = false;
        return [];
      }
      case "content_block_delta": {
        const delta = event.delta as { type?: string; text?: string } | undefined;
        if (delta?.type !== "text_delta" || typeof delta.text !== "string") return [];
        this.textEmittedForMessage = true;
        const index = typeof event.index === "number" ? event.index : 0;
        return [{ kind: "text_delta", index, text: delta.text }];
      }
      default:
        // content_block_start/stop, message_delta, message_stop — no payload we
        // consume (final accounting comes from the `result` event).
        return [];
    }
  }

  private handleAssistant(message: Record<string, unknown> | undefined): ParsedEvent[] {
    if (!message) return [];
    const id = typeof message.id === "string" ? message.id : null;
    // In partial-messages mode the assistant wrapper recaps text we already
    // streamed for this message — drop it to avoid doubling.
    if (id !== null && id === this.currentMessageId && this.textEmittedForMessage) {
      return [];
    }
    const content = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
    const events: ParsedEvent[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text !== "") {
        events.push({ kind: "text_delta", index: 0, text: block.text });
      }
    }
    if (events.length > 0) this.textEmittedForMessage = true;
    return events;
  }

  private handleResult(obj: Record<string, unknown>): ParsedEvent[] {
    const usage = (obj.usage as UsageBlock | undefined) ?? {};
    const events: ParsedEvent[] = [
      {
        kind: "usage",
        cumulativeCostUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      },
      {
        kind: "turn_end",
        // `is_error` is the source of truth — the subtype stays "success" even
        // on a 404 (see error-invalid-model.jsonl).
        isError: obj.is_error === true,
        apiErrorStatus: typeof obj.api_error_status === "number" ? obj.api_error_status : null,
        stopReason: typeof obj.stop_reason === "string" ? obj.stop_reason : null,
        message: typeof obj.result === "string" ? obj.result : null,
      },
    ];
    // Close the turn so the next message starts clean.
    this.currentMessageId = null;
    this.textEmittedForMessage = false;
    return events;
  }
}
