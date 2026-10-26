/**
 * @file anthropic prompt-gen answer — the reading of a final message: text,
 * tool calls, finish reason (a refusal is flagged), the prompt-gen usage,
 * and the token counts the cost is priced from.
 */
import type { PromptGenResult, PromptGenUsage, ToolCall } from "../../promptGen/contract";
import { FlaggedProviderError } from "../errors";
import type { TokenCounts } from "../prices";
import type { AnthropicMessage, AnthropicUsage } from "../types";

/**
 * What one final message carries for the result.
 *
 * @example
 * ```ts
 * const answer: AnthropicAnswer = { text: "", toolCalls: [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }], finishReason: "tool_calls", stopReason: "tool_use" };
 * ```
 */
export type AnthropicAnswer = {
  /** The text blocks joined; `""` for a tool-call turn. */
  text: string;
  /** The tool_use blocks as tool calls, in order. */
  toolCalls: ToolCall[];
  /** Why the turn ended, as the result carries it. */
  finishReason: PromptGenResult["finishReason"];
  /** The API's own stop reason, for the meta. */
  stopReason: string | null;
};

/** `stop_reason` → finish reason; any other is `"other"`. */
const FINISH_REASONS: ReadonlyMap<string, PromptGenResult["finishReason"]> = new Map([
  ["end_turn", "stop"],
  ["stop_sequence", "stop"],
  ["tool_use", "tool_calls"],
  ["max_tokens", "length"]
]);

/** `stop_reason` of a refused request. */
const REFUSAL = "refusal";

/**
 * A reported count, or undefined when the API sent none (absent or null).
 *
 * @param value - A usage count.
 * @returns The count, or undefined.
 * @example
 * ```ts
 * reportedCount(null); // => undefined
 * ```
 */
function reportedCount(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Reads a final message: the text blocks joined with `""`, the tool_use
 * blocks as tool calls, the finish reason.
 *
 * @param message - The final message.
 * @returns The answer.
 * @throws {FlaggedProviderError} For `stop_reason: "refusal"`, with a fixed message.
 * @example
 * ```ts
 * readAnswer({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }).finishReason; // => "stop"
 * ```
 */
export function readAnswer(message: AnthropicMessage): AnthropicAnswer {
  if (message.stop_reason === REFUSAL) {
    throw new FlaggedProviderError("[ai] Anthropic declined the request (refusal).");
  }

  const text = message.content
    .flatMap(block => (block.type === "text" ? [block.text] : []))
    .join("");
  const toolCalls = message.content.flatMap((block): ToolCall[] =>
    block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : []
  );
  const stopReason = message.stop_reason;
  const finishReason =
    (stopReason === null ? undefined : FINISH_REASONS.get(stopReason)) ?? "other";
  return { text, toolCalls, finishReason, stopReason };
}

/**
 * The prompt-gen usage of an answer. Prompt tokens are every input token:
 * uncached, written to and read from the cache. The two optional cache keys
 * are set only when the API reported the count (a reported 0 is kept).
 *
 * @param usage - The answer's usage.
 * @returns The usage.
 * @example
 * ```ts
 * usageOf({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1800 }); // => { promptTokens: 1900, completionTokens: 20, cachedTokens: 1800, cacheWriteTokens: 0, cachedReadTokens: 1800 }
 * ```
 */
export function usageOf(usage: AnthropicUsage): PromptGenUsage {
  const writes = reportedCount(usage.cache_creation_input_tokens);
  const reads = reportedCount(usage.cache_read_input_tokens);

  const result: PromptGenUsage = {
    promptTokens: usage.input_tokens + (writes ?? 0) + (reads ?? 0),
    completionTokens: usage.output_tokens,
    cachedTokens: reads ?? 0,
    cacheWriteTokens: writes ?? 0
  };

  // A reported cache count is kept, 0 included; an unreported one leaves the key out.
  if (reads !== undefined) result.cachedReadTokens = reads;
  if (writes !== undefined) result.cachedWriteTokens = writes;
  return result;
}

/**
 * The token counts an answer is priced from. Cache writes split by
 * lifetime when the API sends the breakdown; without it every write is
 * priced at 5 minutes.
 *
 * @param usage - The answer's usage.
 * @returns The counts.
 * @example
 * ```ts
 * tokenCountsOf({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 40 }); // => { uncachedInput: 10, cacheWrite5m: 40, cacheWrite1h: 0, cacheRead: 0, output: 5 }
 * ```
 */
export function tokenCountsOf(usage: AnthropicUsage): TokenCounts {
  const writes = reportedCount(usage.cache_creation_input_tokens) ?? 0;
  const breakdown = usage.cache_creation;
  const hasBreakdown = breakdown !== null && breakdown !== undefined;

  return {
    uncachedInput: usage.input_tokens,
    cacheWrite5m: hasBreakdown ? breakdown.ephemeral_5m_input_tokens : writes,
    cacheWrite1h: hasBreakdown ? breakdown.ephemeral_1h_input_tokens : 0,
    cacheRead: reportedCount(usage.cache_read_input_tokens) ?? 0,
    output: usage.output_tokens
  };
}
