import { describe, expect, it } from "vitest";
import { ToolArgumentsError } from "../../../promptGen/contract";
import { FlaggedProviderError, TerminalProviderError } from "../../errors";
import { bundledPrices } from "../../prices";
import {
  MAX_REMEMBERED_TURNS,
  readAnswer,
  rememberTurn,
  usageCostUsd,
  usageOf
} from "../../prompt-gen/answer";
import type { OpenaiReasoningItem, OpenaiResponse } from "../../types";

/** USD per token of a per-million price. */
const PER_TOKEN = 1 / 1_000_000;

/** One reasoning item. */
const REASONING: OpenaiReasoningItem = { type: "reasoning", id: "rs_1", summary: [] };

/**
 * A function call output item.
 *
 * @param callId - The call id.
 * @param args - The JSON arguments text.
 * @returns The item.
 */
function call(callId: string, args: string): OpenaiResponse["output"][number] {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "read_frame",
    arguments: args
  };
}

describe("openai unit: prompt-gen answer (Responses)", () => {
  describe("readAnswer", () => {
    it("joins the output_text parts of every message, skipping other items", () => {
      const answer = readAnswer({
        status: "completed",
        output: [
          REASONING,
          {
            type: "message",
            content: [
              { type: "output_text", text: "A fiery " },
              { type: "output_text", text: "sunset" }
            ]
          },
          { type: "web_search_call" },
          { type: "message", content: [{ type: "output_text", text: "." }] }
        ]
      });

      expect(answer.text).toBe("A fiery sunset.");
      expect(answer.toolCalls).toEqual([]);
    });

    it("reads function calls by call_id with parsed input; empty arguments are {}", () => {
      const answer = readAnswer({
        status: "completed",
        output: [REASONING, call("call_1", '{"shot":3}'), call("call_2", "")]
      });

      expect(answer.toolCalls).toEqual([
        { id: "call_1", name: "read_frame", input: { shot: 3 } },
        { id: "call_2", name: "read_frame", input: {} }
      ]);
      expect(answer.reasoning).toEqual([REASONING]);
      expect(answer.finishReason).toBe("tool_calls");
    });

    it("throws ToolArgumentsError for arguments that are not JSON", () => {
      expect(() =>
        readAnswer({ status: "completed", output: [call("call_1", "{shot: 3")] })
      ).toThrow(ToolArgumentsError);
    });

    it.each<[string, OpenaiResponse, string]>([
      ["completed", { status: "completed", output: [] }, "stop"],
      [
        "cut by max_output_tokens",
        { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
        "length"
      ],
      [
        "incomplete for another reason",
        { status: "incomplete", incomplete_details: { reason: "other" }, output: [] },
        "other"
      ],
      ["without a status", { output: [] }, "other"]
    ])("maps an answer %s to finish reason %s", (_label, response, finishReason) => {
      expect(readAnswer(response).finishReason).toBe(finishReason);
    });

    it("flags a refusal part and an answer stopped by the content filter", () => {
      const refused: OpenaiResponse = {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }
        ]
      };
      const filtered: OpenaiResponse = {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        output: []
      };

      expect(() => readAnswer(refused)).toThrow(FlaggedProviderError);
      expect(() => readAnswer(filtered)).toThrow(FlaggedProviderError);
    });

    it("throws a terminal error for a failed answer, with the error code and no answer text", () => {
      const failed: OpenaiResponse = {
        status: "failed",
        error: { code: "server_error" },
        output: []
      };

      expect(() => readAnswer(failed)).toThrow(TerminalProviderError);
      expect(() => readAnswer(failed)).toThrow("(server_error)");
    });
  });

  describe("rememberTurn", () => {
    it("keeps a tool turn's reasoning under its first call id", () => {
      const turns = new Map<string, OpenaiReasoningItem[]>();

      rememberTurn(
        turns,
        readAnswer({
          status: "completed",
          output: [REASONING, call("call_1", "{}"), call("call_2", "{}")]
        })
      );

      expect([...turns]).toEqual([["call_1", [REASONING]]]);
    });

    it("keeps nothing for an answer without calls or without reasoning", () => {
      const turns = new Map<string, OpenaiReasoningItem[]>();

      rememberTurn(turns, readAnswer({ status: "completed", output: [REASONING] }));
      rememberTurn(turns, readAnswer({ status: "completed", output: [call("call_1", "{}")] }));

      expect(turns.size).toBe(0);
    });

    it("drops the oldest turn past 500", () => {
      const turns = new Map<string, OpenaiReasoningItem[]>();
      for (let index = 0; index <= MAX_REMEMBERED_TURNS; index += 1) {
        rememberTurn(
          turns,
          readAnswer({ status: "completed", output: [REASONING, call(`call_${index}`, "{}")] })
        );
      }

      expect(turns.size).toBe(500);
      expect(turns.has("call_0")).toBe(false);
      expect(turns.has("call_1")).toBe(true);
      expect(turns.has("call_500")).toBe(true);
    });
  });

  describe("usageOf", () => {
    it("reads input, output, cache read and cache write counts", () => {
      const usage = usageOf({
        input_tokens: 3000,
        output_tokens: 120,
        input_tokens_details: { cached_tokens: 1800, cache_write_tokens: 1000 }
      });

      expect(usage).toStrictEqual({
        promptTokens: 3000,
        completionTokens: 120,
        cachedTokens: 1800,
        cacheWriteTokens: 1000,
        cachedReadTokens: 1800,
        cachedWriteTokens: 1000
      });
    });

    it("keeps a reported 0 and leaves unreported cache keys out", () => {
      const reportedZero = usageOf({
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 0 }
      });
      const unreported = usageOf({ input_tokens: 10, output_tokens: 5, input_tokens_details: {} });

      expect(reportedZero.cachedReadTokens).toBe(0);
      expect(reportedZero).not.toHaveProperty("cachedWriteTokens");
      expect(unreported).toStrictEqual({
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 0,
        cacheWriteTokens: 0
      });
    });

    it("reports zeros when there is no usage", () => {
      expect(usageOf(undefined)).toStrictEqual({
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0
      });
    });
  });

  describe("usageCostUsd — cost from usage × bundled prices", () => {
    it("prices gpt-6-astra reads, 30-minute writes (no lifetime breakdown) and output", () => {
      const usd = usageCostUsd("gpt-6-astra", bundledPrices["gpt-6-astra"], {
        input_tokens: 3000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 1800, cache_write_tokens: 1000 }
      });

      expect(usd).toBeCloseTo((200 * 10 + 1800 * 1 + 1000 * 12.5 + 100 * 50) * PER_TOKEN, 12);
    });

    it("prices 30-minute and 12-hour writes apart from the lifetime breakdown", () => {
      const usd = usageCostUsd("gpt-6.1-sol", bundledPrices["gpt-6.1-sol"], {
        input_tokens: 1000,
        output_tokens: 0,
        input_tokens_details: {
          cache_write_tokens: 700,
          cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 400 }
        }
      });

      expect(usd).toBeCloseTo((300 * 2 + 300 * 2.5 + 400 * 5) * PER_TOKEN, 12);
    });

    it.each<[string, number, number]>([
      ["gpt-6-sol", 0.2, 10],
      ["gpt-6-luna", 0.01, 0.5],
      ["gpt-4o-mini", 0.075, 0.6],
      ["gpt-4o", 1.25, 10]
    ])("prices %s cache reads at its cached rate", (model, cachedPerM, outputPerM) => {
      const usd = usageCostUsd(model, bundledPrices[model], {
        input_tokens: 1000,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 1000 }
      });

      expect(usd).toBeCloseTo((1000 * cachedPerM + 10 * outputPerM) * PER_TOKEN, 12);
    });

    it("doubles the input-side rates and multiplies output by 1.5 above 272K input on GPT-6 only", () => {
      const usage = {
        input_tokens: 272_001,
        output_tokens: 1000,
        input_tokens_details: { cached_tokens: 1 }
      };
      const atThreshold = { ...usage, input_tokens: 272_000 };

      const long = usageCostUsd("gpt-6-astra", bundledPrices["gpt-6-astra"], usage);
      const standard = usageCostUsd("gpt-6-astra", bundledPrices["gpt-6-astra"], atThreshold);
      const gpt4o = usageCostUsd("gpt-4o", bundledPrices["gpt-4o"], {
        input_tokens: 1_000_000,
        output_tokens: 0
      });

      expect(long).toBeCloseTo(((272_000 * 10 + 1 * 1) * 2 + 1000 * 50 * 1.5) * PER_TOKEN, 9);
      expect(standard).toBeCloseTo((271_999 * 10 + 1 * 1 + 1000 * 50) * PER_TOKEN, 9);
      expect(gpt4o).toBeCloseTo(2.5, 9);
    });

    it("prices a model without prices at 0 USD", () => {
      expect(
        usageCostUsd("gpt-9-custom", undefined, { input_tokens: 1000, output_tokens: 1000 })
      ).toBe(0);
    });
  });
});
