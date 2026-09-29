/**
 * @file claude model mapping — pure. Turns an OpenRouter-style request model
 * into a `--model` value, and `params.reasoning` into an `--effort` value.
 */
import type { Config, Effort, Reasoning } from "../types";

/** Vendor prefix of the own family in OpenRouter ids. */
const VENDOR_PREFIX = "anthropic/";

/** Bare ids of the own family: full `claude-*` names and the CLI aliases. */
const OWN_FAMILY_PATTERN = /^(?:claude-.+|opus|sonnet|haiku|fable)$/;

/**
 * The claude model for a request model id. Rules, in order: exact
 * `modelMap` entry; no request model → `textModel`; `anthropic/…` → prefix
 * stripped, dots turned into dashes; a bare claude id or alias passes;
 * anything else (a foreign vendor) → `textModel`. An empty `textModel`
 * means no `--model` (undefined).
 *
 * @param config - The `textModel` and `modelMap` config fields.
 * @param requestModel - The request's model id, if any.
 * @returns The `--model` value, or undefined for the CLI's own default.
 * @example
 * ```ts
 * mapModel({ textModel: "", modelMap: {} }, "anthropic/claude-opus-5.5"); // => "claude-opus-5-5"
 * ```
 */
export function mapModel(
  config: Pick<Config, "textModel" | "modelMap">,
  requestModel: string | undefined
): string | undefined {
  if (requestModel !== undefined && Object.hasOwn(config.modelMap, requestModel)) {
    return config.modelMap[requestModel];
  }

  const fallback = config.textModel === "" ? undefined : config.textModel;
  if (requestModel === undefined) return fallback;
  if (requestModel.startsWith(VENDOR_PREFIX) && requestModel !== VENDOR_PREFIX) {
    return requestModel.slice(VENDOR_PREFIX.length).replaceAll(".", "-");
  }
  return OWN_FAMILY_PATTERN.test(requestModel) ? requestModel : fallback;
}

/**
 * The `--effort` value for `params.reasoning`: `off` becomes `low` (the
 * CLI has no "off"), absent means no flag.
 *
 * @param reasoning - The request's reasoning level, if any.
 * @returns The effort level, or undefined for no `--effort`.
 * @example
 * ```ts
 * effortFor("off"); // => "low"
 * ```
 */
export function effortFor(reasoning: Reasoning | undefined): Effort | undefined {
  if (reasoning === "off") return "low";
  return reasoning;
}
