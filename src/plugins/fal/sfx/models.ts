/**
 * @file fal sfx catalog — data module. Maps the accepted model alias to its
 * endpoint, duration range and body builder, and validates a request with zod
 * before anything is priced or sent. The body always asks for mp3, and
 * `params` never reach it: sfx output is mp3 only (D1).
 */
import { z } from "zod";
import type { SfxRequest } from "../../sfx/contract";
import { TerminalProviderError } from "../errors";

/**
 * sfx model aliases this plugin accepts in `SfxRequest.model`.
 *
 * @example
 * ```ts
 * const alias: SfxAlias = "elevenlabs-sfx-v2";
 * ```
 */
export type SfxAlias = "elevenlabs-sfx-v2";

/**
 * One catalog row.
 *
 * @example
 * ```ts
 * sfxModels["elevenlabs-sfx-v2"].maxMs; // => 22000
 * ```
 */
export type SfxModel = {
  /** fal endpoint id. */
  endpoint: string;
  /** Shortest clip, ms. */
  minMs: number;
  /** Longest clip, ms. A request without a duration is billed at this length. */
  maxMs: number;
  /** Builds the posted body; `params` never reach it. */
  body: (request: SfxRequest) => Record<string, unknown>;
};

/**
 * A catalog row with its alias.
 *
 * @example
 * ```ts
 * checkSfxRequest({ prompt: "coin", model: "elevenlabs-sfx-v2" }).model.alias; // => "elevenlabs-sfx-v2"
 * ```
 */
export type ResolvedSfxModel = SfxModel & { alias: SfxAlias };

/** The one output format: mp3, the only format the game engine reads. */
const MP3_FORMAT = "mp3_44100_128";

/** Longest prompt the ElevenLabs SFX endpoint takes, in characters. */
const MAX_PROMPT_LENGTH = 450;

/** Milliseconds per second: the request is in ms, the body in seconds. */
const MS_PER_SECOND = 1000;

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** An sfx request, as the build item writes it. */
const requestSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  model: z.string().min(1),
  durationMs: z.number().optional(),
  promptInfluence: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional()
});

/**
 * ElevenLabs SFX v2 body: the prompt as `text`, the duration in seconds,
 * the prompt influence and the loop flag when set, and always mp3.
 *
 * @param request - The validated request.
 * @returns The posted body.
 * @example
 * ```ts
 * elevenlabsSfxBody({ prompt: "coin", model: "elevenlabs-sfx-v2", durationMs: 600 }); // => { text: "coin", duration_seconds: 0.6, output_format: "mp3_44100_128" }
 * ```
 */
function elevenlabsSfxBody(request: SfxRequest): Record<string, unknown> {
  const { durationMs, promptInfluence, loop } = request;
  return {
    text: request.prompt,
    ...(durationMs === undefined ? {} : { duration_seconds: durationMs / MS_PER_SECOND }),
    ...(promptInfluence === undefined ? {} : { prompt_influence: promptInfluence }),
    ...(loop === undefined ? {} : { loop }),
    output_format: MP3_FORMAT
  };
}

/**
 * The fal sfx catalog, in the order `models("sfx")` lists it.
 *
 * @example
 * ```ts
 * sfxModels["elevenlabs-sfx-v2"].endpoint; // => "fal-ai/elevenlabs/sound-effects/v2"
 * ```
 */
export const sfxModels: Readonly<Record<SfxAlias, SfxModel>> = {
  "elevenlabs-sfx-v2": {
    endpoint: "fal-ai/elevenlabs/sound-effects/v2",
    minMs: 500,
    maxMs: 22_000,
    body: elevenlabsSfxBody
  }
};

/**
 * Whether `model` is one of the catalog's own aliases.
 *
 * @param model - The requested model string.
 * @returns True for a known alias.
 * @example
 * ```ts
 * isSfxAlias("eleven_text_to_sound_v2"); // => false
 * ```
 */
function isSfxAlias(model: string): model is SfxAlias {
  return Object.hasOwn(sfxModels, model);
}

/**
 * The accepted aliases, in catalog order.
 *
 * @returns Alias list.
 * @example
 * ```ts
 * sfxAliases(); // => ["elevenlabs-sfx-v2"]
 * ```
 */
export function sfxAliases(): SfxAlias[] {
  return Object.keys(sfxModels).filter(alias => isSfxAlias(alias));
}

/**
 * The terminal 400 of an invalid request.
 *
 * @param detail - What is wrong, naming the field.
 * @returns The error to throw.
 * @example
 * ```ts
 * invalidRequest("loop must be a boolean").message; // => "[ai] Invalid sfx request: loop must be a boolean.\n  Fix the build item that produced it."
 * ```
 */
function invalidRequest(detail: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] Invalid sfx request: ${detail}.\n  Fix the build item that produced it.`,
    BAD_REQUEST
  );
}

/**
 * Validates an sfx request: its shape (zod, the issue path names the bad
 * field), the model alias and the model's duration range.
 *
 * @param request - The request as the build item wrote it.
 * @returns The resolved model and the request.
 * @throws {TerminalProviderError} A 400 for a bad shape, an unknown alias or a duration out of range.
 * @example
 * ```ts
 * checkSfxRequest({ prompt: "coin", model: "elevenlabs-sfx-v2", durationMs: 30_000 }); // throws: durationMs must be from 500 to 22000 for elevenlabs-sfx-v2
 * ```
 */
export function checkSfxRequest(request: SfxRequest): {
  model: ResolvedSfxModel;
  request: SfxRequest;
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
  if (!isSfxAlias(alias)) {
    throw new TerminalProviderError(
      `[ai] Unknown fal sfx model "${alias}".\n  Use one of: ${sfxAliases().join(", ")}.`,
      BAD_REQUEST
    );
  }

  // A duration, when set, must fit the model's range.
  const model = { ...sfxModels[alias], alias };
  const { durationMs } = request;
  const isInRange =
    durationMs === undefined || (durationMs >= model.minMs && durationMs <= model.maxMs);
  if (!isInRange) {
    throw invalidRequest(`durationMs must be from ${model.minMs} to ${model.maxMs} for ${alias}`);
  }
  return { model, request };
}
