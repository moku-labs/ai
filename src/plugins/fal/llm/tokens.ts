/**
 * @file fal LLM cost — token estimate, estimate USD, and the actual cost of
 * one answer with where it came from (fal's reported cost, its token counts,
 * or the character rule).
 */
import type { PromptGenRequest } from "../../promptGen/contract";
import { readNumber } from "../client/http";
import { imagePartsOf, inputTextOf } from "./conversation";
import type { LlmPrice } from "./prices";

/**
 * Actual cost of one answer and where it came from.
 *
 * @example
 * ```ts
 * const cost: LlmCost = { usd: 0.0002, source: "usage" };
 * ```
 */
export type LlmCost = {
  /** USD, rounded to micro-dollars. */
  usd: number;
  /** `usage`: fal's reported cost; `tokens`: its token counts × price; `chars`: the character rule. */
  source: "usage" | "tokens" | "chars";
};

/**
 * What the cost reads off an answer: fal's untrusted `usage` object and the text.
 *
 * @example
 * ```ts
 * const answer: CostedAnswer = { usage: { prompt_tokens: 10, completion_tokens: 5 }, text: "hi" };
 * ```
 */
export type CostedAnswer = {
  /** The `usage` field of the answer, untrusted JSON. */
  usage: unknown;
  /** The answer text. */
  text: string;
};

/** ASCII characters per token in the estimate. */
const ASCII_CHARS_PER_TOKEN = 4;

/** Estimated input tokens of one image part of a message. */
const IMAGE_PART_TOKENS = 1000;

/** First code point that counts as one token on its own. */
const FIRST_NON_ASCII = 0x80;

/** Tokens per price unit (prices are USD per million tokens). */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Cost precision: micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Rounds USD to micro-dollars.
 *
 * @param usd - Unrounded USD.
 * @returns Rounded USD.
 * @example
 * ```ts
 * round6(0.1 + 0.2); // => 0.3
 * ```
 */
function round6(usd: number): number {
  return Math.round(usd * MICRO_DOLLARS) / MICRO_DOLLARS;
}

/**
 * Estimated tokens of a text: one per 4 ASCII characters (rounded up), plus
 * one per other code point.
 *
 * @param text - Any text.
 * @returns Token estimate.
 * @example
 * ```ts
 * estimateTokens("ab日本"); // => 3
 * ```
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_NON_ASCII) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + other;
}

/**
 * USD of a token count at a model's price.
 *
 * @param price - USD per million input and output tokens.
 * @param inputTokens - Input tokens.
 * @param outputTokens - Output tokens.
 * @returns USD, rounded to micro-dollars.
 * @example
 * ```ts
 * estimateUsd({ inputPerM: 4, outputPerM: 20 }, 1000, 500); // => 0.014
 * ```
 */
export function estimateUsd(price: LlmPrice, inputTokens: number, outputTokens: number): number {
  const input = (inputTokens * price.inputPerM) / TOKENS_PER_PRICE_UNIT;
  const output = (outputTokens * price.outputPerM) / TOKENS_PER_PRICE_UNIT;
  return round6(input + output);
}

/**
 * Estimated input tokens of a request. Without messages: the system and the
 * prompt tokens, as before. With messages: the tokens of all the text sent
 * (system, text parts, assistant texts, tool-call argument JSON) plus
 * {@link IMAGE_PART_TOKENS} per image part.
 *
 * @param request - The prompt-gen request.
 * @returns Token estimate.
 * @example
 * ```ts
 * estimateInputTokens({ prompt: "abcd", system: "abcdefgh" }); // => 3
 * estimateInputTokens({ prompt: "", messages: [{ role: "user", content: [{ type: "text", text: "abcd" }, { type: "image", path: "a.png", mimeType: "image/png", hash: "h" }] }] }); // => 1001
 * ```
 */
export function estimateInputTokens(request: PromptGenRequest): number {
  if (request.messages === undefined) {
    return estimateTokens(request.system ?? "") + estimateTokens(request.prompt);
  }
  const images = imagePartsOf(request.messages).length;
  return estimateTokens(inputTextOf(request)) + IMAGE_PART_TOKENS * images;
}

/**
 * Actual cost of an answer: `usage.cost` when finite and ≥ 0, else the
 * reported token counts × price, else the character rule on what was sent
 * (system + prompt, or the text of all messages) and the answer text.
 *
 * @param answer - The answer's usage and text.
 * @param price - The model's price.
 * @param request - The request (system, prompt and messages).
 * @returns USD and its source.
 * @example
 * ```ts
 * actualUsd({ usage: { cost: 0.0123 }, text: "x" }, { inputPerM: 4, outputPerM: 20 }, { prompt: "p" }); // => { usd: 0.0123, source: "usage" }
 * ```
 */
export function actualUsd(
  answer: CostedAnswer,
  price: LlmPrice,
  request: Pick<PromptGenRequest, "system" | "prompt" | "messages">
): LlmCost {
  // fal's own cost wins when it reports one.
  const cost = readNumber(answer.usage, "cost");
  if (cost !== undefined && cost >= 0) return { usd: round6(cost), source: "usage" };

  // Then its token counts, at the table price.
  const promptTokens = readNumber(answer.usage, "prompt_tokens");
  const completionTokens = readNumber(answer.usage, "completion_tokens");
  if (promptTokens !== undefined && completionTokens !== undefined) {
    return { usd: estimateUsd(price, promptTokens, completionTokens), source: "tokens" };
  }

  // Else the character rule on what was sent and what came back.
  const inputTokens = estimateTokens(inputTextOf(request));
  const outputTokens = estimateTokens(answer.text);
  return { usd: estimateUsd(price, inputTokens, outputTokens), source: "chars" };
}

/**
 * The token counts fal reported, for the result meta and the log.
 *
 * @param usage - The answer's `usage` field.
 * @returns Prompt and completion tokens, each undefined when absent.
 * @example
 * ```ts
 * reportedTokens({ prompt_tokens: 10, completion_tokens: 5 }); // => { promptTokens: 10, completionTokens: 5 }
 * ```
 */
export function reportedTokens(usage: unknown): {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
} {
  return {
    promptTokens: readNumber(usage, "prompt_tokens"),
    completionTokens: readNumber(usage, "completion_tokens")
  };
}
