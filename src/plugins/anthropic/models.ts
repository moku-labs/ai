/**
 * @file anthropic models — the native model id a request runs on. The
 * fal/OpenRouter aliases the studio uses today map to native ids; any other
 * id is sent as is and needs a price (bundled or override) to run.
 */

/**
 * fal/OpenRouter alias → native Messages API model id.
 *
 * @example
 * ```ts
 * modelAliases.get("anthropic/claude-opus-5.5"); // => "claude-opus-5-5"
 * ```
 */
export const modelAliases: ReadonlyMap<string, string> = new Map([
  ["anthropic/claude-opus-5.5", "claude-opus-5-5"],
  ["anthropic/claude-sonnet-5.5", "claude-sonnet-5-5"],
  ["anthropic/claude-sonnet-5", "claude-sonnet-5"],
  ["anthropic/claude-haiku-5.5", "claude-haiku-5-5"],
  ["anthropic/claude-fable-5.1", "claude-fable-5-1"]
]);

/** The request model that means "the configured default". */
const DEFAULT_ALIAS = "default";

/**
 * The native model id a request runs on: `undefined` or `"default"` take
 * the configured default; an alias (in the request or the config) maps to
 * its native id; anything else is sent as is.
 *
 * @param model - `PromptGenRequest.model`.
 * @param defaultModel - `config.model`.
 * @returns The native model id.
 * @example
 * ```ts
 * resolveModelId("default", "anthropic/claude-sonnet-5.5"); // => "claude-sonnet-5-5"
 * ```
 */
export function resolveModelId(model: string | undefined, defaultModel: string): string {
  const requested = model === undefined || model === DEFAULT_ALIAS ? defaultModel : model;
  return modelAliases.get(requested) ?? requested;
}
