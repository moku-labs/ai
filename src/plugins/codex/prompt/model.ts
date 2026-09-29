/**
 * @file codex prompt-gen model mapping — pure. Turns a request model id
 * (OpenRouter style, e.g. "openai/gpt-6-sol") into a codex model, or into
 * none so codex uses its own default.
 */
import type { Config } from "../types";

/** The config fields {@link mapModel} reads. */
export type ModelMapConfig = Pick<Config, "textModel" | "modelMap">;

/** OpenRouter vendor prefix of codex's own models. */
const OWN_PREFIX = "openai/";

/** Bare ids of codex's own family: `gpt-*`, `o<digit>*`, `codex-*`. */
const OWN_FAMILY = /^(?:gpt-|o\d|codex-)/;

/**
 * Maps a request model to a codex model. In order: an exact `modelMap`
 * entry; no request model → `textModel`; `openai/<id>` → `<id>`; a bare id
 * of the codex family passes; anything else → `textModel`. An empty
 * `textModel` gives undefined (no `-m`).
 *
 * @param config - `textModel` and `modelMap`.
 * @param requestModel - The request's model id, if any.
 * @returns The codex model, or undefined for codex's own default.
 * @example
 * ```ts
 * mapModel({ textModel: "", modelMap: {} }, "openai/gpt-6-sol"); // => "gpt-6-sol"
 * ```
 */
export function mapModel(
  config: ModelMapConfig,
  requestModel: string | undefined
): string | undefined {
  const fallback = config.textModel === "" ? undefined : config.textModel;
  if (requestModel === undefined) return fallback;
  if (Object.hasOwn(config.modelMap, requestModel)) return config.modelMap[requestModel];

  const isOwnVendor = requestModel.startsWith(OWN_PREFIX) && requestModel !== OWN_PREFIX;
  if (isOwnVendor) return requestModel.slice(OWN_PREFIX.length);
  if (OWN_FAMILY.test(requestModel)) return requestModel;

  return fallback;
}
