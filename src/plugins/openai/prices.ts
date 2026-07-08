/**
 * @file openai bundled price table — data module (USD per M tokens / M chars by model).
 */
import type { PriceTable } from "./types";

/** Bundled prices by model; merged with config.priceOverrides at first use. */
export const bundledPrices: PriceTable = {};
