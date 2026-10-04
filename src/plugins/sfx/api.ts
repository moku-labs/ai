/**
 * @file sfx plugin — API factory (`app.sfx.*`).
 *
 * Owns the single narrowing site for the "sfx" task: registry transports
 * providers' `SfxHandler` values as `unknown` (spec/09 R9's "genuine
 * dynamic boundary"), and this file narrows them back behind a runtime
 * shape guard, with no cast. An sfx handler is one-call only (`execute`).
 */
import { registryPlugin } from "../registry";
import type { SfxApi, SfxContext, SfxHandler } from "./types";

/**
 * The registry task key this plugin owns.
 */
const SFX_TASK = "sfx";

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
 * `SfxHandler`: both `estimate` and `execute` are functions. The single
 * narrowing site for the sfx task, with no cast (spec/09 R9).
 *
 * @param candidate - The raw value returned by `registry.resolve("sfx", name)`.
 * @returns True when `candidate` structurally satisfies `SfxHandler`.
 * @example
 * ```ts
 * isSfxHandler({ estimate: () => ({ usd: 0 }) }); // => false: no execute
 * ```
 */
export function isSfxHandler(candidate: unknown): candidate is SfxHandler {
  if (typeof candidate !== "object" || candidate === null) return false;
  return hasFunction(candidate, "estimate") && hasFunction(candidate, "execute");
}

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param name - The unregistered (or malformed) provider name that was requested.
 * @param available - Provider names currently registered for "sfx".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * unknownProviderError("acme", ["elevenlabs"]).message; // => '[ai] No sfx provider named "acme" is registered.\n  Available: elevenlabs.'
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No ${SFX_TASK} provider named "${name}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Resolves `provider`'s registered handler and narrows it with the one
 * audited guard, throwing the pinned error for an unregistered or malformed value.
 *
 * @param ctx - The sfx plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked handler.
 * @throws {Error} The pinned two-line "unknown provider" error.
 */
function resolveHandler(ctx: SfxContext, provider: string): SfxHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve(SFX_TASK, provider);
  if (!isSfxHandler(raw)) {
    throw unknownProviderError(provider, registry.providers(SFX_TASK));
  }
  return raw;
}

/**
 * Builds the handler call options, leaving `signal` out when absent
 * (`exactOptionalPropertyTypes`).
 *
 * @param signal - The caller's abort signal, if any.
 * @returns The options object passed to `execute`.
 * @example
 * ```ts
 * signalOptions(undefined); // => {}
 * ```
 */
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

/**
 * Creates the sfx API surface (`app.sfx.*`): resolve, audit, and
 * dispatch to registered "sfx" providers.
 *
 * @param ctx - The sfx plugin context.
 * @returns The `app.sfx` API.
 */
export function createSfxApi(ctx: SfxContext): SfxApi {
  return {
    generate: async (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.execute(request, signalOptions(opts?.signal));
    },
    estimate: (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.estimate(request);
    },
    providers: () => ctx.require(registryPlugin).providers(SFX_TASK)
  };
}
