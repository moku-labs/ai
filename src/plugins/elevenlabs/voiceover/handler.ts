/**
 * @file elevenlabs voiceover handler — implements the task-owned contract
 * (`../../voiceover/contract.ts`). Builds the ElevenLabs TTS request
 * (voice/model/format → URL + body), delegates the HTTP call + error
 * taxonomy to `../client.ts`, and computes cost from the shared price table
 * (`../prices.ts`). Coordinates with `../api.ts` through root state only —
 * per-task submodules never import each other (spec/10).
 */

import type { VoiceoverHandler, VoiceoverRequest, VoiceoverResult } from "../../voiceover/contract";
import type { ElevenlabsRequestOptions } from "../client";
import { elevenlabsRequest } from "../client";
import { resolvePrices } from "../prices";
import type { ElevenlabsContext } from "../types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../types";

/** Output audio container format accepted by a voiceover request. */
type OutputFormat = "mp3" | "wav" | "ogg";

/** Output container format used when a request omits `format`. */
const DEFAULT_FORMAT: OutputFormat = "mp3";

/** ElevenLabs `output_format` query value per requested container format. */
const OUTPUT_FORMAT_BY_FORMAT: Record<OutputFormat, string> = {
  mp3: "mp3_44100_128",
  wav: "pcm_44100",
  ogg: "ogg_44100"
};

/** Response MIME type per requested container format. */
const MIME_TYPE_BY_FORMAT: Record<OutputFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg"
};

/**
 * Resolves the model to use for `request`: the request's own `model`, else
 * `config.defaultModel`.
 *
 * @param ctx - Plugin context (for `config.defaultModel`).
 * @param request - The voiceover request.
 * @returns The resolved model id.
 * @example
 * ```ts
 * resolveModel(ctx, { text: "hi", voice: "v1" }); // => ctx.config.defaultModel
 * ```
 */
function resolveModel(ctx: ElevenlabsContext, request: VoiceoverRequest): string {
  return request.model ?? ctx.config.defaultModel;
}

/**
 * Computes cost as characters × the resolved model's per-character price
 * (0 when the model isn't in the effective price table).
 *
 * @param ctx - Plugin context (for the effective price table).
 * @param request - The voiceover request.
 * @param model - The resolved model id.
 * @returns The cost, in US dollars.
 * @example
 * ```ts
 * costOf(ctx, request, "eleven_multilingual_v2");
 * ```
 */
function costOf(ctx: ElevenlabsContext, request: VoiceoverRequest, model: string): number {
  const prices = resolvePrices(ctx);
  const pricePerChar = prices[model] ?? 0;
  return request.text.length * pricePerChar;
}

/**
 * Builds the `/v1/text-to-speech/{voiceId}` request path, including the
 * `output_format` query parameter for `format`.
 *
 * @param voiceId - The provider-scoped voice id.
 * @param format - The requested output container format.
 * @returns The request path.
 * @example
 * ```ts
 * buildPath("voice1", "mp3"); // => "/v1/text-to-speech/voice1?output_format=mp3_44100_128"
 * ```
 */
function buildPath(voiceId: string, format: OutputFormat): string {
  const outputFormat = OUTPUT_FORMAT_BY_FORMAT[format];
  return `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`;
}

/**
 * Builds the JSON request body: `text` + resolved `model_id`, an optional
 * `language_code` from `request.language`, and the request's own `params`
 * spread last (request-supplied fields win on key conflicts).
 *
 * @param request - The voiceover request.
 * @param model - The resolved model id.
 * @returns The JSON request body.
 * @example
 * ```ts
 * buildRequestBody({ text: "hi", voice: "v1" }, "eleven_multilingual_v2");
 * ```
 */
function buildRequestBody(request: VoiceoverRequest, model: string): Record<string, unknown> {
  const languageFields = request.language === undefined ? {} : { language_code: request.language };
  return { text: request.text, model_id: model, ...languageFields, ...request.params };
}

/**
 * Resolves the API key via `ctx.env`, throwing the pinned two-line "not
 * set" error (interpolating the configured env var name) when unset.
 *
 * @param ctx - Plugin context (for `config.apiKeyEnv` + `ctx.env`).
 * @returns The resolved API key.
 * @throws {Error} The pinned two-line "API key is not set" error.
 * @example
 * ```ts
 * const apiKey = resolveApiKey(ctx);
 * ```
 */
function resolveApiKey(ctx: ElevenlabsContext): string {
  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  if (apiKey === undefined) {
    throw new Error(
      `[ai] ${ctx.config.apiKeyEnv} is not set.\n  Export it or set config.apiKeyEnv to the variable that holds your key.`
    );
  }
  return apiKey;
}

/** Loggable fields extracted from a thrown error — status code + error class only, never request text. */
type RedactedFailure = {
  errorType: string;
  status?: number | undefined;
  kind?: string | undefined;
};

/**
 * Extracts redacted, loggable fields from a thrown error: status code and
 * error class only, never the original error message (which may echo
 * provider response text) — the redaction rule (spec/10).
 *
 * @param error - The thrown error.
 * @returns The redacted fields to pass to `ctx.log`.
 * @example
 * ```ts
 * ctx.log.warn("elevenlabs:voiceover:failed", redactedFailureOf(error));
 * ```
 */
function redactedFailureOf(error: unknown): RedactedFailure {
  if (error instanceof RetryableProviderError) {
    return { errorType: "retryable", status: error.status, kind: error.kind };
  }
  if (error instanceof TerminalProviderError) {
    return { errorType: "terminal", status: error.status };
  }
  if (error instanceof FlaggedProviderError) {
    return { errorType: "flagged", kind: error.kind };
  }
  return { errorType: "unknown" };
}

/**
 * Builds the `elevenlabsRequest` options for `request`, omitting `signal`
 * entirely rather than setting it to `undefined` (required under
 * `exactOptionalPropertyTypes`).
 *
 * @param ctx - Plugin context (for `config.baseUrl`/`config.timeoutMs`).
 * @param request - The voiceover request to execute.
 * @param opts - Execution options (abort signal).
 * @param opts.signal - Optional abort signal to forward, if provided.
 * @param apiKey - The resolved API key.
 * @param model - The resolved model id.
 * @param format - The resolved output container format.
 * @returns The options to pass to `elevenlabsRequest`.
 * @example
 * ```ts
 * const options = toRequestOptions(ctx, request, opts, apiKey, model, format);
 * ```
 */
function toRequestOptions(
  ctx: ElevenlabsContext,
  request: VoiceoverRequest,
  opts: { signal?: AbortSignal },
  apiKey: string,
  model: string,
  format: OutputFormat
): ElevenlabsRequestOptions {
  return {
    baseUrl: ctx.config.baseUrl,
    path: buildPath(request.voice, format),
    apiKey,
    body: buildRequestBody(request, model),
    timeoutMs: ctx.config.timeoutMs,
    ...(opts.signal === undefined ? {} : { signal: opts.signal })
  };
}

/**
 * Creates the ElevenLabs voiceover handler: `estimate()` computes
 * characters × price-per-char for the resolved model; `execute()` resolves
 * the API key, POSTs to `/v1/text-to-speech/{voiceId}`, and maps the
 * response into a `VoiceoverResult`.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The `VoiceoverHandler` registered under the "voiceover" task.
 * @example
 * ```ts
 * registry.register("voiceover", "elevenlabs", createVoiceoverHandler(ctx));
 * ```
 */
export function createVoiceoverHandler(ctx: ElevenlabsContext): VoiceoverHandler {
  return {
    /**
     * Estimates the cost of `request` without executing it.
     *
     * @param request - The voiceover request to estimate.
     * @returns The estimated cost in US dollars.
     * @example
     * ```ts
     * handler.estimate({ text: "hi", voice: "v1" });
     * ```
     */
    estimate(request: VoiceoverRequest): { usd: number } {
      return { usd: costOf(ctx, request, resolveModel(ctx, request)) };
    },
    /**
     * Executes `request` against the ElevenLabs TTS endpoint.
     *
     * @param request - The voiceover request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal for cancelling the in-flight request.
     * @returns The generation result.
     * @throws {RetryableProviderError} On HTTP 5xx/429, a timeout, or a network failure.
     * @throws {TerminalProviderError} On any other HTTP 4xx.
     * @throws {FlaggedProviderError} On a content-policy rejection.
     * @throws {Error} When the configured API key env var is unset.
     * @example
     * ```ts
     * await handler.execute({ text: "hi", voice: "v1" }, {});
     * ```
     */
    async execute(
      request: VoiceoverRequest,
      opts: { signal?: AbortSignal }
    ): Promise<VoiceoverResult> {
      const apiKey = resolveApiKey(ctx);
      const model = resolveModel(ctx, request);
      const format = request.format ?? DEFAULT_FORMAT;

      try {
        const audio = await elevenlabsRequest(
          toRequestOptions(ctx, request, opts, apiKey, model, format)
        );
        const costUsd = costOf(ctx, request, model);
        ctx.log.info("elevenlabs:voiceover:done", { model, format });
        return {
          audio,
          mimeType: MIME_TYPE_BY_FORMAT[format],
          costUsd,
          meta: { model, characters: request.text.length }
        };
      } catch (error) {
        ctx.log.warn("elevenlabs:voiceover:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
