/**
 * @file openai tts handler — implements the voiceover task-owned contract.
 */
import type { VoiceoverHandler, VoiceoverRequest, VoiceoverResult } from "../../voiceover/contract";
import { redactedFailureOf, requestSpeech } from "../client";
import { estimateTtsCostUsd, getPrices } from "../prices";
import type { OpenaiContext, OpenaiSpeechRequestBody } from "../types";

/** OpenAI's `audio.speech.create` output formats this handler maps to. */
type OpenaiSpeechFormat = "mp3" | "wav" | "opus";

/**
 * Resolves the tts model to use: the request's override, else the
 * configured default.
 *
 * @param ctx - The openai plugin context.
 * @param request - The voiceover request.
 * @returns The tts model name.
 * @example
 * ```ts
 * const model = resolveTtsModel(ctx, request); // => "gpt-4o-mini-tts"
 * ```
 */
function resolveTtsModel(ctx: OpenaiContext, request: VoiceoverRequest): string {
  return request.model ?? ctx.config.models.tts;
}

/**
 * Maps the task contract's output format to one of OpenAI's tts response
 * formats. `"ogg"` has no direct OpenAI equivalent, so it maps to the
 * closest container-compatible codec, `"opus"`; an omitted format defaults
 * to `"mp3"`.
 *
 * @param format - The requested output format, if any.
 * @returns The OpenAI tts response format.
 * @example
 * ```ts
 * toOpenaiResponseFormat("ogg"); // => "opus"
 * ```
 */
function toOpenaiResponseFormat(format: VoiceoverRequest["format"]): OpenaiSpeechFormat {
  if (format === "wav") return "wav";
  if (format === "ogg") return "opus";
  return "mp3";
}

/**
 * Resolves the audio MIME type for an OpenAI tts response format.
 *
 * @param format - The OpenAI tts response format.
 * @returns The MIME type of the resulting audio bytes.
 * @example
 * ```ts
 * mimeTypeFor("mp3"); // => "audio/mpeg"
 * ```
 */
function mimeTypeFor(format: OpenaiSpeechFormat): string {
  if (format === "wav") return "audio/wav";
  if (format === "opus") return "audio/ogg";
  return "audio/mpeg";
}

/**
 * Builds the tts request body for the OpenAI SDK from a voiceover request.
 *
 * @param ctx - The openai plugin context.
 * @param request - The voiceover request.
 * @param format - The resolved OpenAI tts response format.
 * @returns The tts request body.
 * @example
 * ```ts
 * const params = buildSpeechRequestBody(ctx, request, "mp3");
 * ```
 */
function buildSpeechRequestBody(
  ctx: OpenaiContext,
  request: VoiceoverRequest,
  format: OpenaiSpeechFormat
): OpenaiSpeechRequestBody {
  return {
    model: resolveTtsModel(ctx, request),
    voice: request.voice,
    input: request.text,
    response_format: format
  };
}

/**
 * Creates the OpenAI voiceover (tts) handler: `estimate` prices by
 * characters × the tts per-million-characters price; `execute` calls
 * `audio.speech.create` with signal passthrough and returns the synthesized
 * audio plus its actual cost.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The voiceover handler for the "openai" provider.
 * @example
 * ```ts
 * registry.register("voiceover", "openai", createTtsHandler(ctx));
 * ```
 */
export function createTtsHandler(ctx: OpenaiContext): VoiceoverHandler {
  return {
    /**
     * Estimates the cost of `request` without executing it.
     *
     * @param request - The voiceover request to estimate.
     * @returns The estimated cost in US dollars.
     * @example
     * ```ts
     * handler.estimate({ text: "hi", voice: "alloy" }); // => { usd: 0.000015 }
     * ```
     */
    estimate(request: VoiceoverRequest): { usd: number } {
      const model = resolveTtsModel(ctx, request);
      return { usd: estimateTtsCostUsd(getPrices(ctx), model, request.text.length) };
    },
    /**
     * Executes `request`, returning the synthesized audio and its actual cost.
     *
     * @param request - The voiceover request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal for cancelling the in-flight request.
     * @returns The generation result.
     * @example
     * ```ts
     * await handler.execute({ text: "hi", voice: "alloy" }, {});
     * ```
     */
    async execute(
      request: VoiceoverRequest,
      opts: { signal?: AbortSignal }
    ): Promise<VoiceoverResult> {
      const model = resolveTtsModel(ctx, request);
      const format = toOpenaiResponseFormat(request.format);
      try {
        const response = await requestSpeech(
          ctx,
          buildSpeechRequestBody(ctx, request, format),
          opts.signal
        );
        const buffer = await response.arrayBuffer();
        // Redacted diagnostics only — model/format/character count, never text.
        ctx.log.info("openai:tts:done", { model, format, characters: request.text.length });
        return {
          audio: new Uint8Array(buffer),
          mimeType: mimeTypeFor(format),
          costUsd: estimateTtsCostUsd(getPrices(ctx), model, request.text.length),
          meta: { characters: request.text.length, model }
        };
      } catch (error) {
        ctx.log.warn("openai:tts:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
