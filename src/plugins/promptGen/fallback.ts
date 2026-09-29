/**
 * @file promptGen plugin — the fallback walk behind `generate`.
 *
 * Runs each attempt inside the provider's `limits` lane and moves along the
 * provider chain only while providers are unavailable. Never journaled and
 * never reports lane outcomes: breaker state stays owned by the runner.
 */
import { registryPlugin } from "../registry";
import { isPromptGenUnavailable } from "./contract";
import { isRegistered, PROMPT_GEN_TASK, resolveHandler } from "./resolve";
import type { PromptGenContext, PromptGenRequest, PromptGenResult } from "./types";

/** A provider chain with at least one name: its head is always tried. */
export type ProviderChain = [string, ...string[]];

/** The abort signal forwarded to `limits.acquire` and `PromptGenHandler.execute`. */
export type SignalOptions = { signal?: AbortSignal };

/** How one attempt settled: the provider's result, or what it threw. */
type AttemptOutcome = { result: PromptGenResult } | { error: unknown };

/**
 * The fallback providers that follow `head`: de-duplicated (first occurrence
 * kept) and without `head`. Unregistered names stay in the list; the walk
 * skips them only when it reaches them.
 *
 * @param ctx - The promptGen plugin context.
 * @param head - The provider tried first.
 * @returns The fallback provider names, in order.
 */
export function fallbackAfter(ctx: PromptGenContext, head: string): string[] {
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
 * Runs one attempt and captures its failure as a value, so the walk decides
 * what to do with it without a nested try/catch.
 *
 * @param ctx - The promptGen plugin context.
 * @param provider - The provider to ask.
 * @param request - The prompt-gen request.
 * @param options - The caller's abort signal.
 * @returns `{ result }` when the provider answered, `{ error }` when the attempt threw.
 */
async function attemptOrCapture(
  ctx: PromptGenContext,
  provider: string,
  request: PromptGenRequest,
  options: SignalOptions
): Promise<AttemptOutcome> {
  try {
    return { result: await attempt(ctx, provider, request, options) };
  } catch (error) {
    return { error };
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
 * @throws {unknown} The first error that is not "unavailable", or the last error when every provider is unavailable.
 */
export async function generateFrom(
  ctx: PromptGenContext,
  chain: ProviderChain,
  request: PromptGenRequest,
  options: SignalOptions
): Promise<PromptGenResult> {
  const [head, ...fallback] = chain;
  const registry = ctx.require(registryPlugin);

  // The head is always tried: an unregistered head throws the pinned error.
  const headOutcome = await attemptOrCapture(ctx, head, request, options);
  if ("result" in headOutcome) return headOutcome.result;
  if (!canFallBack(headOutcome.error, options.signal)) throw headOutcome.error;

  let lastError = headOutcome.error;
  let from = head;

  // Each fallback is tried in order, one at a time; an unregistered one is skipped.
  for (const provider of fallback) {
    if (!isRegistered(registry, provider)) {
      ctx.log.warn("prompt-gen:fallback-skip", { provider, reason: "unregistered" });
      continue;
    }

    ctx.log.warn("prompt-gen:fallback", { from, to: provider, reason: fallbackReason(lastError) });
    const outcome = await attemptOrCapture(ctx, provider, request, options);
    if ("result" in outcome) return outcome.result;
    if (!canFallBack(outcome.error, options.signal)) throw outcome.error;

    lastError = outcome.error;
    from = provider;
  }

  // Every provider was unavailable: surface the last one's error.
  throw lastError;
}
