/**
 * @file dialogue plugin — API factory (`app.dialogue.*`).
 *
 * Owns the single narrowing site for the "dialogue" task: registry transports
 * providers' `DialogueHandler` values as `unknown` (spec/09 R9's "genuine
 * dynamic boundary"), and this file narrows them back behind a runtime
 * shape guard, with no cast. A dialogue handler is estimate + execute (no submit/poll).
 */
import { registryPlugin } from "../registry";
import type { DialogueApi, DialogueContext, DialogueHandler } from "./types";

/**
 * The registry task key this plugin owns.
 */
const DIALOGUE_TASK = "dialogue";

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
 * `DialogueHandler`: both `estimate` and `execute` are functions. The single
 * narrowing site for the dialogue task, with no cast (spec/09 R9).
 *
 * @param candidate - The raw value returned by `registry.resolve("dialogue", name)`.
 * @returns True when `candidate` structurally satisfies `DialogueHandler`.
 * @example
 * ```ts
 * isDialogueHandler({ estimate: () => ({ usd: 0 }) }); // => false: no execute
 * ```
 */
export function isDialogueHandler(candidate: unknown): candidate is DialogueHandler {
  if (typeof candidate !== "object" || candidate === null) return false;
  return hasFunction(candidate, "estimate") && hasFunction(candidate, "execute");
}

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param name - The unregistered (or malformed) provider name that was requested.
 * @param available - Provider names currently registered for "dialogue".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * unknownProviderError("acme", ["elevenlabs"]).message; // => '[ai] No dialogue provider named "acme" is registered.\n  Available: elevenlabs.'
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No ${DIALOGUE_TASK} provider named "${name}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Resolves `provider`'s registered handler and narrows it with the one
 * audited guard, throwing the pinned error for an unregistered or malformed value.
 *
 * @param ctx - The dialogue plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked handler.
 * @throws {Error} The pinned two-line "unknown provider" error.
 */
function resolveHandler(ctx: DialogueContext, provider: string): DialogueHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve(DIALOGUE_TASK, provider);
  if (!isDialogueHandler(raw)) {
    throw unknownProviderError(provider, registry.providers(DIALOGUE_TASK));
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
 * Creates the dialogue API surface (`app.dialogue.*`): resolve, audit, and
 * dispatch to registered "dialogue" providers.
 *
 * @param ctx - The dialogue plugin context.
 * @returns The `app.dialogue` API.
 */
export function createDialogueApi(ctx: DialogueContext): DialogueApi {
  return {
    generate: async (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.execute(request, signalOptions(opts?.signal));
    },
    estimate: (request, opts) => {
      const handler = resolveHandler(ctx, opts?.provider ?? ctx.config.defaultProvider);
      return handler.estimate(request);
    },
    providers: () => ctx.require(registryPlugin).providers(DIALOGUE_TASK)
  };
}
