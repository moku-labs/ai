/**
 * @file promptGen plugin — API factory (`app.promptGen.*`).
 *
 * Stateless facade over `registry`: resolves the configured (or requested)
 * provider's handler, performs the plugin's one audited cast to
 * `PromptGenHandler` (spec/09 R9), and either executes it (`generate`) or asks
 * it for a cost estimate (`estimate`). `generate` runs each attempt inside the
 * provider's `limits` lane and walks the `fallback` chain while providers are
 * unavailable. Neither path is journaled; the durable path is
 * `app.runner.run()`.
 */
import type { RegistryApi } from "../registry";
import { registryPlugin } from "../registry";
import { isPromptGenUnavailable } from "./contract";
import type {
  PromptGenApi,
  PromptGenContext,
  PromptGenHandler,
  PromptGenRequest,
  PromptGenResult
} from "./types";

const PROMPT_GEN_TASK = "prompt-gen";

/** A provider chain with at least one name: its head is always tried. */
type ProviderChain = [string, ...string[]];

/** The abort signal forwarded to `limits.acquire` and `PromptGenHandler.execute`. */
type SignalOptions = { signal?: AbortSignal };

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param provider - The requested provider name that has no registration.
 * @param available - Provider names currently registered for "prompt-gen".
 * @returns A two-line `Error` in the exact `[ai] No prompt-gen provider ...` format.
 * @example
 * ```ts
 * unknownProviderError("acme", ["openai"]).message; // '[ai] No prompt-gen provider named "acme" is registered.\n  Available: openai.'
 * ```
 */
function unknownProviderError(provider: string, available: string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No prompt-gen provider named "${provider}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Runtime shape guard for a value resolved from the registry: checks that it
 * exposes function-typed `estimate` and `execute` members before the
 * plugin's one audited cast to `PromptGenHandler`. Narrows via `in` so the
 * check itself needs no cast.
 *
 * @param value - The value resolved from the registry for "prompt-gen".
 * @returns True when `value` has function-typed `estimate` and `execute` members.
 * @example
 * ```ts
 * hasPromptGenHandlerShape({ estimate: 123, execute: "nope" }); // false
 * ```
 */
function hasPromptGenHandlerShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    "estimate" in value &&
    "execute" in value &&
    typeof value.estimate === "function" &&
    typeof value.execute === "function"
  );
}

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
 * Tells whether `provider` has a registration for the "prompt-gen" task.
 *
 * @param registry - The registry API.
 * @param provider - The provider name to look up.
 * @returns True when a handler is registered under `provider`.
 */
function isRegistered(registry: RegistryApi, provider: string): boolean {
  return registry.resolve(PROMPT_GEN_TASK, provider) !== undefined;
}

/**
 * Resolves and shape-guards the handler registered for `provider`, throwing
 * the pinned "unknown provider" error when nothing is registered and a
 * descriptive error when a registered value doesn't implement the contract.
 *
 * @param ctx - The promptGen plugin context.
 * @param provider - The provider name to resolve.
 * @returns The resolved `PromptGenHandler`.
 * @throws {Error} When `provider` is unregistered, or the registered value is malformed.
 */
function resolveHandler(ctx: PromptGenContext, provider: string): PromptGenHandler {
  const registry = ctx.require(registryPlugin);
  const resolved = registry.resolve(PROMPT_GEN_TASK, provider);

  if (resolved === undefined) {
    throw unknownProviderError(provider, registry.providers(PROMPT_GEN_TASK));
  }
  if (!hasPromptGenHandlerShape(resolved)) {
    throw new Error(
      `[ai] Registered prompt-gen provider "${provider}" is malformed.\n  Expected an object with estimate() and execute() functions.`
    );
  }

  // ONE audited cast at the resolve() call site, guarded above (spec/09 R9):
  // registry.resolve() returns unknown by design (registry is a dumb
  // transport) — the shape guard just verified estimate()/execute()
  // functions exist before trusting `resolved` as a PromptGenHandler.
  return resolved as PromptGenHandler;
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
 * toSignalOptions({ provider: "codex" }); // {}
 * ```
 */
function toSignalOptions(opts?: { signal?: AbortSignal }): SignalOptions {
  return opts?.signal === undefined ? {} : { signal: opts.signal };
}

/**
 * The fallback providers that follow `head`: de-duplicated (first occurrence
 * kept) and without `head`. Unregistered names stay in the list; the walk
 * skips them only when it reaches them.
 *
 * @param ctx - The promptGen plugin context.
 * @param head - The provider tried first.
 * @returns The fallback provider names, in order.
 */
function fallbackAfter(ctx: PromptGenContext, head: string): string[] {
  return [...new Set(ctx.config.fallback)].filter(provider => provider !== head);
}

/**
 * The `limits` lane of a provider's direct calls: the same key the runner uses.
 *
 * @param provider - The provider name.
 * @returns The lane key.
 * @example
 * ```ts
 * laneOf("claude"); // "prompt-gen/claude/default"
 * ```
 */
function laneOf(provider: string): string {
  return `${PROMPT_GEN_TASK}/${provider}/default`;
}

/**
 * Tells whether an error is the `limits` rejection for an open breaker.
 *
 * @param error - Any thrown value.
 * @returns True when `error.reason` is `"breaker-open"`.
 * @example
 * ```ts
 * isBreakerOpen({ reason: "breaker-open" }); // true
 * ```
 */
function isBreakerOpen(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "reason" in error && error.reason === "breaker-open";
}

/**
 * Tells whether the chain may move on after `error`: the caller did not
 * abort, and the provider is unavailable or its lane's breaker is open.
 *
 * @param error - The error of the failed attempt.
 * @param signal - The caller's abort signal, if any.
 * @returns True when the next provider may be tried.
 * @example
 * ```ts
 * canFallBack({ status: 429 }, undefined); // true
 * ```
 */
function canFallBack(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return false;
  return isBreakerOpen(error) || isPromptGenUnavailable(error);
}

/**
 * The `reason` logged with a provider switch: `error.reason` when set, else
 * `http-<status>`, else `"unavailable"`.
 *
 * @param error - The error that made the chain move on.
 * @returns The reason text.
 * @example
 * ```ts
 * fallbackReason({ status: 429 }); // "http-429"
 * ```
 */
function fallbackReason(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unavailable";
  if ("reason" in error && typeof error.reason === "string") return error.reason;
  if ("status" in error && typeof error.status === "number") return `http-${error.status}`;
  return "unavailable";
}

/**
 * One attempt: resolves the provider's handler, waits for its lane, executes,
 * and releases the lane whatever happens. Never reports an outcome: breaker
 * state stays owned by the runner.
 *
 * @param ctx - The promptGen plugin context.
 * @param provider - The provider to ask.
 * @param request - The prompt-gen request.
 * @param options - The caller's abort signal.
 * @returns The result, with `meta.provider` set to `provider`.
 */
async function attempt(
  ctx: PromptGenContext,
  provider: string,
  request: PromptGenRequest,
  options: SignalOptions
): Promise<PromptGenResult> {
  const handler = resolveHandler(ctx, provider);
  const { release } = await ctx.limits.acquire(laneOf(provider), options);

  try {
    const result = await handler.execute(request, options);
    return { ...result, meta: { ...result.meta, provider } };
  } finally {
    release();
  }
}

/**
 * Walks the chain from its head: returns the first answer, moves on only
 * while providers are unavailable, and rethrows the last error. A fallback
 * name with no registration is skipped with a `prompt-gen:fallback-skip`
 * warn, only when the walk reaches it.
 *
 * @param ctx - The promptGen plugin context.
 * @param chain - The providers to try, head first.
 * @param request - The prompt-gen request.
 * @param options - The caller's abort signal.
 * @returns The answering provider's result.
 */
async function generateFrom(
  ctx: PromptGenContext,
  chain: ProviderChain,
  request: PromptGenRequest,
  options: SignalOptions
): Promise<PromptGenResult> {
  const [head, ...fallback] = chain;
  const registry = ctx.require(registryPlugin);
  let lastError: unknown;
  let from = head;

  // The head is always tried: an unregistered head throws the pinned error.
  try {
    return await attempt(ctx, head, request, options);
  } catch (error) {
    if (!canFallBack(error, options.signal)) throw error;
    lastError = error;
  }

  // Each fallback is tried in order, one at a time.
  for (const provider of fallback) {
    if (!isRegistered(registry, provider)) {
      ctx.log.warn("prompt-gen:fallback-skip", { provider, reason: "unregistered" });
      continue;
    }

    ctx.log.warn("prompt-gen:fallback", { from, to: provider, reason: fallbackReason(lastError) });
    try {
      return await attempt(ctx, provider, request, options);
    } catch (error) {
      if (!canFallBack(error, options.signal)) throw error;
      lastError = error;
      from = provider;
    }
  }

  throw lastError;
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
