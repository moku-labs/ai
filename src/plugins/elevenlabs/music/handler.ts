/**
 * @file elevenlabs music handler — implements the task-owned contract
 * (`../../music/contract.ts`). Checks the request, prices it, then POSTs to
 * `/v1/music` through `../client.ts`. The endpoint is synchronous and answers
 * with the audio file, so the handler offers `estimate` + `execute` and no
 * `submit` + `poll`. Output is always mp3. Every check runs before any HTTP
 * call and throws a terminal 400: a field the API cannot take is refused, never
 * dropped. Coordinates with the other submodules through root state and
 * `../prices.ts` only — per-task submodules never import each other (spec/10).
 */
import type { MusicChunk, MusicHandler, MusicRequest, MusicResult } from "../../music/contract";
import { elevenlabsRequest } from "../client";
import { TerminalProviderError } from "../errors";
import { musicPriceOf, resolvePrices } from "../prices";
import { redactedFailureOf, resolveApiKey } from "../support";
import type { ElevenlabsContext } from "../types";

/** Outbound JSON payload. */
type JsonBody = Record<string, unknown>;

/**
 * The `model_id` values `/v1/music` accepts, and whether a model takes the
 * `chunks` composition plan. `music_v1` takes a `sections` plan with global
 * styles and lyric lines, which `MusicChunk` cannot express.
 */
const MUSIC_MODELS: Readonly<Record<string, { chunkPlans: boolean }>> = {
  music_v1: { chunkPlans: false },
  music_v2: { chunkPlans: true },
  music_v2_5: { chunkPlans: true }
};

/** The `params` keys this handler reads; any other key is refused. */
const PARAM_KEYS: readonly string[] = ["output_format", "force_instrumental"];

/** Every accepted output format starts with this prefix: the result is always `audio/mpeg`. */
const MP3_FORMAT_PREFIX = "mp3_";

/** Track length range of `music_length_ms`, in ms. */
const LENGTH_LIMITS = { minMs: 3000, maxMs: 600_000 };

/** Chunk rules of the composition plan: `duration_ms` range, lines per `text`, characters per line. */
const CHUNK_LIMITS = { minMs: 3000, maxMs: 120_000, lines: 30, lineLength: 200 };

/** Status of a request refused before any HTTP call. */
const BAD_REQUEST = 400;

/** A checked request, priced and ready to send. */
type MusicPlan = {
  /** The `output_format` query value, or undefined to let the API pick (`auto`). */
  outputFormat: string | undefined;
  /** The JSON request body. */
  body: JsonBody;
  /** USD for this track. */
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
 * invalidRequest("ElevenLabs music lengthMs is out of range", "Set lengthMs from 3000 to 600000").status; // => 400
 * ```
 */
function invalidRequest(description: string, suggestion: string): TerminalProviderError {
  return new TerminalProviderError(`[ai] ${description}.\n  ${suggestion}.`, BAD_REQUEST);
}

/**
 * Tells whether `value` is a whole number from `min` to `max`.
 *
 * @param value - The number to check.
 * @param min - Smallest accepted value.
 * @param max - Largest accepted value.
 * @returns True when `value` is an integer in the range.
 * @example
 * ```ts
 * isIntegerIn(3000, 3000, 600_000); // => true
 * ```
 */
function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Checks the two fields the price depends on: the model and the track length.
 *
 * @param request - The music request.
 * @throws {TerminalProviderError} When the model is not a `/v1/music` model id or `lengthMs` is outside 3000..600000.
 * @example
 * ```ts
 * checkPricedFields({ prompt: "tense synth", model: "music_v2_5", lengthMs: 60_000 }); // passes
 * ```
 */
function checkPricedFields(request: MusicRequest): void {
  if (!Object.hasOwn(MUSIC_MODELS, request.model)) {
    throw invalidRequest(
      `ElevenLabs music does not support model "${request.model}"`,
      `Use one of: ${Object.keys(MUSIC_MODELS).join(", ")}`
    );
  }

  const { lengthMs } = request;
  if (!isIntegerIn(lengthMs, LENGTH_LIMITS.minMs, LENGTH_LIMITS.maxMs)) {
    throw invalidRequest(
      `ElevenLabs music lengthMs must be a whole number from ${LENGTH_LIMITS.minMs} to ${LENGTH_LIMITS.maxMs}, got ${lengthMs}`,
      "Set lengthMs in that range"
    );
  }
}

/**
 * Checks one chunk: its `durationMs` range and its lyric lines.
 *
 * @param chunk - The request chunk.
 * @param index - Its position in `chunks`, for the error text.
 * @throws {TerminalProviderError} When `durationMs` is outside 3000..120000, or `text` has over 30 lines or a line over 200 characters.
 * @example
 * ```ts
 * checkChunk({ text: "[Intro]", durationMs: 2000, styles: ["synthwave"] }, 0); // throws: chunks.0.durationMs ...
 * ```
 */
function checkChunk(chunk: MusicChunk, index: number): void {
  if (!isIntegerIn(chunk.durationMs, CHUNK_LIMITS.minMs, CHUNK_LIMITS.maxMs)) {
    throw invalidRequest(
      `ElevenLabs music chunks.${index}.durationMs must be a whole number from ${CHUNK_LIMITS.minMs} to ${CHUNK_LIMITS.maxMs}, got ${chunk.durationMs}`,
      "Set the chunk duration in that range"
    );
  }

  const lines = chunk.text.split("\n");
  const fitsLines =
    lines.length <= CHUNK_LIMITS.lines &&
    lines.every(line => line.length <= CHUNK_LIMITS.lineLength);
  if (!fitsLines) {
    throw invalidRequest(
      `ElevenLabs music chunks.${index}.text takes at most ${CHUNK_LIMITS.lines} lines of at most ${CHUNK_LIMITS.lineLength} characters`,
      "Shorten the chunk text or split the chunk"
    );
  }
}

/**
 * Checks the composition plan. The API takes no `music_length_ms` next to a
 * plan, so the chunk durations are the track length and must add up to `lengthMs`.
 *
 * @param request - The music request.
 * @param chunks - Its non-empty `chunks`.
 * @throws {TerminalProviderError} When the model takes no chunk plan, a chunk breaks a rule, or the durations do not add up to `lengthMs`.
 * @example
 * ```ts
 * checkChunkPlan(request, request.chunks ?? []);
 * ```
 */
function checkChunkPlan(request: MusicRequest, chunks: readonly MusicChunk[]): void {
  if (MUSIC_MODELS[request.model]?.chunkPlans !== true) {
    throw invalidRequest(
      `ElevenLabs music model "${request.model}" does not take chunks`,
      "Use music_v2 or music_v2_5 for a composition plan, or remove chunks"
    );
  }

  for (const [index, chunk] of chunks.entries()) checkChunk(chunk, index);

  const sum = chunks.reduce((total, chunk) => total + chunk.durationMs, 0);
  if (sum !== request.lengthMs) {
    throw invalidRequest(
      `ElevenLabs music chunks add up to ${sum} ms, not lengthMs ${request.lengthMs}`,
      "Make the chunk durations add up to lengthMs"
    );
  }
}

/**
 * Checks the fields only the HTTP call needs: the prompt, the composition
 * plan, the seed and `params`. The API takes a prompt or a plan, never both,
 * and each of `seed` and `force_instrumental` works with one of them only.
 *
 * @param request - The music request.
 * @throws {TerminalProviderError} For an empty prompt, a broken plan, a seed without chunks, `force_instrumental` with chunks, or an unknown `params` key.
 * @example
 * ```ts
 * checkSentFields({ prompt: "tense synth", model: "music_v2_5", lengthMs: 60_000, seed: 7 }); // throws: seed needs chunks
 * ```
 */
function checkSentFields(request: MusicRequest): void {
  const unknownKey = Object.keys(request.params ?? {}).find(key => !PARAM_KEYS.includes(key));
  if (unknownKey !== undefined) {
    throw invalidRequest(
      `ElevenLabs music does not read params.${unknownKey}`,
      `Use only: ${PARAM_KEYS.join(", ")}`
    );
  }

  const chunks = request.chunks ?? [];
  if (chunks.length > 0) {
    checkChunkPlan(request, chunks);
    if (request.params?.force_instrumental !== undefined) {
      throw invalidRequest(
        "ElevenLabs music takes force_instrumental only with a prompt, not with chunks",
        "Remove params.force_instrumental, or remove chunks"
      );
    }
    if (request.seed !== undefined && !Number.isInteger(request.seed)) {
      throw invalidRequest(
        `ElevenLabs music seed must be a whole number, got ${request.seed}`,
        "Set a whole-number seed, or omit it"
      );
    }
    return;
  }

  if (request.prompt.trim() === "") {
    throw invalidRequest("ElevenLabs music prompt is empty", "Write a prompt, or set chunks");
  }
  if (request.seed !== undefined) {
    throw invalidRequest(
      "ElevenLabs music takes seed only with chunks: the API refuses seed next to a prompt",
      "Remove seed, or describe the track with chunks"
    );
  }
}

/**
 * Resolves the `output_format` query value from `params.output_format`.
 * Unset means no query value: the API then picks `mp3_44100_128` for
 * `music_v1` and `mp3_48000_192` for the v2 models. A format that is not mp3
 * is refused, because the result is always labelled `audio/mpeg`.
 *
 * @param request - The music request.
 * @returns The mp3 output format, or undefined when the request sets none.
 * @throws {TerminalProviderError} When `params.output_format` is set and does not start with `mp3_`.
 * @example
 * ```ts
 * outputFormatOf({ prompt: "rain", model: "music_v1", lengthMs: 10_000, params: { output_format: "mp3_44100_192" } }); // => "mp3_44100_192"
 * ```
 */
function outputFormatOf(request: MusicRequest): string | undefined {
  const requested = request.params?.output_format;
  if (requested === undefined) return undefined;
  if (typeof requested === "string" && requested.startsWith(MP3_FORMAT_PREFIX)) return requested;

  const shown = typeof requested === "string" ? `"${requested}"` : `of type ${typeof requested}`;
  throw invalidRequest(
    `ElevenLabs music output_format ${shown} is not an mp3 format`,
    `Use an "${MP3_FORMAT_PREFIX}" format such as "mp3_44100_128", or omit it`
  );
}

/**
 * Resolves `force_instrumental` for a prompt request: `params.force_instrumental`
 * when set, else `true`, the same instrumental default as the fal music handler.
 *
 * @param request - The music request, without chunks.
 * @returns The `force_instrumental` value to send.
 * @throws {TerminalProviderError} When `params.force_instrumental` is not a boolean.
 * @example
 * ```ts
 * forceInstrumentalOf({ prompt: "rain", model: "music_v1", lengthMs: 10_000 }); // => true
 * ```
 */
function forceInstrumentalOf(request: MusicRequest): boolean {
  const requested = request.params?.force_instrumental;
  if (requested === undefined) return true;
  if (typeof requested === "boolean") return requested;

  throw invalidRequest(
    `ElevenLabs music params.force_instrumental must be true or false, got type ${typeof requested}`,
    "Set a boolean, or omit it"
  );
}

/**
 * One chunk as the API takes it; `negative_styles` only when there are any.
 *
 * @param chunk - The request chunk.
 * @returns The wire chunk.
 * @example
 * ```ts
 * planChunk({ text: "drop", durationMs: 30_000, styles: ["techno"] }); // => { text: "drop", duration_ms: 30000, positive_styles: ["techno"] }
 * ```
 */
function planChunk(chunk: MusicChunk): JsonBody {
  const avoid = chunk.avoid ?? [];
  return {
    text: chunk.text,
    duration_ms: chunk.durationMs,
    positive_styles: chunk.styles,
    ...(avoid.length === 0 ? {} : { negative_styles: avoid })
  };
}

/**
 * Builds the JSON body: a composition plan when the request has chunks (the
 * prompt is not sent, the API takes one or the other), else the prompt with
 * its length.
 *
 * @param request - The checked music request.
 * @returns The JSON request body.
 * @example
 * ```ts
 * buildBody({ prompt: "tense synth", model: "music_v2_5", lengthMs: 60_000 });
 * // => { prompt: "tense synth", music_length_ms: 60000, model_id: "music_v2_5", force_instrumental: true }
 * ```
 */
function buildBody(request: MusicRequest): JsonBody {
  const chunks = request.chunks ?? [];
  if (chunks.length === 0) {
    return {
      prompt: request.prompt,
      music_length_ms: request.lengthMs,
      model_id: request.model,
      force_instrumental: forceInstrumentalOf(request)
    };
  }
  return {
    composition_plan: { chunks: chunks.map(chunk => planChunk(chunk)) },
    model_id: request.model,
    ...(request.seed === undefined ? {} : { seed: request.seed })
  };
}

/**
 * Checks and prices the whole request without I/O.
 *
 * @param ctx - Plugin context (for the effective price table).
 * @param request - The music request.
 * @returns The output format, the body and the cost.
 * @throws {TerminalProviderError} Status 400 for any refused field or a missing price.
 */
function planMusic(ctx: ElevenlabsContext, request: MusicRequest): MusicPlan {
  checkPricedFields(request);
  checkSentFields(request);
  const outputFormat = outputFormatOf(request);
  const costUsd = musicPriceOf(resolvePrices(ctx), request.model, request.lengthMs);
  return { outputFormat, body: buildBody(request), costUsd };
}

/**
 * Creates the ElevenLabs music handler. `estimate()` checks the model and the
 * length and prices them; it reads nothing else. `execute()` checks every
 * field, prices the request, reads the API key, then POSTs to `/v1/music` and
 * waits up to `config.musicTimeoutMs` for the audio. All checks throw a
 * terminal 400 before any HTTP call.
 *
 * @param ctx - Plugin context (config + state + env + log).
 * @returns The `MusicHandler` registered under the "music" task.
 */
export function createMusicHandler(ctx: ElevenlabsContext): MusicHandler {
  return {
    /**
     * Prices `request` without executing it. Checks only the model and the length.
     *
     * @param request - The music request to estimate.
     * @returns The estimated cost in US dollars.
     * @throws {TerminalProviderError} Status 400 for a refused model or length, or a missing price.
     */
    estimate(request: MusicRequest): { usd: number } {
      checkPricedFields(request);
      return { usd: musicPriceOf(resolvePrices(ctx), request.model, request.lengthMs) };
    },
    /**
     * Generates the track through `/v1/music`.
     *
     * @param request - The music request to execute.
     * @param opts - Execution options.
     * @param opts.signal - Abort signal for cancelling the in-flight request.
     * @returns The mp3 audio, its cost and metadata.
     * @throws {TerminalProviderError} Status 400 for a refused field or a missing price, before any HTTP call; or an HTTP 4xx.
     * @throws {RetryableProviderError} On HTTP 5xx/429, a timeout, or a network failure.
     * @throws {FlaggedProviderError} On a content refusal (`bad_prompt`, `bad_composition_plan`, content policy).
     * @throws {Error} When the configured API key env var is unset.
     */
    async execute(request: MusicRequest, opts: { signal?: AbortSignal }): Promise<MusicResult> {
      // Check and price the request, then read the key: nothing is sent before both pass.
      const plan = planMusic(ctx, request);
      const apiKey = resolveApiKey(ctx);
      const { model, lengthMs } = request;
      const query =
        plan.outputFormat === undefined
          ? ""
          : `?output_format=${encodeURIComponent(plan.outputFormat)}`;

      // Generate the audio; a failure is logged redacted and rethrown unchanged.
      try {
        const audio = await elevenlabsRequest({
          baseUrl: ctx.config.baseUrl,
          path: `/v1/music${query}`,
          apiKey,
          body: plan.body,
          timeoutMs: ctx.config.musicTimeoutMs,
          ...(opts.signal === undefined ? {} : { signal: opts.signal })
        });

        // Log the success and assemble the mp3 result with its metadata.
        ctx.log.info("elevenlabs:music:done", { model, lengthMs, bytes: audio.length });
        return {
          audio,
          mimeType: "audio/mpeg",
          costUsd: plan.costUsd,
          meta: {
            model,
            lengthMs,
            ...(plan.outputFormat === undefined ? {} : { outputFormat: plan.outputFormat })
          }
        };
      } catch (error) {
        ctx.log.warn("elevenlabs:music:failed", redactedFailureOf(error));
        throw error;
      }
    }
  };
}
