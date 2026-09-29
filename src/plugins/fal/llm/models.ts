/**
 * @file fal LLM catalog — the OpenRouter ids `models("prompt-gen")` lists, in
 * catalog order, and the model id a request resolves to. Any other id is sent
 * as is; it needs a price (`llm/prices.ts` or `priceOverrides`) to run.
 */

/**
 * Model ids in catalog order; `app.fal.models("prompt-gen")` lists these.
 *
 * @example
 * ```ts
 * llmModels[0]; // => "anthropic/claude-opus-5.5"
 * ```
 */
export const llmModels: readonly string[] = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-6-sol",
  "openai/gpt-6-astra",
  "google/gemini-3.8-flash",
  "x-ai/grok-4.7"
];

/** The request model that means "the configured default". */
const DEFAULT_ALIAS = "default";

/**
 * The model id a request runs on: `undefined` or `"default"` take the
 * configured default, anything else is sent as is.
 *
 * @param model - `PromptGenRequest.model`.
 * @param defaultModel - `config.llmDefaultModel`.
 * @returns The OpenRouter model id.
 * @example
 * ```ts
 * resolveModelId("default", "anthropic/claude-opus-5.5"); // => "anthropic/claude-opus-5.5"
 * ```
 */
export function resolveModelId(model: string | undefined, defaultModel: string): string {
  return model === undefined || model === DEFAULT_ALIAS ? defaultModel : model;
}
