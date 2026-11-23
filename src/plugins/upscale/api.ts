/**
 * @file upscale plugin — API factory (`app.upscale.*`).
 *
 * Owns the single narrowing site for the "upscale" task: registry transports
 * providers' `UpscaleHandler` values as `unknown` (spec/09 R9's "genuine
 * dynamic boundary"), and this file narrows them back behind a runtime
 * shape guard, with no cast. The facade prefers `execute`; a submit/poll-only provider is
 * driven by an in-memory, abortable poll loop.
 */
import { registryPlugin } from "../registry";
import type {
  UpscaleApi,
  UpscaleContext,
  UpscaleHandler,
  UpscaleJobPoll,
  UpscaleRequest,
  UpscaleResult
} from "./types";

/**
 * The registry task key this plugin owns.
 */
const UPSCALE_TASK = "upscale";

/**
 * A handler that can upscale in one call.
 */
type ExecuteHandler = UpscaleHandler & { execute: NonNullable<UpscaleHandler["execute"]> };

/**
 * A handler with no `execute` that upscales through the async job pair.
 */
type JobHandler = Omit<UpscaleHandler, "execute"> & {
  execute?: undefined;
  submit: NonNullable<UpscaleHandler["submit"]>;
  poll: NonNullable<UpscaleHandler["poll"]>;
};

/**
 * A resolved, shape-checked upscale handler: either form of the contract.
 */
type ResolvedUpscaleHandler = ExecuteHandler | JobHandler;

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
  return typeof Reflect.get(candidate, key) === "function";
}

/**
 * Runtime shape guard narrowing the registry's opaque `unknown` into an
 * `UpscaleHandler`: `estimate` plus either `execute` or `submit` + `poll`.
 * The single narrowing site for the upscale task, with no cast (spec/09 R9).
 *
 * @param candidate - The raw value returned by `registry.resolve("upscale", name)`.
 * @returns True when `candidate` structurally satisfies `UpscaleHandler`.
 * @example
 * ```ts
 * isUpscaleHandler({ estimate: () => ({ usd: 0 }) }); // => false: no execute, no submit + poll
 * ```
 */
export function isUpscaleHandler(candidate: unknown): candidate is ResolvedUpscaleHandler {
  if (typeof candidate !== "object" || candidate === null) return false;
  if (!hasFunction(candidate, "estimate")) return false;

  const canExecute = hasFunction(candidate, "execute");
  const canRunJobs = hasFunction(candidate, "submit") && hasFunction(candidate, "poll");
  return canExecute || canRunJobs;
}

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param name - The unregistered (or malformed) provider name that was requested.
 * @param available - Provider names currently registered for "upscale".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * unknownProviderError("acme", ["fal"]).message; // => '[ai] No upscale provider named "acme" is registered.\n  Available: fal.'
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No ${UPSCALE_TASK} provider named "${name}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Resolves `provider`'s registered handler, throwing the pinned error for an
 * unregistered or malformed value.
 *
 * @param ctx - The upscale plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked handler.
 * @throws {Error} The pinned two-line "unknown provider" error.
 */
function resolveHandler(ctx: UpscaleContext, provider: string): ResolvedUpscaleHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve(UPSCALE_TASK, provider);
  if (!isUpscaleHandler(raw)) {
    throw unknownProviderError(provider, registry.providers(UPSCALE_TASK));
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
 * await wait(5000, AbortSignal.abort("stop")); // rejects with "stop" at once
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
 * Drops the `state` discriminant from a finished poll.
 *
 * @param status - A `done` poll.
 * @returns The plain upscale result.
 * @example
 * ```ts
 * toResult({ state: "done", video: new Uint8Array(), mimeType: "video/mp4", costUsd: 3.744 }); // => { video: Uint8Array [], mimeType: "video/mp4", costUsd: 3.744 }
 * ```
 */
function toResult(status: Extract<UpscaleJobPoll, { state: "done" }>): UpscaleResult {
  const { video, mimeType, costUsd, meta } = status;
  return meta === undefined ? { video, mimeType, costUsd } : { video, mimeType, costUsd, meta };
}

/**
 * Runs a submit/poll job to completion: submits once, then polls every
 * `pollIntervalMs` until the job is done or failed.
 *
 * @param handler - The job-capable handler.
 * @param request - The upscale request.
 * @param pollIntervalMs - Delay between polls, ms.
 * @param signal - Optional abort signal; cancels calls and waits.
 * @returns The finished upscale result.
 * @throws {unknown} The failed poll's `error` as-is, or the signal's reason on abort.
 */
async function runJob(
  handler: JobHandler,
  request: UpscaleRequest,
  pollIntervalMs: number,
  signal: AbortSignal | undefined
): Promise<UpscaleResult> {
  const options = signalOptions(signal);
  const { jobId } = await handler.submit(request, options);

  for (;;) {
    const status = await handler.poll(jobId, request, options);
    if (status.state === "done") return toResult(status);
    if (status.state === "failed") throw status.error;
    await wait(pollIntervalMs, signal);
  }
}

/**
 * Creates the upscale API surface (`app.upscale.*`): resolve, audit, and
 * dispatch to registered "upscale" providers.
 *
 * @param ctx - The upscale plugin context.
 * @returns The `app.upscale` API.
 */
export function createUpscaleApi(ctx: UpscaleContext): UpscaleApi {
  return {
    generate: async (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      const signal = opts?.signal;
      if (handler.execute !== undefined) {
        return handler.execute(request, signalOptions(signal));
      }
      return runJob(handler, request, ctx.config.pollIntervalMs, signal);
    },
    estimate: (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.estimate(request);
    },
    providers: () => ctx.require(registryPlugin).providers(UPSCALE_TASK)
  };
}
