/**
 * @file openai prompt-gen handler — implements the prompt-gen task-owned
 * contract over the Responses API (`responses.create`, never stored): the
 * request is planned and checked offline (`request.ts`), images are read as
 * data URLs, the answer is read and its tool turn remembered (`answer.ts`).
 */
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../promptGen/contract";
import { PromptGenUnavailableError } from "../../promptGen/contract";
import { redactedFailureOf, requestResponse } from "../client";
import { readImageDataUrls } from "../images";
import type { TokenSplit } from "../prices";
import { cacheAwareCostUsd, estimateTokenCount, getPrices } from "../prices";
import type { ModelPrice, OpenaiContext, OpenaiResponse } from "../types";
import type { ResponsesAnswer } from "./answer";
import { readAnswer, rememberTurn, usageCostUsd, usageOf } from "./answer";
import { priceTierOf } from "./models";
import type { ResponsesPlan } from "./request";
import { buildResponsesBody, estimateInputTokens, planResponses } from "./request";

/** A token split with nothing counted; requests spread it and set their own fields. */
const NO_TOKENS: TokenSplit = {
  uncached: 0,
  cacheReads: 0,
  cacheWrites30m: 0,
  cacheWrites12h: 0,
  output: 0
};

/** Looks up a model's prices, logging `openai:prompt-gen:unpriced` the first time a model has none. */
type PriceLookup = (model: string) => Partial<ModelPrice> | undefined;

/**
 * Whether a price entry prices text tokens.
 *
 * @param entry - The model's table entry, if any.
 * @returns True when the entry has an input or an output rate.
 * @example
 * ```ts
 * isTextPriced({ ttsPerMChars: 15 }); // => false
 * ```
 */
function isTextPriced(entry: Partial<ModelPrice> | undefined): boolean {
  return entry?.inputPerM !== undefined || entry?.outputPerM !== undefined;
}

/**
 * Creates the handler's price lookup over the effective table. A model
 * without text prices costs 0 USD (add it via `config.priceOverrides`), and
 * `openai:prompt-gen:unpriced` is logged once per such model.
 *
 * @param ctx - Plugin context (prices, log).
 * @returns The lookup.
 */
function createPriceLookup(ctx: OpenaiContext): PriceLookup {
  const reported = new Set<string>();
  return model => {
    const entry = getPrices(ctx)[model];
    if (!isTextPriced(entry) && !reported.has(model)) {
      reported.add(model);
      ctx.log.warn("openai:prompt-gen:unpriced", { model });
    }
    return entry;
  };
}

/**
 * Refuses an `execute` without an API key as "unavailable", so `promptGen`
 * falls back to its next provider. A client already built needs no key.
 *
 * @param ctx - Plugin context (state, config, env).
 * @throws {PromptGenUnavailableError} With reason "auth" when `config.apiKeyEnv` is unset.
 */
function assertApiKey(ctx: OpenaiContext): void {
  if (ctx.state.client !== null) return;
  if (ctx.env.get(ctx.config.apiKeyEnv) !== undefined) return;
  throw new PromptGenUnavailableError(
    `[ai] ${ctx.config.apiKeyEnv} is not set.\n  Export it, or use another prompt-gen provider.`,
    "auth"
  );
}

/**
 * The cost of an answer: its usage at the model's prices, or, without usage,
 * the request's estimated input and the answer text at chars/4.
 *
 * @param request - The prompt-gen request.
 * @param plan - Its plan.
 * @param price - The model's prices, if any.
 * @param response - The answer.
 * @param text - The answer text.
 * @returns The cost in US dollars.
 */
function answerCostUsd(
  request: PromptGenRequest,
  plan: ResponsesPlan,
  price: Partial<ModelPrice> | undefined,
  response: OpenaiResponse,
  text: string
): number {
  if (response.usage !== undefined) return usageCostUsd(plan.model, price, response.usage);

  const input = estimateInputTokens(request, plan.images.length);
  const tokens = { ...NO_TOKENS, uncached: input, output: estimateTokenCount(text) };
  return cacheAwareCostUsd(price, tokens, priceTierOf(plan.model, input));
}

/**
 * The prompt-gen result of an answer: text, tool calls, finish reason, cost,
 * typed usage and redacted metadata (model and token counts only).
 *
 * @param plan - The plan.
 * @param response - The answer.
 * @param answer - What the answer carries.
 * @param costUsd - Its cost.
 * @returns The result.
 */
function resultOf(
  plan: ResponsesPlan,
  response: OpenaiResponse,
  answer: ResponsesAnswer,
  costUsd: number
): PromptGenResult {
  return {
    text: answer.text,
    costUsd,
    toolCalls: answer.toolCalls,
    finishReason: answer.finishReason,
    usage: usageOf(response.usage),
    meta: {
      model: plan.model,
      promptTokens: response.usage?.input_tokens,
      completionTokens: response.usage?.output_tokens
    }
  };
}

/**
 * Creates the OpenAI prompt-gen handler over the Responses API. `estimate`
 * is an offline upper bound: chars/4 of all input text plus 1 600 tokens per
 * image in, `max_output_tokens` out, at the model's price. `execute` checks
 * the request before any I/O (a terminal 400), refuses a missing key as
 * unavailable ("auth"), reads the images, calls `responses.create` with
 * `store: false` and `config.promptGenTimeoutMs`, remembers the reasoning of
 * a tool turn for the next request, and prices the answer from its usage.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The prompt-gen handler for the "openai" provider.
 */
export function createPromptGenHandler(ctx: OpenaiContext): PromptGenHandler {
  const priceOf = createPriceLookup(ctx);
  return {
    /**
     * Estimates the cost of `request` offline, without an API key.
     *
     * @param request - The prompt-gen request to estimate.
     * @returns The upper-bound cost in US dollars.
     * @throws {TerminalProviderError} A 400 for a request `execute` would refuse.
     */
    estimate(request: PromptGenRequest): { usd: number } {
      const plan = planResponses(request, ctx.config.models.chat);
      const input = estimateInputTokens(request, plan.images.length);
      const tokens = { ...NO_TOKENS, uncached: input, output: plan.maxOutputTokens };
      return {
        usd: cacheAwareCostUsd(priceOf(plan.model), tokens, priceTierOf(plan.model, input))
      };
    },
    /**
     * Executes `request` against the Responses API.
     *
     * @param request - The prompt-gen request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Optional abort signal to cancel the request.
     * @returns The generated result.
     * @throws {PromptGenUnavailableError} With reason "auth" when the API key is unset.
     * @throws {Error} A terminal 400 for a bad request, a classified SDK error, a flagged refusal, or `ToolArgumentsError`.
     */
    async execute(
      request: PromptGenRequest,
      opts: { signal?: AbortSignal }
    ): Promise<PromptGenResult> {
      // A bad request, then a missing key, are refused before any I/O.
      const plan = planResponses(request, ctx.config.models.chat);
      assertApiKey(ctx);
      const price = priceOf(plan.model);

      try {
        // Images become data URLs; remembered reasoning goes back before its calls.
        const imageUrls = await readImageDataUrls(plan.images);
        const body = buildResponsesBody(request, plan, imageUrls, ctx.state.turns);
        const response = await requestResponse(ctx, body, opts.signal);

        // The answer's tool turn is remembered for the next step of the loop.
        const answer = readAnswer(response);
        rememberTurn(ctx.state.turns, answer);
        const costUsd = answerCostUsd(request, plan, price, response, answer.text);

        // Redacted diagnostics only — model + token counts, never prompt text.
        ctx.log.info("openai:prompt-gen:done", {
          model: plan.model,
          promptTokens: response.usage?.input_tokens,
          completionTokens: response.usage?.output_tokens
        });
        return resultOf(plan, response, answer, costUsd);
      } catch (error) {
        ctx.log.warn("openai:prompt-gen:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
