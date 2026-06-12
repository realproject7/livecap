import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { StreamJsonParser } from "../src/stream-parser";
import type { ParsedEvent } from "../src/types";

function fixture(name: string): string[] {
  const url = new URL(`./fixtures/claude-stream/${name}`, import.meta.url);
  return readFileSync(url, "utf8").split("\n");
}

function parseAll(lines: string[]): ParsedEvent[] {
  const parser = new StreamJsonParser();
  return lines.flatMap((line) => parser.pushLine(line));
}

/** Reconstruct per-turn text by concatenating text_deltas between turn_ends. */
function turnsOf(events: ParsedEvent[]): { text: string; isError: boolean; cost: number }[] {
  const turns: { text: string; isError: boolean; cost: number }[] = [];
  let text = "";
  let cost = 0;
  for (const ev of events) {
    if (ev.kind === "text_delta") text += ev.text;
    else if (ev.kind === "usage") cost = ev.cumulativeCostUsd;
    else if (ev.kind === "turn_end") {
      turns.push({ text, isError: ev.isError, cost });
      text = "";
    }
  }
  return turns;
}

describe("StreamJsonParser — with --include-partial-messages", () => {
  const events = parseAll(fixture("session-with-partials.jsonl"));

  it("reconstructs text from content_block_delta without doubling the assistant recap", () => {
    const turns = turnsOf(events);
    expect(turns).toHaveLength(20);
    // The first turn's translation is known from the recording.
    expect(turns[0]?.text).toBe(
      "저와 제 동료들은 미국 국민의 이익을 위해 최대 고용과 물가 안정이라는 이중 위임 목표를 달성하는 데 전적으로 집중하고 있습니다.",
    );
  });

  it("emits cumulative cost on every turn", () => {
    const usage = events.filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(20);
    expect(usage[0]).toMatchObject({ kind: "usage", cumulativeCostUsd: 0.001216, outputTokens: 76 });
  });

  it("ignores system/status, post_turn_summary and rate_limit_event noise", () => {
    // Those event types never produce a ParsedEvent — only text/usage/turn_end.
    const kinds = new Set(events.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(["text_delta", "turn_end", "usage"].sort());
  });
});

describe("StreamJsonParser — without partial messages (older-CLI path)", () => {
  const events = parseAll(fixture("session-without-partials.jsonl"));

  it("reconstructs text from the assistant wrapper when there are no stream events", () => {
    const turns = turnsOf(events);
    expect(turns).toHaveLength(20);
    expect(turns.every((t) => t.text.length > 0)).toBe(true);
    expect(turns.every((t) => !t.isError)).toBe(true);
  });

  it("produces exactly one text emission per turn (no delta/recap doubling)", () => {
    const textEvents = events.filter((e) => e.kind === "text_delta");
    expect(textEvents).toHaveLength(20);
  });
});

describe("StreamJsonParser — error path", () => {
  it("flags is_error and surfaces api_error_status even when subtype is success", () => {
    const events = parseAll(fixture("error-invalid-model.jsonl"));
    const turnEnd = events.find((e) => e.kind === "turn_end");
    expect(turnEnd).toMatchObject({ kind: "turn_end", isError: true, apiErrorStatus: 404 });
  });
});

describe("StreamJsonParser — robustness", () => {
  it("skips blank and malformed lines without throwing", () => {
    const parser = new StreamJsonParser();
    const events = [
      "",
      "   ",
      "{not json",
      '{"type":"system","subtype":"init"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}}}',
      "}{",
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.5,"stop_reason":"end_turn","result":"안녕","usage":{"input_tokens":10,"output_tokens":2}}',
    ].flatMap((line) => parser.pushLine(line));

    expect(events.filter((e) => e.kind === "text_delta")).toEqual([
      { kind: "text_delta", index: 0, text: "안녕" },
    ]);
    expect(events.find((e) => e.kind === "usage")).toMatchObject({ cumulativeCostUsd: 0.5 });
    expect(events.find((e) => e.kind === "turn_end")).toMatchObject({ isError: false });
  });

  it("does not emit a text_delta for an empty assistant text block", () => {
    const parser = new StreamJsonParser();
    const events = parser.pushLine(
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":""}]}}',
    );
    expect(events).toEqual([]);
  });

  it("text_delta.text carries the verbatim translation stream — content-bearing, never log (#49)", () => {
    // Documents the hazard the type annotation warns about: a direct parser
    // consumer that logs text_delta events would leak the whole translation
    // stream, not just error text.
    const parser = new StreamJsonParser();
    const events = parser.pushLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"SECRET caption translation"}}}',
    );
    const delta = events.find((e) => e.kind === "text_delta");
    expect(delta?.kind).toBe("text_delta");
    expect(delta && "text" in delta ? delta.text : null).toBe("SECRET caption translation");
  });

  it("turn_end.message carries the model result verbatim — content-bearing, never log (#41)", () => {
    // Documents the hazard the type annotation warns about: a direct parser
    // consumer that logs turn_end.message would leak transcript-derived content.
    const parser = new StreamJsonParser();
    const events = parser.pushLine(
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.1,"stop_reason":"end_turn","result":"SECRET transcript content here","usage":{"input_tokens":1,"output_tokens":1}}',
    );
    const turnEnd = events.find((e) => e.kind === "turn_end");
    expect(turnEnd?.kind).toBe("turn_end");
    expect(turnEnd && "message" in turnEnd ? turnEnd.message : null).toBe(
      "SECRET transcript content here",
    );
  });
});
