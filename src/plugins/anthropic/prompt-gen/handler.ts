/**
 * @file anthropic prompt-gen handler — implements the task-owned prompt-gen
 * contract over the Messages API: plan, key, images, body, one streamed
 * request, answer, cost from usage. A tool turn's blocks are remembered and
 * go back unchanged with that turn on the next request.
 */
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../promptGen/contract";
import { getAnthropicClient, redactedFailureOf, requestMessage } from "../client";
import { readImageBlocks } from "../images";
import type { TokenCounts } from "../prices";
import { costUsd } from "../prices";
import { rememberTurn } from "../state";
import type { AnthropicContext, AnthropicUsage } from "../types";
import type { AnthropicAnswer } from "./answer";
import { readAnswer, tokenCountsOf, usageOf } from "./answer";
import type { RequestPlan } from "./request";
import { buildRequestBody, estimateInputTokens, planRequest } from "./request";

/** Token counts with nothing in them; the estimate fills input and output. */
const NO_TOKENS: TokenCounts = {
  uncachedInput: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0
};

/**
 * The prompt-gen result of an answer: text, tool calls, finish reason, cost
 * from usage × price, usage, and a meta without any text. Logs `partial`
 * for a length cut, `done` for every answer.
 *
 * @param ctx - Plugin context (log).
 * @param plan - The request's plan.
 * @param answer - The read answer.
 * @param usage - The answer's usage.
 * @returns The result.
 */
function resultOf(
  ctx: AnthropicContext,
  plan: RequestPlan,
  answer: AnthropicAnswer,
  usage: AnthropicUsage
): PromptGenResult {
  const counts = usageOf(usage);
  const { model } = plan;
  if (answer.finishReason === "length") ctx.log.warn("anthropic:prompt-gen:partial", { model });
  ctx.log.info("anthropic:prompt-gen:done", {
    model,
    promptTokens: counts.promptTokens,
    completionTokens: counts.completionTokens,
    cachedTokens: counts.cachedTokens
  });

  return {
    text: answer.text,
    costUsd: costUsd(plan.price, tokenCountsOf(usage)),
    toolCalls: answer.toolCalls,
    finishReason: answer.finishReason,
    usage: counts,
    meta: {
      model,
      effort: plan.outputConfig.effort,
      stopReason: answer.stopReason,
      promptTokens: counts.promptTokens,
      completionTokens: counts.completionTokens
    }
  };
}

/**
 * Runs one request: plan (every 400 before I/O), client (the key), images
 * from disk, body, the streamed request, answer, result.
 *
 * @param ctx - Plugin context.
 * @param request - The prompt-gen request.
 * @param signal - Caller abort signal (image reads and the request).
 * @returns The result.
 * @throws {Error} A plan error, the unavailable missing-key error, the classified request error, or a refusal.
 */
async function runPromptGen(
  ctx: AnthropicContext,
  request: PromptGenRequest,
  signal: AbortSignal | undefined
): Promise<PromptGenResult> {
  // Refuse a bad request, then find the key, before any file is read.
  const plan = planRequest(ctx, request);
  const client = getAnthropicClient(ctx);

  // Images come from disk; a remembered tool turn goes back unchanged.
  const imageBlocks = await readImageBlocks(plan.images, signal);
  const body = buildRequestBody(request, plan, imageBlocks, ctx.state.turns);
  const message = await requestMessage(client, body, signal);

  // A turn with tool calls is remembered whole, thinking included, for its replay.
  const answer = readAnswer(message);
  if (answer.toolCalls.length > 0) rememberTurn(ctx.state.turns, message.content);
  return resultOf(ctx, plan, answer, message.usage);
}

/**
 * Creates the handler registered under `("prompt-gen", "anthropic")`.
 * `estimate` is offline and needs no key: chars/4 of the text sent plus
 * 1 600 tokens per image in, `max_tokens` out, at the model's price.
 * `execute` sends one streamed Messages request; an unset key throws
 * `PromptGenUnavailableError` ("auth") so `promptGen` falls back. Every
 * failure is logged redacted and rethrown.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate and execute.
 */
export function createPromptGenHandler(ctx: AnthropicContext): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest): { usd: number } => {
      const plan = planRequest(ctx, request);
      const uncachedInput = estimateInputTokens(request, plan.images.length);
      return { usd: costUsd(plan.price, { ...NO_TOKENS, uncachedInput, output: plan.maxTokens }) };
    },
    execute: async (
      request: PromptGenRequest,
      opts: { signal?: AbortSignal }
    ): Promise<PromptGenResult> => {
      try {
        return await runPromptGen(ctx, request, opts.signal);
      } catch (error) {
        ctx.log.warn("anthropic:prompt-gen:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
