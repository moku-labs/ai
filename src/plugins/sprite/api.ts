/**
 * @file sprite plugin — API factory (`app.sprite.*`).
 *
 * Owns the single narrowing site for the "sprite" task: registry transports
 * providers' `SpriteHandler` values as `unknown` (spec/09 R9's "genuine
 * dynamic boundary"), and this file narrows them back behind a runtime
 * shape guard, with no cast. Sprite handlers are execute-only.
 */
import { registryPlugin } from "../registry";
import type { SpriteApi, SpriteContext, SpriteHandler } from "./types";

/**
 * The registry task key this plugin owns.
 */
const SPRITE_TASK = "sprite";

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
 * Runtime shape guard narrowing the registry's opaque `unknown` into a
 * `SpriteHandler`: `estimate` plus `execute`. The single narrowing site for
 * the sprite task, with no cast (spec/09 R9).
 *
 * @param candidate - The raw value returned by `registry.resolve("sprite", name)`.
 * @returns True when `candidate` structurally satisfies `SpriteHandler`.
 * @example
 * ```ts
 * isSpriteHandler({ estimate: () => ({ usd: 0 }) }); // => false: no execute
 * ```
 */
export function isSpriteHandler(candidate: unknown): candidate is SpriteHandler {
  if (typeof candidate !== "object" || candidate === null) return false;
  return hasFunction(candidate, "estimate") && hasFunction(candidate, "execute");
}

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param name - The unregistered (or malformed) provider name that was requested.
 * @param available - Provider names currently registered for "sprite".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * unknownProviderError("acme", ["fal"]).message; // => '[ai] No sprite provider named "acme" is registered.\n  Available: fal.'
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No ${SPRITE_TASK} provider named "${name}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Resolves `provider`'s registered handler and narrows it, throwing the
 * pinned error for an unregistered or malformed value.
 *
 * @param ctx - The sprite plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked handler.
 * @throws {Error} The pinned two-line "unknown provider" error.
 */
function resolveHandler(ctx: SpriteContext, provider: string): SpriteHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve(SPRITE_TASK, provider);
  if (!isSpriteHandler(raw)) {
    throw unknownProviderError(provider, registry.providers(SPRITE_TASK));
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
 * Creates the sprite API surface (`app.sprite.*`): resolve, narrow, and
 * dispatch to registered "sprite" providers.
 *
 * @param ctx - The sprite plugin context.
 * @returns The `app.sprite` API.
 */
export function createSpriteApi(ctx: SpriteContext): SpriteApi {
  return {
    generate: async (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.execute(request, signalOptions(opts?.signal));
    },
    estimate: (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.estimate(request);
    },
    providers: () => ctx.require(registryPlugin).providers(SPRITE_TASK)
  };
}
