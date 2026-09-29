/**
 * @file codex prompt-gen params — pure readers for `params.images`,
 * `params.responseSchema` and `params.reasoning`. A bad shape throws a
 * pinned two-line error before anything is spawned.
 */
import type { ImageFile } from "../../image/contract";
import type { PromptGenRequest } from "../../promptGen/contract";

/** Everything the prompt-gen handler reads from a request besides prompt, system and model. */
export type PromptParameters = {
  /** Images to attach, in order. */
  images: ImageFile[];
  /** `params.responseSchema` as JSON text, or undefined when no schema is set. */
  schemaText: string | undefined;
  /** Effort for `-c model_reasoning_effort`. */
  reasoningEffort: string;
  /** Request fields codex cannot honour, e.g. ["temperature"]. */
  ignored: string[];
};

/** Efforts codex accepts; `off` is mapped to `low` before this check. */
const REASONING_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * Whether `value` has the image contract's `{ path, mimeType, hash }` shape.
 *
 * @param value - A `params.images` entry.
 * @returns True for an image file.
 * @example
 * ```ts
 * isImageFile({ path: "/store/aa", mimeType: "image/png", hash: "h" }); // => true
 * ```
 */
function isImageFile(value: unknown): value is ImageFile {
  if (typeof value !== "object" || value === null) return false;

  const hasPath = "path" in value && typeof value.path === "string";
  const hasMimeType = "mimeType" in value && typeof value.mimeType === "string";
  const hasHash = "hash" in value && typeof value.hash === "string";
  return hasPath && hasMimeType && hasHash;
}

/**
 * Reads `params.images`: one image file or a list of them.
 *
 * @param value - The raw `params.images` value.
 * @returns The images, in order; [] when the param is absent.
 * @throws {Error} When the value is not an image file or a list of them.
 * @example
 * ```ts
 * readImages({ path: "/store/aa", mimeType: "image/png", hash: "h" }); // => [that file]
 * ```
 */
export function readImages(value: unknown): ImageFile[] {
  if (value === undefined) return [];

  const images: unknown[] = Array.isArray(value) ? value : [value];
  if (!images.every(image => isImageFile(image))) {
    throw new Error(
      "[ai] Codex params.images must be image files.\n  Pass { path, mimeType, hash } for every image."
    );
  }
  return images;
}

/**
 * Reads `params.responseSchema` as the JSON text codex gets in `schema.json`.
 *
 * @param value - The raw `params.responseSchema` value.
 * @returns The schema as JSON text; undefined when the param is absent.
 * @throws {Error} When the value is not a plain object.
 * @example
 * ```ts
 * readResponseSchema({ type: "object" }); // => '{"type":"object"}'
 * ```
 */
export function readResponseSchema(value: unknown): string | undefined {
  if (value === undefined) return undefined;

  const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isPlainObject) {
    throw new Error(
      "[ai] Codex params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object."
    );
  }
  return JSON.stringify(value);
}

/**
 * Reads `params.reasoning` as a codex effort: `off` becomes `low`.
 *
 * @param value - The raw `params.reasoning` value.
 * @param defaultEffort - `config.reasoningEffort`, used when the param is absent.
 * @returns The effort.
 * @throws {Error} When the value is not off, low, medium or high.
 * @example
 * ```ts
 * readReasoning("off", "medium"); // => "low"
 * ```
 */
export function readReasoning(value: unknown, defaultEffort: string): string {
  if (value === undefined) return defaultEffort;
  if (value === "off") return "low";
  if (typeof value === "string" && REASONING_EFFORTS.has(value)) return value;

  throw new Error(
    `[ai] Codex params.reasoning must be off, low, medium or high.\n  Got "${String(value)}".`
  );
}

/**
 * Reads every param of a prompt-gen request, and lists what codex ignores.
 *
 * @param request - The prompt-gen request.
 * @param defaultEffort - `config.reasoningEffort`.
 * @returns The validated params.
 * @throws {Error} When `images`, `responseSchema` or `reasoning` has a bad shape.
 * @example
 * ```ts
 * readPromptParameters({ prompt: "p", temperature: 0.2 }, "low").ignored; // => ["temperature"]
 * ```
 */
export function readPromptParameters(
  request: PromptGenRequest,
  defaultEffort: string
): PromptParameters {
  const params = request.params ?? {};

  return {
    images: readImages(params.images),
    schemaText: readResponseSchema(params.responseSchema),
    reasoningEffort: readReasoning(params.reasoning, defaultEffort),
    ignored: request.temperature === undefined ? [] : ["temperature"]
  };
}
