/**
 * @file video plugin — API factory (`app.video.*`).
 *
 * Owns the ONE audited cast for the "video" task: registry transports
 * providers' `VideoHandler` values as `unknown` (spec/09 R9's "genuine
 * dynamic boundary"), and this file narrows them back behind a runtime
 * shape guard. The facade prefers `execute`; a submit/poll-only provider is
 * driven by an in-memory, abortable poll loop.
 */
import { registryPlugin } from "../registry";
import type {
  VideoApi,
  VideoContext,
  VideoHandler,
  VideoJobPoll,
  VideoRequest,
  VideoResult
} from "./types";

/**
 * A handler that can generate in one call.
 */
type ExecuteHandler = VideoHandler & { execute: NonNullable<VideoHandler["execute"]> };

/**
 * A handler with no `execute` that generates through the async job pair.
 */
type JobHandler = Omit<VideoHandler, "execute"> & {
  execute?: undefined;
  submit: NonNullable<VideoHandler["submit"]>;
  poll: NonNullable<VideoHandler["poll"]>;
};

/**
 * A resolved, shape-checked video handler: either form of the contract.
 */
type ResolvedVideoHandler = ExecuteHandler | JobHandler;

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
 * Runtime shape guard narrowing the registry's opaque `unknown` into a
 * `VideoHandler`: `estimate` plus either `execute` or `submit` + `poll`.
 * This is the ONE audited cast site for the video task (spec/09 R9).
 *
 * @param candidate - The raw value returned by `registry.resolve()`.
 * @returns True when `candidate` structurally satisfies `VideoHandler`.
 * @example
 * ```ts
 * isVideoHandler({ estimate: () => ({ usd: 0 }) }); // => false: no execute, no submit + poll
 * ```
 */
export function isVideoHandler(candidate: unknown): candidate is ResolvedVideoHandler {
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
 * @param available - Provider names currently registered for "video".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * unknownProviderError("acme", ["fal"]).message; // => '[ai] No video provider named "acme" is registered.\n  Available: fal.'
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(`[ai] No video provider named "${name}" is registered.\n  Available: ${list}.`);
}

/**
 * Resolves `provider`'s registered handler and performs the one audited
 * cast, throwing the pinned error for an unregistered or malformed value.
 *
 * @param ctx - The video plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked handler.
 * @throws {Error} The pinned two-line "unknown provider" error.
 */
function resolveHandler(ctx: VideoContext, provider: string): ResolvedVideoHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve("video", provider);
  if (!isVideoHandler(raw)) {
    throw unknownProviderError(provider, registry.providers("video"));
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
 * @returns The plain video result.
 * @example
 * ```ts
 * toResult({ state: "done", video: new Uint8Array(), mimeType: "video/mp4", costUsd: 0.3 }); // => { video: Uint8Array [], mimeType: "video/mp4", costUsd: 0.3 }
 * ```
 */
function toResult(status: Extract<VideoJobPoll, { state: "done" }>): VideoResult {
  const { video, mimeType, costUsd, meta } = status;
  return meta === undefined ? { video, mimeType, costUsd } : { video, mimeType, costUsd, meta };
}

/**
 * Runs a submit/poll job to completion: submits once, then polls every
 * `pollIntervalMs` until the job is done or failed.
 *
 * @param handler - The job-capable handler.
 * @param request - The video request.
 * @param pollIntervalMs - Delay between polls, ms.
 * @param signal - Optional abort signal; cancels calls and waits.
 * @returns The finished video result.
 * @throws {unknown} The failed poll's `error` as-is, or the signal's reason on abort.
 */
async function runJob(
  handler: JobHandler,
  request: VideoRequest,
  pollIntervalMs: number,
  signal: AbortSignal | undefined
): Promise<VideoResult> {
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
 * Creates the video API surface (`app.video.*`): resolve, audit, and
 * dispatch to registered "video" providers.
 *
 * @param ctx - The video plugin context.
 * @returns The `app.video` API.
 */
export function createVideoApi(ctx: VideoContext): VideoApi {
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
    providers: () => ctx.require(registryPlugin).providers("video")
  };
}
