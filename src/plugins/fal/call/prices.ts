/**
 * @file fal call prices — the bundled USD rate and billing unit of each endpoint
 * `("call", "fal")` knows, and the unit counting. Root `prices.ts` adds the `call:`
 * prefix. fal gives no cost with an answer, so a call costs the row times the units
 * of that call. An endpoint with no row is refused before any upload or POST
 * (the table is the allow-list).
 */
import { readField } from "../client/http";
import { TerminalProviderError } from "../errors";
import type { CallUnit } from "../types";

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** Pixels in one megapixel, the unit `microsoft/moge-2` bills by. */
const PIXELS_PER_MEGAPIXEL = 1_000_000;

/** Frames in one billed block of `fal-ai/sam-3/video-rle`. */
const FRAMES_PER_BLOCK = 16;

/** Costs are kept to whole micro-dollars, like every other fal price. */
const MICRO_DOLLARS = 1_000_000;

/**
 * Bundled USD per billed unit, by endpoint id. Override or add one with
 * `call:<endpoint>` in `config.priceOverrides`. fal page lines read 2026-11-11:
 * 3d-body "$0.02 per unit" (the unit is not named, so one request), sam-3/image
 * "$0.005 per request", sam-3/video-rle "$0.005 per 16 frames of video", moge-2
 * "$0.01" per megapixel rounded up. No row for `openai/gpt-image-2.5/sunburst/edit`:
 * fal bills it per token, so it runs as the `image` task.
 *
 * @example
 * ```ts
 * callPrices["fal-ai/sam-3/image"]; // => 0.005
 * ```
 */
export const callPrices: Readonly<Record<string, number>> = {
  "fal-ai/sam-3/3d-body": 0.02,
  "fal-ai/sam-3/image": 0.005,
  "fal-ai/sam-3/video-rle": 0.005,
  "microsoft/moge-2": 0.01
};

/**
 * Endpoints not billed per request. Every other endpoint is `"request"`.
 *
 * @example
 * ```ts
 * callUnits["microsoft/moge-2"]; // => "megapixel"
 * ```
 */
export const callUnits: Readonly<Record<string, CallUnit>> = {
  "fal-ai/sam-3/video-rle": "16-frames",
  "microsoft/moge-2": "megapixel"
};

/**
 * The error for an endpoint without a price row: a paid job never runs at an
 * unknown price. Terminal, before any upload or charge.
 *
 * @param endpoint - The fal endpoint id.
 * @returns The error to throw.
 * @example
 * ```ts
 * callNoPriceError("x/y").status; // => 400
 * ```
 */
export function callNoPriceError(endpoint: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] No price for fal endpoint "${endpoint}".\n  Add "call:${endpoint}" to fal.priceOverrides (USD per request).`,
    BAD_REQUEST
  );
}

/**
 * The error for a megapixel endpoint whose input image is not a local file the
 * package can measure. Terminal, before any upload or charge.
 *
 * @param endpoint - The fal endpoint id.
 * @returns The error to throw.
 * @example
 * ```ts
 * callCannotPriceError("microsoft/moge-2").status; // => 400
 * ```
 */
export function callCannotPriceError(endpoint: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] Cannot price fal endpoint "${endpoint}".\n  It is billed per megapixel of input.image_url: pass that image as a local PNG, JPEG or WebP file.`,
    BAD_REQUEST
  );
}

/**
 * USD per billed unit of one endpoint: `call:<endpoint>` from the merged table.
 *
 * @param prices - The merged price table (prefixed keys).
 * @param endpoint - The fal endpoint id.
 * @returns USD per unit.
 * @throws {TerminalProviderError} A 400 when the endpoint has no row.
 * @example
 * ```ts
 * callRate({ "call:fal-ai/sam-3/image": 0.005 }, "fal-ai/sam-3/image"); // => 0.005
 * ```
 */
export function callRate(prices: Readonly<Record<string, number>>, endpoint: string): number {
  const rate = prices[`call:${endpoint}`];
  if (rate === undefined) throw callNoPriceError(endpoint);
  return rate;
}

/**
 * How fal bills an endpoint: its own key of `callUnits`, else per request.
 *
 * @param endpoint - The fal endpoint id.
 * @returns The billing unit.
 * @example
 * ```ts
 * callUnitOf("fal-ai/sam-3/video-rle"); // => "16-frames"
 * callUnitOf("fal-ai/sam-3/image"); // => "request"
 * ```
 */
export function callUnitOf(endpoint: string): CallUnit {
  return Object.hasOwn(callUnits, endpoint) ? (callUnits[endpoint] ?? "request") : "request";
}

/**
 * Billed megapixels of an image, rounded up to the next whole megapixel.
 *
 * @param size - Width and height in pixels.
 * @param size.width - Width in pixels.
 * @param size.height - Height in pixels.
 * @returns The units.
 * @example
 * ```ts
 * megapixelsOf({ width: 1080, height: 1920 }); // => 3
 * ```
 */
export function megapixelsOf(size: { width: number; height: number }): number {
  return Math.ceil((size.width * size.height) / PIXELS_PER_MEGAPIXEL);
}

/**
 * Billed 16-frame blocks of a `sam-3/video-rle` answer: one `rle` entry per frame.
 *
 * @param result - fal's result body (untrusted).
 * @returns The units, or undefined when `rle` is not an array.
 * @example
 * ```ts
 * frameBlocksOf({ rle: Array.from({ length: 49 }, () => "r") }); // => 4
 * frameBlocksOf({}); // => undefined
 * ```
 */
export function frameBlocksOf(result: unknown): number | undefined {
  const rle = readField(result, "rle");
  if (!Array.isArray(rle)) return undefined;
  return Math.ceil(rle.length / FRAMES_PER_BLOCK);
}

/**
 * USD of one call: rate times units, rounded to micro-dollars.
 *
 * @param rate - USD per unit.
 * @param units - Billed units.
 * @returns USD for the call.
 * @example
 * ```ts
 * callCostUsd(0.01, 3); // => 0.03
 * ```
 */
export function callCostUsd(rate: number, units: number): number {
  return Math.round(rate * units * MICRO_DOLLARS) / MICRO_DOLLARS;
}
