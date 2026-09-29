/**
 * @file fal music catalog — data module. Maps each accepted model alias to its
 * endpoint, length range, billing unit and body builder, and validates a
 * request with zod before anything is priced or sent. There is no automatic
 * fallback between the models: the request names one, and only that one runs.
 */
import { z } from "zod";
import type { MusicChunk, MusicRequest } from "../../music/contract";
import { TerminalProviderError } from "../types";

/**
 * How a music model is billed.
 *
 * @example
 * ```ts
 * const billing: MusicBilling = "minute"; // USD per started minute
 * ```
 */
export type MusicBilling = "minute" | "generation";

/**
 * Music model aliases this plugin accepts in `MusicRequest.model`.
 *
 * @example
 * ```ts
 * const alias: MusicAlias = "stable-audio-2.5";
 * ```
 */
export type MusicAlias = "elevenlabs-music-v2.5" | "stable-audio-2.5";

/**
 * One catalog row.
 *
 * @example
 * ```ts
 * musicModels["stable-audio-2.5"].maxMs; // => 190000
 * ```
 */
export type MusicModel = {
  /** fal endpoint id. */
  endpoint: string;
  /** Shortest track, ms. */
  minMs: number;
  /** Longest track, ms. */
  maxMs: number;
  /** How fal bills it. */
  billing: MusicBilling;
  /** Builds the posted body; `params` never reach it. */
  body: (request: MusicRequest) => Record<string, unknown>;
};

/**
 * A catalog row with its alias.
 *
 * @example
 * ```ts
 * checkMusicRequest({ prompt: "rain", model: "stable-audio-2.5", lengthMs: 30_000 }).model.alias; // => "stable-audio-2.5"
 * ```
 */
export type ResolvedMusicModel = MusicModel & { alias: MusicAlias };

/** Composition-plan chunk rules: each 3–120 s, at most 30. */
const CHUNK_LIMITS = { minMs: 3000, maxMs: 120_000, count: 30 };

/** ElevenLabs output format. */
const ELEVENLABS_FORMAT = "mp3_48000_192";

/** Milliseconds per second, for Stable Audio's whole seconds. */
const MS_PER_SECOND = 1000;

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** One composition-plan chunk, as the build item writes it. */
const chunkSchema = z.object({
  text: z.string().min(1),
  durationMs: z.number().int(),
  styles: z.array(z.string().min(1)).min(1),
  avoid: z.array(z.string()).optional()
});

/** A music request, as the build item writes it. */
const requestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1),
  lengthMs: z.number().int().positive(),
  chunks: z.array(chunkSchema).optional(),
  seed: z.number().int().optional(),
  params: z.record(z.string(), z.unknown()).optional()
});

/**
 * `seed` when the request has one, else nothing.
 *
 * @param seed - `MusicRequest.seed`.
 * @returns The field, or an empty object.
 * @example
 * ```ts
 * seedField(7); // => { seed: 7 }
 * ```
 */
function seedField(seed: number | undefined): { seed?: number } {
  return seed === undefined ? {} : { seed };
}

/**
 * One composition-plan chunk as ElevenLabs takes it; `negative_styles` only
 * when there are any.
 *
 * @param chunk - The request chunk.
 * @returns The wire chunk.
 * @example
 * ```ts
 * planChunk({ text: "drop", durationMs: 30_000, styles: ["techno"], avoid: [] }); // => { text: "drop", duration_ms: 30000, positive_styles: ["techno"] }
 * ```
 */
function planChunk(chunk: MusicChunk): Record<string, unknown> {
  const avoid = chunk.avoid ?? [];
  return {
    text: chunk.text,
    duration_ms: chunk.durationMs,
    positive_styles: chunk.styles,
    ...(avoid.length === 0 ? {} : { negative_styles: avoid })
  };
}

/**
 * ElevenLabs Music body: a composition plan with chunks, else an
 * instrumental prompt of `lengthMs`.
 *
 * @param request - The validated request.
 * @returns The posted body.
 * @example
 * ```ts
 * elevenlabsBody({ prompt: "tense synth", model: "elevenlabs-music-v2.5", lengthMs: 60_000 }).music_length_ms; // => 60000
 * ```
 */
function elevenlabsBody(request: MusicRequest): Record<string, unknown> {
  const chunks = request.chunks ?? [];
  if (chunks.length === 0) {
    return {
      prompt: request.prompt,
      music_length_ms: request.lengthMs,
      force_instrumental: true,
      output_format: ELEVENLABS_FORMAT
    };
  }
  return {
    composition_plan: { chunks: chunks.map(chunk => planChunk(chunk)) },
    ...seedField(request.seed),
    output_format: ELEVENLABS_FORMAT
  };
}

/**
 * Stable Audio body: the prompt, whole seconds (rounded up) and the seed.
 * Chunks are not read.
 *
 * @param request - The validated request.
 * @returns The posted body.
 * @example
 * ```ts
 * stableAudioBody({ prompt: "rain", model: "stable-audio-2.5", lengthMs: 2500 }); // => { prompt: "rain", seconds_total: 3 }
 * ```
 */
function stableAudioBody(request: MusicRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    seconds_total: Math.ceil(request.lengthMs / MS_PER_SECOND),
    ...seedField(request.seed)
  };
}

/**
 * The fal music catalog, in the order `models("music")` lists it.
 *
 * @example
 * ```ts
 * musicModels["elevenlabs-music-v2.5"].billing; // => "minute"
 * ```
 */
export const musicModels: Readonly<Record<MusicAlias, MusicModel>> = {
  "elevenlabs-music-v2.5": {
    endpoint: "fal-ai/elevenlabs/music/v2.5",
    minMs: 3000,
    maxMs: 600_000,
    billing: "minute",
    body: elevenlabsBody
  },
  "stable-audio-2.5": {
    endpoint: "fal-ai/stable-audio-25/text-to-audio",
    minMs: 1000,
    maxMs: 190_000,
    billing: "generation",
    body: stableAudioBody
  }
};

/**
 * Whether `model` is one of the catalog's own aliases.
 *
 * @param model - The requested model string.
 * @returns True for a known alias.
 * @example
 * ```ts
 * isMusicAlias("suno"); // => false
 * ```
 */
function isMusicAlias(model: string): model is MusicAlias {
  return Object.hasOwn(musicModels, model);
}

/**
 * The accepted aliases, in catalog order.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * musicAliases(); // => ["elevenlabs-music-v2.5", "stable-audio-2.5"]
 * ```
 */
export function musicAliases(): MusicAlias[] {
  return Object.keys(musicModels).filter(alias => isMusicAlias(alias));
}

/**
 * The terminal 400 of an invalid request.
 *
 * @param detail - What is wrong, naming the field.
 * @returns The error to throw.
 * @example
 * ```ts
 * invalidRequest("chunks must be at most 30").message; // => "[ai] Invalid music request: chunks must be at most 30.\n  Fix the build item that produced it."
 * ```
 */
function invalidRequest(detail: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] Invalid music request: ${detail}.\n  Fix the build item that produced it.`,
    BAD_REQUEST
  );
}

/**
 * Checks the composition plan: each chunk 3–120 s, at most 30, adding up to
 * `lengthMs`. Checked for every model, also the ones that ignore chunks.
 *
 * @param chunks - The request chunks.
 * @param lengthMs - The track length.
 * @returns {void} Nothing; a plan that breaks no rule passes.
 * @throws {TerminalProviderError} A 400 naming the broken rule.
 * @example
 * ```ts
 * checkChunks([{ text: "a", durationMs: 2000, styles: ["x"] }], 2000); // throws: chunks.0.durationMs must be from 3000 to 120000
 * ```
 */
function checkChunks(chunks: readonly MusicChunk[], lengthMs: number): void {
  if (chunks.length === 0) return;

  const bad = chunks.findIndex(
    chunk => chunk.durationMs < CHUNK_LIMITS.minMs || chunk.durationMs > CHUNK_LIMITS.maxMs
  );
  if (bad !== -1) {
    throw invalidRequest(
      `chunks.${bad}.durationMs must be from ${CHUNK_LIMITS.minMs} to ${CHUNK_LIMITS.maxMs}`
    );
  }
  if (chunks.length > CHUNK_LIMITS.count) {
    throw invalidRequest(`chunks must be at most ${CHUNK_LIMITS.count}`);
  }

  const sum = chunks.reduce((total, chunk) => total + chunk.durationMs, 0);
  if (sum !== lengthMs) throw invalidRequest(`chunks add up to ${sum} ms, not ${lengthMs}`);
}

/**
 * Validates a music request: its shape (zod, the issue path names the bad
 * field), the model alias, the model's length range and the chunk rules.
 *
 * @param request - The request as the build item wrote it.
 * @returns The resolved model and the request.
 * @throws {TerminalProviderError} A 400 for a bad shape, an unknown alias, a length out of range, or a broken chunk rule.
 * @example
 * ```ts
 * checkMusicRequest({ prompt: "rain", model: "stable-audio-2.5", lengthMs: 200_000 }); // throws: lengthMs must be from 1000 to 190000 for stable-audio-2.5
 * ```
 */
export function checkMusicRequest(request: MusicRequest): {
  model: ResolvedMusicModel;
  request: MusicRequest;
} {
  // The shape, by zod: the first issue's path names the bad field.
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join(".") || "request";
    throw invalidRequest(`${where} ${issue?.message ?? "is invalid"}`);
  }

  // The alias must be in the catalog: there is no fallback to another model.
  const alias = request.model;
  if (!isMusicAlias(alias)) {
    throw new TerminalProviderError(
      `[ai] Unknown fal music model "${alias}".\n  Use one of: ${musicAliases().join(", ")}.`,
      BAD_REQUEST
    );
  }

  // The length must fit the model's range.
  const model = { ...musicModels[alias], alias };
  const isInRange = request.lengthMs >= model.minMs && request.lengthMs <= model.maxMs;
  if (!isInRange) {
    throw invalidRequest(`lengthMs must be from ${model.minMs} to ${model.maxMs} for ${alias}`);
  }

  // The composition plan, for every model: also the ones that ignore chunks.
  checkChunks(request.chunks ?? [], request.lengthMs);
  return { model, request };
}
