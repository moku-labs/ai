/**
 * @file elevenlabs sfx handler — implements the task-owned contract
 * (`../../sfx/contract.ts`). Checks the request, prices it, then POSTs to
 * `/v1/sound-generation` through `../client.ts`. Output is always mp3 (D1).
 * Every check runs before any HTTP call and throws a terminal 400. Coordinates
 * with the other submodules through root state and `../prices.ts` only —
 * per-task submodules never import each other (spec/10).
 */
import type { SfxHandler, SfxRequest, SfxResult } from "../../sfx/contract";
import { elevenlabsRequest } from "../client";
import { TerminalProviderError } from "../errors";
import { resolvePrices, sfxPriceOf } from "../prices";
import { redactedFailureOf, resolveApiKey } from "../support";
import type { ElevenlabsContext } from "../types";

/** The only model the sound-generation endpoint serves. */
const SFX_MODEL = "eleven_text_to_sound_v2";

/** Output format used when `params.output_format` is not set. */
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

/** Every accepted output format starts with this prefix: sfx is mp3 only (D1). */
const MP3_FORMAT_PREFIX = "mp3_";

/** Shortest duration the endpoint accepts, in ms. */
const MIN_DURATION_MS = 500;

/** Longest duration the endpoint accepts, in ms. */
const MAX_DURATION_MS = 30_000;

/** Longest prompt the endpoint accepts, in characters. */
const MAX_PROMPT_LENGTH = 450;

/** Status of a request refused before any HTTP call. */
const BAD_REQUEST = 400;

/** Milliseconds per billed second. */
const MS_PER_SECOND = 1000;

/** A checked request, priced and ready to send. */
type SfxPlan = {
  /** The `output_format` query value, always an mp3 format. */
  outputFormat: string;
  /** The JSON request body. */
  body: Record<string, unknown>;
  /** USD for this generation. */
  costUsd: number;
};

/**
 * Builds the terminal 400 for a request the endpoint would refuse.
 *
 * @param description - What is wrong, without the prompt text.
 * @param suggestion - How to fix it.
 * @returns The error to throw.
 * @example
 * ```ts
 * invalidRequest("ElevenLabs sfx prompt is too long", "Shorten the prompt").status; // => 400
 * ```
 */
function invalidRequest(description: string, suggestion: string): TerminalProviderError {
  return new TerminalProviderError(`[ai] ${description}.\n  ${suggestion}.`, BAD_REQUEST);
}

/**
 * Checks the two fields the price depends on: the model and the duration.
 *
 * @param request - The sfx request.
 * @throws {TerminalProviderError} When the model is not `eleven_text_to_sound_v2` or `durationMs` is outside 500..30000.
 * @example
 * ```ts
 * checkPricedFields({ prompt: "hit", model: "eleven_text_to_sound_v2", durationMs: 800 }); // passes
 * ```
 */
function checkPricedFields(request: SfxRequest): void {
  if (request.model !== SFX_MODEL) {
    throw invalidRequest(
      `ElevenLabs sfx does not support model "${request.model}"`,
      `Use "${SFX_MODEL}"`
    );
  }

  const { durationMs } = request;
  if (durationMs === undefined) return;
  const isInRange =
    Number.isFinite(durationMs) && durationMs >= MIN_DURATION_MS && durationMs <= MAX_DURATION_MS;
  if (!isInRange) {
    throw invalidRequest(
      `ElevenLabs sfx durationMs must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}, got ${durationMs}`,
      "Set durationMs in that range, or omit it to let the model pick the length"
    );
  }
}

/**
 * Checks the fields only the HTTP call needs: the prompt length and `promptInfluence`.
 *
 * @param request - The sfx request.
 * @throws {TerminalProviderError} When the prompt is over 450 characters or `promptInfluence` is outside 0..1.
 * @example
 * ```ts
 * checkSentFields({ prompt: "hit", model: "eleven_text_to_sound_v2", promptInfluence: 0.3 }); // passes
 * ```
 */
function checkSentFields(request: SfxRequest): void {
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw invalidRequest(
      `ElevenLabs sfx prompt is ${request.prompt.length} characters; the limit is ${MAX_PROMPT_LENGTH}`,
      "Shorten the prompt"
    );
  }

  const { promptInfluence } = request;
  if (promptInfluence === undefined) return;
  const isInRange =
    Number.isFinite(promptInfluence) && promptInfluence >= 0 && promptInfluence <= 1;
  if (!isInRange) {
    throw invalidRequest(
      `ElevenLabs sfx promptInfluence must be between 0 and 1, got ${promptInfluence}`,
      "Set promptInfluence in that range, or omit it"
    );
  }
}

/**
 * Resolves the `output_format` query value from `params.output_format`.
 * Anything that is not an mp3 format is refused: sfx is mp3 only (D1).
 *
 * @param request - The sfx request.
 * @returns The mp3 output format.
 * @throws {TerminalProviderError} When `params.output_format` is set and does not start with `mp3_`.
 * @example
 * ```ts
 * outputFormatOf({ prompt: "hit", model: "eleven_text_to_sound_v2", params: { output_format: "mp3_22050_32" } }); // => "mp3_22050_32"
 * ```
 */
function outputFormatOf(request: SfxRequest): string {
  const requested = request.params?.output_format;
  if (requested === undefined) return DEFAULT_OUTPUT_FORMAT;
  if (typeof requested === "string" && requested.startsWith(MP3_FORMAT_PREFIX)) return requested;

  const shown = typeof requested === "string" ? `"${requested}"` : `of type ${typeof requested}`;
  throw invalidRequest(
    `ElevenLabs sfx output_format ${shown} is not an mp3 format`,
    `Use an "${MP3_FORMAT_PREFIX}" format such as "${DEFAULT_OUTPUT_FORMAT}", or omit it`
  );
}

/**
 * Builds the JSON body. Optional fields are left out when the request omits them.
 *
 * @param request - The checked sfx request.
 * @returns The JSON request body.
 * @example
 * ```ts
 * buildBody({ prompt: "hit", model: "eleven_text_to_sound_v2", durationMs: 800 });
 * // => { text: "hit", model_id: "eleven_text_to_sound_v2", duration_seconds: 0.8 }
 * ```
 */
function buildBody(request: SfxRequest): Record<string, unknown> {
  return {
    text: request.prompt,
    model_id: request.model,
    ...(request.durationMs === undefined
      ? {}
      : { duration_seconds: request.durationMs / MS_PER_SECOND }),
    ...(request.promptInfluence === undefined ? {} : { prompt_influence: request.promptInfluence }),
    ...(request.loop === undefined ? {} : { loop: request.loop })
  };
}

/**
 * Prices a request whose priced fields are checked: every started second at
 * the `#second` price, or the flat `#auto` price when the model picks the length.
 *
 * @param ctx - Plugin context (for the effective price table).
 * @param request - The sfx request.
 * @returns The cost in USD.
 * @throws {TerminalProviderError} Status 400 when the price row is missing.
 */
function costOf(ctx: ElevenlabsContext, request: SfxRequest): number {
  const prices = resolvePrices(ctx);
  if (request.durationMs === undefined) return sfxPriceOf(prices, request.model, "auto");
  const startedSeconds = Math.ceil(request.durationMs / MS_PER_SECOND);
  return startedSeconds * sfxPriceOf(prices, request.model, "second");
}

/**
 * Checks and prices the whole request without I/O.
 *
 * @param ctx - Plugin context (for the effective price table).
 * @param request - The sfx request.
 * @returns The output format, the body and the cost.
 * @throws {TerminalProviderError} Status 400 for any refused field or a missing price.
 */
function planSfx(ctx: ElevenlabsContext, request: SfxRequest): SfxPlan {
  checkPricedFields(request);
  checkSentFields(request);
  const outputFormat = outputFormatOf(request);
  return { outputFormat, body: buildBody(request), costUsd: costOf(ctx, request) };
}

/**
 * Creates the ElevenLabs sfx handler. `estimate()` checks the model and the
 * duration and prices them; it reads nothing else, because the runner
 * estimates the request before references are resolved. `execute()` checks
 * every field, prices the request, reads the API key, then POSTs to
 * `/v1/sound-generation`. All checks throw a terminal 400 before any HTTP call.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The `SfxHandler` registered under the "sfx" task.
 */
export function createSfxHandler(ctx: ElevenlabsContext): SfxHandler {
  return {
    /**
     * Prices `request` without executing it. Checks only the model and the duration.
     *
     * @param request - The sfx request to estimate.
     * @returns The estimated cost in US dollars.
     * @throws {TerminalProviderError} Status 400 for a refused model or duration, or a missing price.
     */
    estimate(request: SfxRequest): { usd: number } {
      checkPricedFields(request);
      return { usd: costOf(ctx, request) };
    },
    /**
     * Generates the sound effect through `/v1/sound-generation`.
     *
     * @param request - The sfx request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal for cancelling the in-flight request.
     * @returns The mp3 audio, its cost and metadata.
     * @throws {TerminalProviderError} Status 400 for a refused field or a missing price, before any HTTP call; or an HTTP 4xx.
     * @throws {RetryableProviderError} On HTTP 5xx/429, a timeout, or a network failure.
     * @throws {FlaggedProviderError} On a content-policy rejection.
     * @throws {Error} When the configured API key env var is unset.
     */
    async execute(request: SfxRequest, opts: { signal?: AbortSignal }): Promise<SfxResult> {
      const plan = planSfx(ctx, request);
      const apiKey = resolveApiKey(ctx);
      const model = request.model;

      try {
        const audio = await elevenlabsRequest({
          baseUrl: ctx.config.baseUrl,
          path: `/v1/sound-generation?output_format=${encodeURIComponent(plan.outputFormat)}`,
          apiKey,
          body: plan.body,
          timeoutMs: ctx.config.timeoutMs,
          ...(opts.signal === undefined ? {} : { signal: opts.signal })
        });
        ctx.log.info("elevenlabs:sfx:done", { model, outputFormat: plan.outputFormat });
        return {
          audio,
          mimeType: "audio/mpeg",
          costUsd: plan.costUsd,
          meta: {
            model,
            outputFormat: plan.outputFormat,
            ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs })
          }
        };
      } catch (error) {
        ctx.log.warn("elevenlabs:sfx:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
