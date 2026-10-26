/**
 * @file openai prompt-gen models — the model id a request runs on (aliases
 * `openai/<id>`), which models are GPT-6 reasoning models, the reasoning
 * effort a level maps to on each, and the long-context price tier.
 */
import type { PriceTier } from "../prices";
import type { OpenaiReasoningEffort } from "../types";

/**
 * How hard the model thinks, as the studio sends it in `params.reasoning`.
 *
 * @example
 * ```ts
 * const level: ReasoningLevel = "high";
 * ```
 */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

/**
 * Input tokens above which a GPT-6 request is priced at the long-context tier.
 *
 * @example
 * ```ts
 * 300_000 > LONG_CONTEXT_INPUT_TOKENS; // => true: input-side rates ×2, output ×1.5
 * ```
 */
export const LONG_CONTEXT_INPUT_TOKENS = 272_000;

/** Prefix of the fal/OpenRouter alias of a model id, dropped before the call. */
const ALIAS_PREFIX = "openai/";

/** GPT-6 family: reasoning models with explicit cache marks; never a `temperature`. */
const GPT6_MODELS: ReadonlySet<string> = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna"
]);

/** GPT-6 models that accept effort `none`; Astra and 6.1 Sol answer it with a 400. */
const NONE_EFFORT_MODELS: ReadonlySet<string> = new Set(["gpt-6-sol", "gpt-6-luna"]);

/** Rates of a request at or below the long-context threshold. */
const STANDARD_TIER: PriceTier = { input: 1, output: 1 };

/** Rates of a GPT-6 request above the long-context threshold. */
const LONG_CONTEXT_TIER: PriceTier = { input: 2, output: 1.5 };

/**
 * The model id a request runs on: the request's model without an
 * `openai/` prefix, else the configured default.
 *
 * @param model - `PromptGenRequest.model`.
 * @param defaultModel - `config.models.chat`.
 * @returns The OpenAI model id.
 * @example
 * ```ts
 * resolveModelId("openai/gpt-6-astra", "gpt-4o-mini"); // => "gpt-6-astra"
 * ```
 */
export function resolveModelId(model: string | undefined, defaultModel: string): string {
  if (model === undefined) return defaultModel;
  return model.startsWith(ALIAS_PREFIX) ? model.slice(ALIAS_PREFIX.length) : model;
}

/**
 * Whether a model is a GPT-6 reasoning model.
 *
 * @param model - The OpenAI model id.
 * @returns True for Astra, 6.1 Sol, Sol and Luna.
 * @example
 * ```ts
 * isGpt6Model("gpt-4o"); // => false
 * ```
 */
export function isGpt6Model(model: string): boolean {
  return GPT6_MODELS.has(model);
}

/**
 * The reasoning effort a level maps to: `off` is `none` where the model
 * accepts it (Sol, Luna), else `low`; every other level as is.
 *
 * @param model - The GPT-6 model id.
 * @param level - The requested level.
 * @returns The effort to send.
 * @example
 * ```ts
 * effortOf("gpt-6-astra", "off"); // => "low"
 * ```
 */
export function effortOf(model: string, level: ReasoningLevel): OpenaiReasoningEffort {
  if (level !== "off") return level;
  return NONE_EFFORT_MODELS.has(model) ? "none" : "low";
}

/**
 * The price tier of a request: a GPT-6 request above 272K input tokens pays
 * the input-side rates ×2 and the output rate ×1.5; anything else the
 * standard rates.
 *
 * @param model - The OpenAI model id.
 * @param inputTokens - All input tokens of the request.
 * @returns The rate multipliers.
 * @example
 * ```ts
 * priceTierOf("gpt-6-astra", 272_001); // => { input: 2, output: 1.5 }
 * ```
 */
export function priceTierOf(model: string, inputTokens: number): PriceTier {
  const isLongContext = isGpt6Model(model) && inputTokens > LONG_CONTEXT_INPUT_TOKENS;
  return isLongContext ? LONG_CONTEXT_TIER : STANDARD_TIER;
}
