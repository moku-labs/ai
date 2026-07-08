/**
 * @file promptGen plugin — type definitions (re-exports the contract).
 */
import type { PromptGenRequest, PromptGenResult } from "./contract";

export type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "./contract";

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
export type PromptGenApi = {
  generate(
    request: PromptGenRequest,
    opts?: { signal?: AbortSignal; provider?: string }
  ): Promise<PromptGenResult>;
  estimate(request: PromptGenRequest, opts?: { provider?: string }): { usd: number };
  providers(): string[];
};
