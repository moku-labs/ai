/**
 * @file openai translate handler — implements the translate task-owned contract.
 */
import type { TranslateHandler, TranslateRequest, TranslateResult } from "../../translate/contract";
import { redactedFailureOf, requestChatCompletion } from "../client";
import { estimateChatCostUsd, estimateTokenCount, getPrices } from "../prices";
import type { OpenaiChatMessage, OpenaiChatRequestBody, OpenaiContext } from "../types";
import { FlaggedProviderError, TerminalProviderError } from "../types";

/**
 * Fixed translation system prompt template; `{source}`/`{target}` are
 * interpolated per request. Instructs the model to answer with only the
 * translated text so `execute()` can use the completion verbatim.
 */
const TRANSLATION_SYSTEM_PROMPT_TEMPLATE =
  "You are a professional translator. Translate the user's message from {source} to {target}. " +
  "Respond with only the translated text — no explanations, quotes, or commentary.";

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
 * Builds the translation system prompt for `request`, interpolating the
 * source (or an auto-detect placeholder when omitted) and target languages.
 *
 * @param request - The translate request.
 * @returns The interpolated system prompt.
 * @example
 * ```ts
 * buildSystemPrompt({ text: "Hi", targetLang: "es" });
 * ```
 */
function buildSystemPrompt(request: TranslateRequest): string {
  const source = request.sourceLang ?? "its source language (auto-detect)";
  return TRANSLATION_SYSTEM_PROMPT_TEMPLATE.replace("{source}", source).replace(
    "{target}",
    request.targetLang
  );
}

/**
 * Builds the chat messages for a translate request: the system prompt
 * followed by the text to translate as the user message.
 *
 * @param request - The translate request.
 * @returns The chat messages, in order.
 * @example
 * ```ts
 * buildMessages({ text: "Hi", targetLang: "es" });
 * ```
 */
function buildMessages(request: TranslateRequest): OpenaiChatMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(request) },
    { role: "user", content: request.text }
  ];
}

/**
 * Builds the chat completion request body for a translation: deterministic
 * (temperature 0), since translation has no need for creative sampling.
 *
 * @param model - The chat model to use.
 * @param messages - The chat messages.
 * @returns The chat completion request body.
 * @example
 * ```ts
 * buildChatRequestBody("gpt-4o-mini", messages);
 * ```
 */
function buildChatRequestBody(model: string, messages: OpenaiChatMessage[]): OpenaiChatRequestBody {
  return { model, messages, temperature: 0 };
}

/**
 * Creates the OpenAI translate handler: `estimate` prices a chars/4 token
 * heuristic (fast, dependency-free approximation for both the prompt and
 * the expected translated output) × chat prices; `execute` calls
 * `chat.completions.create` with the fixed translation system prompt and
 * returns usage-based actual cost.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The translate handler for the "openai" provider.
 * @example
 * ```ts
 * registry.register("translate", "openai", createTranslateHandler(ctx));
 * ```
 */
export function createTranslateHandler(ctx: OpenaiContext): TranslateHandler {
  return {
    /**
     * Estimates the cost of `request` without executing it.
     *
     * @param request - The translate request to estimate.
     * @returns The estimated cost in US dollars.
     * @example
     * ```ts
     * handler.estimate({ text: "Hello", targetLang: "es" });
     * ```
     */
    estimate(request: TranslateRequest): { usd: number } {
      const model = resolveChatModel(ctx, request.model);
      const inputTokens =
        estimateTokenCount(request.text) + estimateTokenCount(buildSystemPrompt(request));
      // Translated output is roughly the same order of magnitude as the source text.
      const outputTokens = estimateTokenCount(request.text);
      return { usd: estimateChatCostUsd(getPrices(ctx), model, inputTokens, outputTokens) };
    },
    /**
     * Executes `request` against the provider.
     *
     * @param request - The translate request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Optional abort signal to cancel the request.
     * @returns The translation result.
     * @throws {Error} When the API key is unset, the request fails, or the model declines.
     * @example
     * ```ts
     * await handler.execute({ text: "Hello", targetLang: "es" }, {});
     * ```
     */
    async execute(
      request: TranslateRequest,
      opts: { signal?: AbortSignal }
    ): Promise<TranslateResult> {
      const model = resolveChatModel(ctx, request.model);
      try {
        const completion = await requestChatCompletion(
          ctx,
          buildChatRequestBody(model, buildMessages(request)),
          opts.signal
        );
        const message = completion.choices[0]?.message;
        if (message === undefined) {
          throw new TerminalProviderError("[ai] OpenAI returned no completion choices.");
        }
        if (message.refusal !== null) {
          throw new FlaggedProviderError("[ai] OpenAI declined the translation (content policy).");
        }
        const text = message.content ?? "";
        const usage = completion.usage;
        // detectedSourceLang is intentionally omitted: a chat completion gives
        // no reliable signal to derive it from without a separate prompt/turn.
        const costUsd = usage
          ? estimateChatCostUsd(getPrices(ctx), model, usage.prompt_tokens, usage.completion_tokens)
          : estimateChatCostUsd(
              getPrices(ctx),
              model,
              estimateTokenCount(request.text),
              estimateTokenCount(text)
            );
        // Redacted diagnostics only — model + token counts, never text.
        ctx.log.info("openai:translate:done", { model, promptTokens: usage?.prompt_tokens });
        return {
          text,
          costUsd,
          meta: {
            model,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens
          }
        };
      } catch (error) {
        ctx.log.warn("openai:translate:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
