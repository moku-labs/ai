/**
 * @file asset plugin — API factory (`app.asset.*`).
 *
 * Owns the ONE audited cast for the "asset" task: registry transports
 * providers' `AssetHandler` values as `unknown` (spec/09 R9's "genuine
 * dynamic boundary"), and this file narrows them back behind a runtime
 * shape guard. Registration is async upstream, so the facade always runs an
 * in-memory, abortable submit/poll loop and parses the done `body`.
 */
import { registryPlugin } from "../registry";
import { parseAssetRecord } from "./contract";
import type { AssetApi, AssetContext, AssetHandler, AssetRecord, AssetRequest } from "./types";

/**
 * Checks that `candidate` has a function-valued property `key`.
 *
 * @param candidate - The object to inspect.
 * @param key - The property name.
 * @returns True when `candidate[key]` is a function.
 * @example
 * ```ts
 * hasFunction({ estimate: () => ({ usd: 0 }) }, "estimate"); // => true
 * ```
 */
function hasFunction(candidate: object, key: string): boolean {
  return typeof (candidate as Record<string, unknown>)[key] === "function";
}

/**
 * Runtime shape guard narrowing the registry's opaque `unknown` into an
 * `AssetHandler`: `estimate`, `submit` and `poll` are all functions.
 * This is the ONE audited cast site for the asset task (spec/09 R9).
 *
 * @param candidate - The raw value returned by `registry.resolve()`.
 * @returns True when `candidate` structurally satisfies `AssetHandler`.
 * @example
 * ```ts
 * isAssetHandler({ estimate: () => ({ usd: 0 }) }); // => false: no submit + poll
 * ```
 */
export function isAssetHandler(candidate: unknown): candidate is AssetHandler {
  if (typeof candidate !== "object" || candidate === null) return false;
  return (
    hasFunction(candidate, "estimate") &&
    hasFunction(candidate, "submit") &&
    hasFunction(candidate, "poll")
  );
}

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param name - The unregistered (or malformed) provider name that was requested.
 * @param available - Provider names currently registered for "asset".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * unknownProviderError("acme", ["ark"]).message; // => '[ai] No asset provider named "acme" is registered.\n  Available: ark.'
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(`[ai] No asset provider named "${name}" is registered.\n  Available: ${list}.`);
}

/**
 * Resolves `provider`'s registered handler and performs the one audited
 * cast, throwing the pinned error for an unregistered or malformed value.
 *
 * @param ctx - The asset plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked handler.
 * @throws {Error} The pinned two-line "unknown provider" error.
 */
function resolveHandler(ctx: AssetContext, provider: string): AssetHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve("asset", provider);
  if (!isAssetHandler(raw)) {
    throw unknownProviderError(provider, registry.providers("asset"));
  }
  return raw;
}

/**
 * Builds the handler call options, leaving `signal` out when absent
 * (`exactOptionalPropertyTypes`).
 *
 * @param signal - The caller's abort signal, if any.
 * @returns The options object passed to handler methods.
 * @example
 * ```ts
 * signalOptions(undefined); // => {}
 * ```
 */
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

/**
 * Waits `ms` milliseconds, rejecting with the signal's reason as soon as
 * the signal aborts (or at once when it is already aborted).
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Optional abort signal.
 * @returns A promise that resolves after the delay.
 * @example
 * ```ts
 * await wait(3000, AbortSignal.abort("stop")); // rejects with "stop" at once
 * ```
 */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    /** Cancels the pending timer and rejects with the abort reason. */
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one registration to completion: submits once, then polls every
 * `pollIntervalMs` until the job is done or failed.
 *
 * @param handler - The resolved asset handler.
 * @param request - The portrait to register.
 * @param pollIntervalMs - Delay between polls, ms.
 * @param signal - Optional abort signal; cancels calls and waits.
 * @returns The record parsed from the done poll's `body`.
 * @throws {unknown} The failed poll's `error` as-is, or the signal's reason on abort.
 */
async function runRegistration(
  handler: AssetHandler,
  request: AssetRequest,
  pollIntervalMs: number,
  signal: AbortSignal | undefined
): Promise<AssetRecord> {
  const options = signalOptions(signal);
  const { jobId } = await handler.submit(request, options);

  for (;;) {
    const status = await handler.poll(jobId, request, options);
    if (status.state === "done") return parseAssetRecord(status.body);
    if (status.state === "failed") throw status.error;
    await wait(pollIntervalMs, signal);
  }
}

/**
 * Creates the asset API surface (`app.asset.*`): resolve, audit, and
 * dispatch to registered "asset" providers.
 *
 * @param ctx - The asset plugin context.
 * @returns The `app.asset` API.
 */
export function createAssetApi(ctx: AssetContext): AssetApi {
  return {
    register: async (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return runRegistration(handler, request, ctx.config.pollIntervalMs, opts?.signal);
    },
    estimate: (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.estimate(request);
    },
    providers: () => ctx.require(registryPlugin).providers("asset")
  };
}
