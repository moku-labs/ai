/**
 * @file anthropic prompt-gen answer reading — text, tool calls, finish
 * reasons, refusal, usage and the token counts the cost reads.
 */
/* eslint-disable unicorn/no-null -- stop_reason and the cache counts are `X | null` in the API */
import { describe, expect, it } from "vitest";
import { FlaggedProviderError } from "../../errors";
import { readAnswer, tokenCountsOf, usageOf } from "../../prompt-gen/answer";
import { answerOf } from "./fixtures";

describe("anthropic answer: text and tool calls", () => {
  it("joins the text blocks with no separator and skips thinking blocks", () => {
    const answer = readAnswer(
      answerOf([
        { type: "thinking", thinking: "private", signature: "sig" },
        { type: "text", text: "The framing " },
        { type: "redacted_thinking", data: "x" },
        { type: "text", text: "is tight." }
      ])
    );

    expect(answer.text).toBe("The framing is tight.");
  });

  it("reads tool_use blocks as tool calls, in order", () => {
    const answer = readAnswer(
      answerOf(
        [
          { type: "thinking", thinking: "Two frames.", signature: "sig" },
          { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } },
          { type: "tool_use", id: "toolu_02", name: "read_frame", input: { shot: 4 } }
        ],
        "tool_use"
      )
    );

    expect(answer.text).toBe("");
    expect(answer.toolCalls).toEqual([
      { id: "toolu_01", name: "read_frame", input: { shot: 3 } },
      { id: "toolu_02", name: "read_frame", input: { shot: 4 } }
    ]);
  });

  it("reads an empty answer as empty text, no tool calls", () => {
    const answer = readAnswer(answerOf([]));

    expect(answer).toMatchObject({ text: "", toolCalls: [], finishReason: "stop" });
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["pause_turn", "other"],
    ["model_context_window_exceeded", "other"],
    [null, "other"]
  ])("maps stop_reason %s to finishReason %s", (stopReason, finishReason) => {
    const answer = readAnswer(answerOf([{ type: "text", text: "x" }], stopReason));

    expect(answer.finishReason).toBe(finishReason);
    expect(answer.stopReason).toBe(stopReason);
  });

  it("throws a FlaggedProviderError for a refusal, without the answer text", () => {
    const refused = answerOf([{ type: "text", text: "SECRET-ANSWER" }], "refusal");

    expect(() => readAnswer(refused)).toThrow(FlaggedProviderError);
    expect(() => readAnswer(refused)).toThrow("[ai] Anthropic declined the request (refusal).");
  });
});

describe("anthropic answer: usage", () => {
  it("counts every input token as a prompt token and keeps reported cache counts", () => {
    const usage = usageOf({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 1800
    });

    expect(usage).toEqual({
      promptTokens: 2200,
      completionTokens: 20,
      cachedTokens: 1800,
      cacheWriteTokens: 300,
      cachedReadTokens: 1800,
      cachedWriteTokens: 300
    });
  });

  it("keeps a reported 0 cache count", () => {
    const usage = usageOf({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    });

    expect(usage).toMatchObject({ cachedReadTokens: 0, cachedWriteTokens: 0 });
  });

  it.each([
    ["absent", {}],
    ["null", { cache_creation_input_tokens: null, cache_read_input_tokens: null }]
  ])("leaves the optional cache keys out when the counts are %s", (_label, counts) => {
    const usage = usageOf({ input_tokens: 10, output_tokens: 5, ...counts });

    expect(usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0,
      cacheWriteTokens: 0
    });
  });
});

describe("anthropic answer: token counts for the cost", () => {
  it("splits cache writes by lifetime when the breakdown is reported", () => {
    const counts = tokenCountsOf({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 1800,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 }
    });

    expect(counts).toEqual({
      uncachedInput: 100,
      cacheWrite5m: 300,
      cacheWrite1h: 100,
      cacheRead: 1800,
      output: 20
    });
  });

  it("prices every cache write at 5 minutes without a breakdown", () => {
    const counts = tokenCountsOf({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 400,
      cache_creation: null
    });

    expect(counts).toEqual({
      uncachedInput: 100,
      cacheWrite5m: 400,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 20
    });
  });
});
