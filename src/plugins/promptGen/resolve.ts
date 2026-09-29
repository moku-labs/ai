/**
 * @file promptGen plugin — provider resolution.
 *
 * Looks a provider up in `registry` under the "prompt-gen" task, shape-guards
 * what comes back, and performs the plugin's ONE audited cast to
 * `PromptGenHandler` (spec/09 R9).
 */
import type { RegistryApi } from "../registry";
import { registryPlugin } from "../registry";
import type { PromptGenContext, PromptGenHandler } from "./types";

/** The registry/task key every prompt-gen provider registers under. */
export const PROMPT_GEN_TASK = "prompt-gen";

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
 * Tells whether `provider` has a registration for the "prompt-gen" task.
 *
 * @param registry - The registry API.
 * @param provider - The provider name to look up.
 * @returns True when a handler is registered under `provider`.
 */
export function isRegistered(registry: RegistryApi, provider: string): boolean {
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
export function resolveHandler(ctx: PromptGenContext, provider: string): PromptGenHandler {
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
