/**
 * @file elevenlabs bundled price table — data module. Voice models are keyed
 * by model id (USD per character); sfx rows are keyed
 * `sfx:<model>#second` (USD per started second) and `sfx:<model>#auto` (USD
 * for one generation whose length the model picks); music rows are keyed
 * `music:<model>` (USD per started minute). Approximate defaults; override
 * precisely via `config.priceOverrides`.
 */
import { TerminalProviderError } from "./errors";
import type { ElevenlabsContext } from "./types";

/** Key prefix of every sfx price row. */
const SFX_PRICE_PREFIX = "sfx:";

/** Key prefix of every music price row. */
const MUSIC_PRICE_PREFIX = "music:";

/** Milliseconds in a billed minute. */
const MS_PER_MINUTE = 60_000;

/** Cost precision: micro-dollars. */
const MICRO_DOLLARS = 1_000_000;

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/**
 * How an sfx generation is billed: per started second when the request sets
 * `durationMs`, or one flat `auto` price when the model picks the length.
 */
export type SfxPriceUnit = "second" | "auto";

/**
 * Bundled prices, in USD. Voice models: approximate per-character defaults.
 *
 * sfx rows are an ESTIMATE. ElevenLabs bills sound effects at 40 credits per
 * second and 200 credits for an auto-length generation
 * (https://help.elevenlabs.io/hc/en-us/articles/25735337678481), and lists the
 * SFX API at $0.12 per minute (https://elevenlabs.io/pricing/api), both checked
 * 2026-10-04. The per-credit USD rate is not published; $0.12/min gives $0.002
 * per second, and the same rate gives $0.01 for 200 credits. Correct them with
 * `priceOverrides` for your plan.
 *
 * music rows are an ESTIMATE too. ElevenLabs lists the Music API at $0.15 per
 * minute, one price for every music model (https://elevenlabs.io/pricing/api,
 * checked 2026-10-09). The page does not say how a part of a minute is billed,
 * so every started minute is counted: the estimate is never below the bill.
 */
export const bundledPrices: Record<string, number> = {
  eleven_multilingual_v2: 0.0003,
  eleven_turbo_v2_5: 0.000_15,
  eleven_flash_v2_5: 0.000_06,
  eleven_monolingual_v1: 0.0003,
  "sfx:eleven_text_to_sound_v2#second": 0.002,
  "sfx:eleven_text_to_sound_v2#auto": 0.01,
  "music:music_v1": 0.15,
  "music:music_v2": 0.15,
  "music:music_v2_5": 0.15
};

/**
 * Merges the bundled price table with config-supplied overrides (overrides
 * win on key conflicts — the standard shallow-merge precedence, spec/03).
 *
 * @param overrides - Per-model price overrides from `config.priceOverrides`.
 * @returns The effective price table.
 * @example
 * ```ts
 * mergePrices({ eleven_multilingual_v2: 0.0005 });
 * ```
 */
export function mergePrices(overrides: Record<string, number>): Record<string, number> {
  return { ...bundledPrices, ...overrides };
}

/**
 * Resolves the effective price table, computing and caching it into
 * `ctx.state.prices` on first use (spec/10 — "computed once at first use").
 * Shared by `api.ts` (`info()`) and `voiceover/handler.ts`
 * (`estimate()`/`execute()`) so both coordinate through root state rather
 * than importing each other.
 *
 * @param ctx - Plugin context exposing `config.priceOverrides` and the mutable `state.prices` cache.
 * @returns The effective price table.
 * @example
 * ```ts
 * const prices = resolvePrices(ctx);
 * ```
 */
export function resolvePrices(ctx: ElevenlabsContext): Record<string, number> {
  if (ctx.state.prices === null) {
    ctx.state.prices = mergePrices(ctx.config.priceOverrides);
  }
  return ctx.state.prices;
}

/**
 * Tells whether a price-table key is an sfx row rather than a voice model id.
 *
 * @param key - A key of the effective price table.
 * @returns True for an `sfx:` row.
 * @example
 * ```ts
 * isSfxPriceKey("sfx:eleven_text_to_sound_v2#auto"); // => true
 * ```
 */
export function isSfxPriceKey(key: string): boolean {
  return key.startsWith(SFX_PRICE_PREFIX);
}

/**
 * Reads the sfx price for `model` and `unit`. A paid job never runs at an
 * unknown price, so a missing row is a terminal error before any HTTP call.
 *
 * @param prices - The effective price table.
 * @param model - The sfx model id.
 * @param unit - `"second"` for per started second, `"auto"` for a model-picked length.
 * @returns The price in USD.
 * @throws {TerminalProviderError} Status 400 when the table has no row for `model` and `unit`.
 * @example
 * ```ts
 * sfxPriceOf(bundledPrices, "eleven_text_to_sound_v2", "second"); // => 0.002
 * ```
 */
export function sfxPriceOf(
  prices: Readonly<Record<string, number>>,
  model: string,
  unit: SfxPriceUnit
): number {
  const usd = prices[`${SFX_PRICE_PREFIX}${model}#${unit}`];
  if (usd === undefined) {
    throw new TerminalProviderError(
      `[ai] No price for ElevenLabs sfx model "${model}".\n  Add it to elevenlabs.priceOverrides.`,
      BAD_REQUEST
    );
  }
  return usd;
}

/**
 * Tells whether a price-table key is a music row rather than a voice model id.
 *
 * @param key - A key of the effective price table.
 * @returns True for a `music:` row.
 * @example
 * ```ts
 * isMusicPriceKey("music:music_v2_5"); // => true
 * ```
 */
export function isMusicPriceKey(key: string): boolean {
  return key.startsWith(MUSIC_PRICE_PREFIX);
}

/**
 * Prices one music track: every started minute at the `music:<model>` price.
 * A paid job never runs at an unknown price, so a missing row is a terminal
 * error before any HTTP call.
 *
 * @param prices - The effective price table.
 * @param model - The music model id.
 * @param lengthMs - Track length, ms.
 * @returns The price in USD, rounded to micro-dollars.
 * @throws {TerminalProviderError} Status 400 when the table has no row for `model`.
 * @example
 * ```ts
 * musicPriceOf(bundledPrices, "music_v2_5", 65_000); // => 0.3
 * ```
 */
export function musicPriceOf(
  prices: Readonly<Record<string, number>>,
  model: string,
  lengthMs: number
): number {
  const usd = prices[`${MUSIC_PRICE_PREFIX}${model}`];
  if (usd === undefined) {
    throw new TerminalProviderError(
      `[ai] No price for ElevenLabs music model "${model}".\n  Add it to elevenlabs.priceOverrides.`,
      BAD_REQUEST
    );
  }
  const minutes = Math.ceil(lengthMs / MS_PER_MINUTE);
  return Math.round(usd * minutes * MICRO_DOLLARS) / MICRO_DOLLARS;
}
