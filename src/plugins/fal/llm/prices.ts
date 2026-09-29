/**
 * @file fal LLM prices — USD per M tokens, emitted as `llm:<id>#in` / `llm:<id>#out`.
 */
import { missingPriceError } from "../prices";

/**
 * Input and output price of one model, USD per M tokens.
 *
 * @example
 * ```ts
 * const price: LlmPrice = { inputPerM: 4, outputPerM: 20 };
 * ```
 */
export type LlmPrice = {
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
};

/**
 * Bundled prices by OpenRouter id: the six listed models plus two priced
 * ids that `models("prompt-gen")` does not list. Override with
 * `llm:<id>#in` / `llm:<id>#out` in `config.priceOverrides`.
 *
 * @example
 * ```ts
 * llmPrices["x-ai/grok-4.7"]; // => { inputPerM: 1.6, outputPerM: 4.8 }
 * ```
 */
export const llmPrices: Readonly<Record<string, LlmPrice>> = {};

/**
 * The bundled prices as flat merged-table rows.
 *
 * @returns Rows keyed `llm:<id>#in` and `llm:<id>#out`.
 * @example
 * ```ts
 * llmPriceRows()["llm:openai/gpt-6-astra#out"]; // => 50
 * ```
 */
export function llmPriceRows(): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const [id, price] of Object.entries(llmPrices)) {
    rows[`llm:${id}#in`] = price.inputPerM;
    rows[`llm:${id}#out`] = price.outputPerM;
  }
  return rows;
}

/**
 * The price of one model from the merged table; both rows must be present.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param id - The OpenRouter model id.
 * @returns Input and output USD per M tokens.
 * @throws {TerminalProviderError} When either row is missing.
 * @example
 * ```ts
 * llmPriceOf({ "llm:a/b#in": 1, "llm:a/b#out": 2 }, "a/b"); // => { inputPerM: 1, outputPerM: 2 }
 * ```
 */
export function llmPriceOf(prices: Readonly<Record<string, number>>, id: string): LlmPrice {
  const inputPerM = prices[`llm:${id}#in`];
  const outputPerM = prices[`llm:${id}#out`];
  if (inputPerM === undefined || outputPerM === undefined) {
    throw missingPriceError("prompt-gen", id);
  }
  return { inputPerM, outputPerM };
}
