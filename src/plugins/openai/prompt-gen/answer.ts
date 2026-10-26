/**
 * @file openai prompt-gen answer — reading a Responses answer (text, tool
 * calls, reasoning items, finish reason, refusal and failure), the typed
 * usage and the cache-aware cost it reports, and the memory of tool turns
 * whose reasoning goes back with the next request.
 */
import type { PromptGenResult, PromptGenUsage, ToolCall } from "../../promptGen/contract";
import { ToolArgumentsError } from "../../promptGen/contract";
import { FlaggedProviderError, TerminalProviderError } from "../errors";
import type { TokenSplit } from "../prices";
import { cacheAwareCostUsd } from "../prices";
import type {
  ModelPrice,
  OpenaiFunctionCall,
  OpenaiOutputItem,
  OpenaiOutputMessage,
  OpenaiReasoningItem,
  OpenaiResponse,
  OpenaiResponseUsage
} from "../types";
import { priceTierOf } from "./models";

/**
 * Tool turns whose reasoning items are remembered; the oldest is dropped first.
 *
 * @example
 * ```ts
 * // The 501st remembered turn drops the first one.
 * MAX_REMEMBERED_TURNS; // => 500
 * ```
 */
export const MAX_REMEMBERED_TURNS = 500;

/**
 * What one answer carries.
 *
 * @example
 * ```ts
 * const answer: ResponsesAnswer = { text: "", toolCalls: [{ id: "call_1", name: "read_frame", input: { shot: 3 } }], reasoning: [], finishReason: "tool_calls" };
 * ```
 */
export type ResponsesAnswer = {
  /** The `output_text` parts joined; `""` for a tool-call turn. */
  text: string;
  /** The function calls, in order. */
  toolCalls: ToolCall[];
  /** The reasoning items, in order. */
  reasoning: OpenaiReasoningItem[];
  /** Why the turn ended. */
  finishReason: PromptGenResult["finishReason"];
};

/** Status of an answer that ended normally. */
const COMPLETED = "completed";

/** Status of an answer cut short; `incomplete_details.reason` says why. */
const INCOMPLETE = "incomplete";

/** Status of an answer the model failed to produce. */
const FAILED = "failed";

/**
 * Whether an output item is an assistant message.
 *
 * @param item - One output item.
 * @returns True for a `message` item.
 * @example
 * ```ts
 * isMessage({ type: "message", content: [] }); // => true
 * ```
 */
function isMessage(item: OpenaiOutputItem): item is OpenaiOutputMessage {
  return item.type === "message";
}

/**
 * Whether an output item is a function call.
 *
 * @param item - One output item.
 * @returns True for a `function_call` item.
 * @example
 * ```ts
 * isFunctionCall({ type: "reasoning", id: "rs_1", summary: [] }); // => false
 * ```
 */
function isFunctionCall(item: OpenaiOutputItem): item is OpenaiFunctionCall {
  return item.type === "function_call";
}

/**
 * Whether an output item is a reasoning item.
 *
 * @param item - One output item.
 * @returns True for a `reasoning` item.
 * @example
 * ```ts
 * isReasoning({ type: "reasoning", id: "rs_1", summary: [] }); // => true
 * ```
 */
function isReasoning(item: OpenaiOutputItem): item is OpenaiReasoningItem {
  return item.type === "reasoning";
}

/**
 * The parsed input of a function call: `""` is `{}`, JSON text is parsed.
 *
 * @param call - The function call.
 * @returns The tool call.
 * @throws {ToolArgumentsError} When the arguments are not JSON.
 * @example
 * ```ts
 * toolCallOf({ type: "function_call", call_id: "call_1", name: "read_frame", arguments: '{"shot":3}' });
 * // => { id: "call_1", name: "read_frame", input: { shot: 3 } }
 * ```
 */
function toolCallOf(call: OpenaiFunctionCall): ToolCall {
  if (call.arguments === "") return { id: call.call_id, name: call.name, input: {} };
  try {
    return { id: call.call_id, name: call.name, input: JSON.parse(call.arguments) as unknown };
  } catch {
    throw new ToolArgumentsError(call.name, call.arguments);
  }
}

/**
 * The finish reason: function calls are `tool_calls`, an answer cut by
 * `max_output_tokens` is `length`, a completed one `stop`, anything else
 * `other`.
 *
 * @param response - The answer.
 * @param hasToolCalls - Whether the answer called tools.
 * @returns The finish reason.
 * @example
 * ```ts
 * finishReasonOf({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, false); // => "length"
 * ```
 */
function finishReasonOf(
  response: OpenaiResponse,
  hasToolCalls: boolean
): PromptGenResult["finishReason"] {
  if (hasToolCalls) return "tool_calls";
  const isCut =
    response.status === INCOMPLETE && response.incomplete_details?.reason === "max_output_tokens";
  if (isCut) return "length";
  return response.status === COMPLETED ? "stop" : "other";
}

/**
 * Reads an answer: the `output_text` parts of its messages joined, its
 * function calls, its reasoning items and the finish reason.
 *
 * @param response - The answer.
 * @returns The answer's content.
 * @throws {TerminalProviderError} When the answer failed.
 * @throws {FlaggedProviderError} For a refusal part, or an answer stopped by the content filter.
 * @throws {ToolArgumentsError} When a call's arguments are not JSON.
 * @example
 * ```ts
 * readAnswer({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }).text; // => "hi"
 * ```
 */
export function readAnswer(response: OpenaiResponse): ResponsesAnswer {
  // A failed answer has nothing to read: the request does not succeed on a retry either.
  if (response.status === FAILED) {
    throw new TerminalProviderError(
      `[ai] OpenAI failed to answer (${response.error?.code ?? "no code"}).\n  Check the request, or try another model.`
    );
  }

  // A refusal anywhere, or the content filter, flags the request: never re-queued.
  const parts = response.output.filter(item => isMessage(item)).flatMap(item => item.content);
  const isFiltered =
    response.status === INCOMPLETE && response.incomplete_details?.reason === "content_filter";
  if (isFiltered || parts.some(part => part.type === "refusal")) {
    throw new FlaggedProviderError("[ai] OpenAI declined the request (content policy).");
  }

  // Text, calls and reasoning, each in output order.
  const text = parts.map(part => (part.type === "output_text" ? part.text : "")).join("");
  const toolCalls = response.output
    .filter(item => isFunctionCall(item))
    .map(item => toolCallOf(item));
  const reasoning = response.output.filter(item => isReasoning(item));
  return {
    text,
    toolCalls,
    reasoning,
    finishReason: finishReasonOf(response, toolCalls.length > 0)
  };
}

/**
 * Remembers the reasoning items of a tool-call answer under its first call
 * id, so the next request sends them back before the calls. An answer
 * without calls or without reasoning changes nothing; past
 * {@link MAX_REMEMBERED_TURNS} the oldest turn is dropped.
 *
 * @param turns - `state.turns`.
 * @param answer - The answer read.
 * @example
 * ```ts
 * rememberTurn(new Map(), { text: "", toolCalls: [{ id: "call_1", name: "t", input: {} }], reasoning: [{ type: "reasoning", id: "rs_1", summary: [] }], finishReason: "tool_calls" });
 * // the map now holds "call_1" => [the reasoning item]
 * ```
 */
export function rememberTurn(
  turns: Map<string, OpenaiReasoningItem[]>,
  answer: ResponsesAnswer
): void {
  const firstCallId = answer.toolCalls[0]?.id;
  if (firstCallId === undefined || answer.reasoning.length === 0) return;

  // Newest last: a re-remembered id moves to the end of the map's order.
  turns.delete(firstCallId);
  turns.set(firstCallId, answer.reasoning);
  for (const oldest of turns.keys()) {
    if (turns.size <= MAX_REMEMBERED_TURNS) break;
    turns.delete(oldest);
  }
}

/**
 * A reported count: a finite number, else undefined (proxies may send null).
 *
 * @param value - The usage field.
 * @returns The count, or undefined.
 * @example
 * ```ts
 * countOf(Number.NaN); // => undefined
 * ```
 */
function countOf(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The typed usage of an answer. `promptTokens` is all input tokens. Counts
 * OpenAI does not report are 0; `cachedReadTokens` and `cachedWriteTokens`
 * are set only when the count is in the answer (a reported 0 is kept).
 *
 * @param usage - The answer's usage, if reported.
 * @returns The usage.
 * @example
 * ```ts
 * usageOf({ input_tokens: 2400, output_tokens: 120, input_tokens_details: { cached_tokens: 1800 } });
 * // => { promptTokens: 2400, completionTokens: 120, cachedTokens: 1800, cacheWriteTokens: 0, cachedReadTokens: 1800 }
 * ```
 */
export function usageOf(usage: OpenaiResponseUsage | undefined): PromptGenUsage {
  const reads = countOf(usage?.input_tokens_details?.cached_tokens);
  const writes = countOf(usage?.input_tokens_details?.cache_write_tokens);

  // The counts every provider has: 0 when OpenAI does not report one.
  const result: PromptGenUsage = {
    promptTokens: countOf(usage?.input_tokens) ?? 0,
    completionTokens: countOf(usage?.output_tokens) ?? 0,
    cachedTokens: reads ?? 0,
    cacheWriteTokens: writes ?? 0
  };

  // A reported cache count is kept, 0 included; an unreported one leaves the key out.
  if (reads !== undefined) result.cachedReadTokens = reads;
  if (writes !== undefined) result.cachedWriteTokens = writes;
  return result;
}

/**
 * The token split of a reported usage: cache reads, 30-minute and 12-hour
 * writes (no lifetime breakdown: every write is a 30-minute write), the
 * rest of the input uncached, and the output.
 *
 * @param usage - The answer's usage.
 * @returns The split.
 * @example
 * ```ts
 * tokenSplitOf({ input_tokens: 3000, output_tokens: 100, input_tokens_details: { cached_tokens: 1800, cache_write_tokens: 1000 } });
 * // => { uncached: 200, cacheReads: 1800, cacheWrites30m: 1000, cacheWrites12h: 0, output: 100 }
 * ```
 */
function tokenSplitOf(usage: OpenaiResponseUsage): TokenSplit {
  const details = usage.input_tokens_details;
  const lifetimes = details?.cache_write_tokens_details;
  const input = countOf(usage.input_tokens) ?? 0;
  const cacheReads = countOf(details?.cached_tokens) ?? 0;
  const writes = countOf(details?.cache_write_tokens) ?? 0;

  // A 12h count splits the writes; the 30m count is what the 12h count leaves.
  const cacheWrites12h = countOf(lifetimes?.ttl_12h_tokens) ?? 0;
  const cacheWrites30m = countOf(lifetimes?.ttl_30m_tokens) ?? Math.max(0, writes - cacheWrites12h);
  return {
    uncached: Math.max(0, input - cacheReads - cacheWrites30m - cacheWrites12h),
    cacheReads,
    cacheWrites30m,
    cacheWrites12h,
    output: countOf(usage.output_tokens) ?? 0
  };
}

/**
 * The cost of a reported usage at the model's prices: uncached input, cache
 * reads, 30m and 12h writes and output, each at its rate; above 272K input a
 * GPT-6 model pays the long-context tier.
 *
 * @param model - The OpenAI model id.
 * @param price - The model's prices, if any (none: 0 USD).
 * @param usage - The answer's usage.
 * @returns The cost in US dollars.
 * @example
 * ```ts
 * usageCostUsd("gpt-6-astra", { inputPerM: 10, outputPerM: 50 }, { input_tokens: 1_000_000, output_tokens: 0 }); // => 20
 * ```
 */
export function usageCostUsd(
  model: string,
  price: Partial<ModelPrice> | undefined,
  usage: OpenaiResponseUsage
): number {
  const tier = priceTierOf(model, countOf(usage.input_tokens) ?? 0);
  return cacheAwareCostUsd(price, tokenSplitOf(usage), tier);
}
