/**
 * @file openai prompt-gen handler — implements the prompt-gen task-owned contract.
 */
import type {
  PromptGenHandler,
  PromptGenRequest,
  PromptGenResult,
  PromptGenUsage
} from "../../promptGen/contract";
import { assertOneTurnRequest } from "../../promptGen/contract";
import { redactedFailureOf, requestChatCompletion } from "../client";
import { FlaggedProviderError, TerminalProviderError } from "../errors";
import { estimateChatCostUsd, estimateTokenCount, getPrices } from "../prices";
import type {
  OpenaiChatMessage,
  OpenaiChatRequestBody,
  OpenaiChatUsage,
  OpenaiContext
} from "../types";

/**
 * The typed usage of a completion; counts the API did not send are 0.
 * OpenAI caches prompts on its own, so cache writes are always 0.
 *
 * @param usage - The completion's `usage`, if reported.
 * @returns The usage for `PromptGenResult.usage`.
 * @example
 * ```ts
 * usageOf({ prompt_tokens: 2400, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 1800 } });
 * // => { promptTokens: 2400, completionTokens: 120, cachedTokens: 1800, cacheWriteTokens: 0 }
 * ```
 */
function usageOf(usage: OpenaiChatUsage | undefined): PromptGenUsage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0
  };
}

/**
 * Resolves the chat model to use: the request's override, else the
 * configured default.
 *
 * @param ctx - The openai plugin context.
 * @param model - The request's model override, if any.
 * @returns The chat model name.
 * @example
 * ```ts
 * const model = resolveChatModel(ctx, request.model); // => "gpt-4o-mini"
 * ```
 */
function resolveChatModel(ctx: OpenaiContext, model: string | undefined): string {
  return model ?? ctx.config.models.chat;
}

/**
 * Builds the chat messages for a prompt-gen request: the caller's system
 * prompt (when given) followed by the user prompt.
 *
 * @param request - The prompt-gen request.
 * @returns The chat messages, in order.
 * @example
 * ```ts
 * buildMessages({ prompt: "Describe a sunset." });
 * ```
 */
function buildMessages(request: PromptGenRequest): OpenaiChatMessage[] {
  const messages: OpenaiChatMessage[] = [];
  if (request.system !== undefined) messages.push({ role: "system", content: request.system });
  messages.push({ role: "user", content: request.prompt });
  return messages;
}

/**
 * Builds the chat completion request body for a prompt-gen request,
 * forwarding the caller's temperature only when given (the SDK's own
 * default applies otherwise).
 *
 * @param model - The chat model to use.
 * @param messages - The chat messages.
 * @param temperature - The caller's temperature override, if any.
 * @returns The chat completion request body.
 * @example
 * ```ts
 * buildChatRequestBody("gpt-4o-mini", messages, 0.7);
 * ```
 */
function buildChatRequestBody(
  model: string,
  messages: OpenaiChatMessage[],
  temperature: number | undefined
): OpenaiChatRequestBody {
  return temperature === undefined ? { model, messages } : { model, messages, temperature };
}

/**
 * Creates the OpenAI prompt-gen handler: `estimate` prices a chars/4 token
 * heuristic (fast, dependency-free approximation for both the prompt and
 * the expected output) × chat prices; `execute` calls
 * `chat.completions.create` with the caller's system/prompt/temperature and
 * returns usage-based actual cost, typed `usage`, no tool calls, and
 * `finishReason` "length" for a cut answer, else "stop". Both throw
 * `PromptGenUnavailableError` with reason "unsupported" for `messages`,
 * `tools` or `toolChoice`, before any other work; `cacheSystem` alone is
 * ignored.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The prompt-gen handler for the "openai" provider.
 * @example
 * ```ts
 * registry.register("prompt-gen", "openai", createPromptGenHandler(ctx));
 * ```
 */
export function createPromptGenHandler(ctx: OpenaiContext): PromptGenHandler {
  return {
    /**
     * Estimates the cost of `request` without executing it.
     *
     * @param request - The prompt-gen request to estimate.
     * @returns The estimated cost in US dollars.
     * @throws {PromptGenUnavailableError} With reason "unsupported" for messages or tools.
     * @example
     * ```ts
     * handler.estimate({ prompt: "Describe a sunset over the ocean." });
     * ```
     */
    estimate(request: PromptGenRequest): { usd: number } {
      assertOneTurnRequest(request, "OpenAI");
      const model = resolveChatModel(ctx, request.model);
      const inputTokens =
        estimateTokenCount(request.prompt) + estimateTokenCount(request.system ?? "");
      // No response yet to size against — assume output is the same order of
      // magnitude as the prompt (a fast, dependency-free approximation).
      const outputTokens = estimateTokenCount(request.prompt);
      return { usd: estimateChatCostUsd(getPrices(ctx), model, inputTokens, outputTokens) };
    },
    /**
     * Executes `request` against the provider.
     *
     * @param request - The prompt-gen request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Optional abort signal to cancel the request.
     * @returns The generated result.
     * @throws {PromptGenUnavailableError} With reason "unsupported" for messages or tools.
     * @throws {Error} When the API key is unset, the request fails, or the model declines.
     * @example
     * ```ts
     * await handler.execute({ prompt: "Describe a sunset." }, {});
     * ```
     */
    async execute(
      request: PromptGenRequest,
      opts: { signal?: AbortSignal }
    ): Promise<PromptGenResult> {
      assertOneTurnRequest(request, "OpenAI");
      const model = resolveChatModel(ctx, request.model);
      try {
        const completion = await requestChatCompletion(
          ctx,
          buildChatRequestBody(model, buildMessages(request), request.temperature),
          opts.signal
        );
        const choice = completion.choices[0];
        const message = choice?.message;
        if (message === undefined) {
          throw new TerminalProviderError("[ai] OpenAI returned no completion choices.");
        }
        if (message.refusal !== null) {
          throw new FlaggedProviderError("[ai] OpenAI declined the request (content policy).");
        }
        const text = message.content ?? "";
        const usage = completion.usage;
        const costUsd = usage
          ? estimateChatCostUsd(getPrices(ctx), model, usage.prompt_tokens, usage.completion_tokens)
          : estimateChatCostUsd(
              getPrices(ctx),
              model,
              estimateTokenCount(request.prompt),
              estimateTokenCount(text)
            );
        // Redacted diagnostics only — model + token counts, never prompt text.
        ctx.log.info("openai:prompt-gen:done", { model, promptTokens: usage?.prompt_tokens });
        return {
          text,
          costUsd,
          toolCalls: [],
          finishReason: choice?.finish_reason === "length" ? "length" : "stop",
          usage: usageOf(usage),
          meta: {
            model,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens
          }
        };
      } catch (error) {
        ctx.log.warn("openai:prompt-gen:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
