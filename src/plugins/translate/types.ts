/**
 * @file translate plugin — type definitions (re-exports the contract).
 */
import type { TranslateRequest, TranslateResult } from "./contract";

export type { TranslateHandler, TranslateRequest, TranslateResult } from "./contract";

/**
 *
 */
export type Config = {
  /** Provider used when a request doesn't name one. */
  defaultProvider: string;
};

/**
 *
 */
export type TranslateApi = {
  generate(
    request: TranslateRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<TranslateResult>;
  estimate(request: TranslateRequest, opts?: { provider?: string }): { usd: number };
  providers(): string[];
};
