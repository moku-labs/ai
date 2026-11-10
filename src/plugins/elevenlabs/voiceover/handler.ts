/**
 * @file elevenlabs voiceover handler — implements the task-owned contract
 * (`../../voiceover/contract.ts`). Builds the ElevenLabs TTS request
 * (voice/model/format/settings → URL + body), delegates the HTTP call + error
 * taxonomy to `../client.ts`, and computes cost from the shared price table
 * (`../prices.ts`). Coordinates with `../api.ts` through root state only —
 * per-task submodules never import each other (spec/10).
 */

import type {
  VoiceoverHandler,
  VoiceoverRequest,
  VoiceoverResult,
  VoiceSettings
} from "../../voiceover/contract";
import type { ElevenlabsRequestOptions } from "../client";
import { elevenlabsRequest } from "../client";
import type { OutputFormat } from "../formats";
import { isV3OrV4, languageCodeOf, resolveOutputFormat } from "../formats";
import { resolvePrices } from "../prices";
import { redactedFailureOf, resolveApiKey } from "../support";
import type { ElevenlabsContext } from "../types";

/** The voice settings a v3/v4 model ignores: they honour only stability and similarity. */
const V3_V4_IGNORED_SETTINGS: ReadonlySet<keyof VoiceSettings> = new Set([
  "style",
  "speakerBoost",
  "speed"
]);

/** Each contract `VoiceSettings` key with its ElevenLabs `voice_settings` key, in wire order. */
const VOICE_SETTING_KEYS: ReadonlyArray<readonly [keyof VoiceSettings, string]> = [
  ["stability", "stability"],
  ["similarity", "similarity_boost"],
  ["style", "style"],
  ["speakerBoost", "use_speaker_boost"],
  ["speed", "speed"]
];

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
 * `output_format` query parameter.
 *
 * @param voiceId - The provider-scoped voice id.
 * @param format - The resolved output format.
 * @returns The request path.
 * @example
 * ```ts
 * buildPath("voice1", { code: "mp3_44100_128", mimeType: "audio/mpeg" });
 * // => "/v1/text-to-speech/voice1?output_format=mp3_44100_128"
 * ```
 */
function buildPath(voiceId: string, format: OutputFormat): string {
  return `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${format.code}`;
}

/**
 * Maps the contract's voice settings onto ElevenLabs' `voice_settings` names,
 * only the keys that are set. A v3/v4 model honours only stability and
 * similarity, so its style, speaker boost and speed are dropped and their
 * contract key names returned for the warning.
 *
 * @param settings - The request's voice settings, if any.
 * @param model - The resolved model id.
 * @returns The mapped settings (empty when none apply) and the dropped key names.
 * @example
 * ```ts
 * mapVoiceSettings({ stability: 0.5, speed: 1.1 }, "eleven_v4");
 * // => { voiceSettings: { stability: 0.5 }, ignored: ["speed"] }
 * ```
 */
function mapVoiceSettings(
  settings: VoiceSettings | undefined,
  model: string
): { voiceSettings: Record<string, number | boolean>; ignored: string[] } {
  const voiceSettings: Record<string, number | boolean> = {};
  const ignored: string[] = [];
  const dropsExtras = isV3OrV4(model);

  for (const [key, wireKey] of VOICE_SETTING_KEYS) {
    const value = settings?.[key];
    if (value === undefined) continue;
    if (dropsExtras && V3_V4_IGNORED_SETTINGS.has(key)) {
      ignored.push(key);
      continue;
    }
    voiceSettings[wireKey] = value;
  }
  return { voiceSettings, ignored };
}

/**
 * Builds the JSON request body: `text` + resolved `model_id`, then the
 * optional `language_code`, `voice_settings`, `seed`, `previous_text` and
 * `next_text` (only the ones set; never an undefined key), and the request's
 * own `params` spread last (a raw override still wins).
 *
 * @param request - The voiceover request.
 * @param model - The resolved model id.
 * @param voiceSettings - The mapped ElevenLabs voice settings.
 * @returns The JSON request body.
 * @example
 * ```ts
 * buildRequestBody({ text: "hi", voice: "v1", seed: 7 }, "eleven_v4", {});
 * // => { text: "hi", model_id: "eleven_v4", seed: 7 }
 * ```
 */
function buildRequestBody(
  request: VoiceoverRequest,
  model: string,
  voiceSettings: Record<string, number | boolean>
): Record<string, unknown> {
  const languageCode = languageCodeOf(model, request.language);
  const hasSettings = Object.keys(voiceSettings).length > 0;
  return {
    text: request.text,
    model_id: model,
    ...(languageCode === undefined ? {} : { language_code: languageCode }),
    ...(hasSettings ? { voice_settings: voiceSettings } : {}),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.previousText === undefined ? {} : { previous_text: request.previousText }),
    ...(request.nextText === undefined ? {} : { next_text: request.nextText }),
    ...request.params
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
     * @throws {TerminalProviderError} Status 400 for an unknown output format, before any HTTP call.
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
      const format = resolveOutputFormat(request.outputFormat, request.format);
      const { voiceSettings, ignored } = mapVoiceSettings(request.settings, model);
      if (ignored.length > 0) {
        ctx.log.warn("elevenlabs:voiceover:settings-ignored", { model, keys: ignored });
      }
      const options: ElevenlabsRequestOptions = {
        baseUrl: ctx.config.baseUrl,
        path: buildPath(request.voice, format),
        apiKey,
        body: buildRequestBody(request, model, voiceSettings),
        timeoutMs: ctx.config.timeoutMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal })
      };

      try {
        const audio = await elevenlabsRequest(options);
        const costUsd = costOf(ctx, request, model);
        ctx.log.info("elevenlabs:voiceover:done", { model, format: format.code });
        return {
          audio,
          mimeType: format.mimeType,
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
