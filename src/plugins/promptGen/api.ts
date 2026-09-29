/**
 * @file promptGen plugin — API factory (`app.promptGen.*`).
 *
 * Stateless facade over `registry`. `generate` walks the provider chain in
 * `./fallback`; `estimate` resolves the head of the chain through
 * `./resolve` and asks it for a cost. Neither path is journaled; the durable
 * path is `app.runner.run()`.
 */
import { registryPlugin } from "../registry";
import type { ProviderChain, SignalOptions } from "./fallback";
import { fallbackAfter, generateFrom } from "./fallback";
import { PROMPT_GEN_TASK, resolveHandler } from "./resolve";
import type { PromptGenApi, PromptGenContext, PromptGenRequest } from "./types";

/**
 * Resolves the provider at the head of the chain: the caller's explicit
 * override, else the plugin's configured default.
 *
 * @param ctx - The promptGen plugin context.
 * @param requestedProvider - An explicit provider override, if given.
 * @returns The provider name to try first.
 */
function resolveProviderName(ctx: PromptGenContext, requestedProvider: string | undefined): string {
  return requestedProvider ?? ctx.config.defaultProvider;
}

/**
 * Builds the options forwarded to `limits.acquire` and `execute()`, omitting
 * `signal` entirely rather than setting it to `undefined` (required under
 * `exactOptionalPropertyTypes`).
 *
 * @param opts - The caller-supplied generate options, if any.
 * @param opts.signal - Optional abort signal to cancel the request.
 * @returns The signal options.
 * @example
 * ```ts
 * toSignalOptions({}); // {}
 * ```
 */
function toSignalOptions(opts?: { signal?: AbortSignal }): SignalOptions {
  return opts?.signal === undefined ? {} : { signal: opts.signal };
}

/**
 * Creates the prompt-gen API surface (`generate`/`estimate`/`providers`).
 *
 * @param ctx - Plugin context: config, a `registry`-narrowed `require`, `log` and `limits`.
 * @returns The `app.promptGen` API.
 */
export function createPromptGenApi(ctx: PromptGenContext): PromptGenApi {
  return {
    generate: async (
      request: PromptGenRequest,
      opts?: { signal?: AbortSignal; provider?: string }
    ) => {
      const head = resolveProviderName(ctx, opts?.provider);
      const chain: ProviderChain = [head, ...fallbackAfter(ctx, head)];
      return generateFrom(ctx, chain, request, toSignalOptions(opts));
    },

    estimate: (request: PromptGenRequest, opts?: { provider?: string }) => {
      const provider = resolveProviderName(ctx, opts?.provider);
      return resolveHandler(ctx, provider).estimate(request);
    },

    providers: (): string[] => ctx.require(registryPlugin).providers(PROMPT_GEN_TASK)
  };
}
