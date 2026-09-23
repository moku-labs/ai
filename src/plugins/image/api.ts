/**
 * @file image plugin — API factory (`app.image.*`).
 *
 * Owns the ONE audited cast for the "image" task: registry deliberately
 * transports providers' `ImageHandler` values as `unknown` (spec/09 R9's
 * "genuine dynamic boundary"), and this file is the one place that narrows
 * it back to the known `ImageHandler` shape, guarded by a runtime check so a
 * malformed registration fails with a descriptive error instead of a crash.
 */
import { registryPlugin } from "../registry";
import type { ImageApi, ImageContext, ImageHandler } from "./types";

/** Registry task key owned by this plugin. */
const TASK = "image";

/**
 * Runtime shape guard narrowing the registry's opaque `unknown` into an
 * `ImageHandler`. This is the ONE audited cast site for the image task
 * (spec/09 R9) — every required method is checked before the value is
 * trusted as a handler.
 *
 * @param candidate - The raw value returned by `registry.resolve()`.
 * @returns True when `candidate` structurally satisfies `ImageHandler`.
 * @example
 * ```ts
 * if (isImageHandler(raw)) return raw;
 * ```
 */
function isImageHandler(candidate: unknown): candidate is ImageHandler {
  if (typeof candidate !== "object" || candidate === null) return false;
  return (
    "estimate" in candidate &&
    "execute" in candidate &&
    typeof candidate.estimate === "function" &&
    typeof candidate.execute === "function"
  );
}

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param name - The unregistered (or malformed) provider name that was requested.
 * @param available - Provider names currently registered for "image".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * throw unknownProviderError("acme", ["codex", "fal"]);
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(`[ai] No image provider named "${name}" is registered.\n  Available: ${list}.`);
}

/**
 * Resolves `provider`'s registered handler and performs the one audited
 * cast, throwing the pinned two-line error for both an unregistered provider
 * and a registered-but-malformed value.
 *
 * @param ctx - The image plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked `ImageHandler`.
 * @throws {Error} The pinned two-line "unknown provider" error.
 * @example
 * ```ts
 * const handler = resolveHandler(ctx, "codex");
 * ```
 */
function resolveHandler(ctx: ImageContext, provider: string): ImageHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve(TASK, provider);
  if (!isImageHandler(raw)) {
    throw unknownProviderError(provider, registry.providers(TASK));
  }
  return raw;
}

/**
 * Creates the image API surface (`app.image.*`): resolve, audit, and
 * dispatch to registered "image" providers.
 *
 * @param ctx - The image plugin context.
 * @returns The `app.image` API.
 * @example
 * ```ts
 * const api = createImageApi(ctx);
 * const result = await api.generate({ prompt: "a patisserie at night" });
 * ```
 */
export function createImageApi(ctx: ImageContext): ImageApi {
  return {
    /**
     * One-off direct generation — resolves the named (or default) provider,
     * performs the one audited cast, and executes it. NOT journaled.
     *
     * @param request - The image request.
     * @param opts - Optional provider override and abort signal.
     * @returns The generated image result.
     * @example
     * ```ts
     * await api.generate({ prompt: "a cat" });
     * ```
     */
    async generate(request, opts) {
      const provider = opts?.provider ?? ctx.config.defaultProvider;
      const handler = resolveHandler(ctx, provider);
      const { signal } = opts ?? {};
      return signal === undefined
        ? handler.execute(request, {})
        : handler.execute(request, { signal });
    },
    /**
     * Cost estimate without executing — delegates to the resolved
     * provider's own `estimate()`.
     *
     * @param request - The image request to estimate.
     * @param opts - Optional provider override.
     * @returns The estimated cost in USD.
     * @example
     * ```ts
     * api.estimate({ prompt: "a cat" }); // => { usd: 0.04 }
     * ```
     */
    estimate(request, opts) {
      const provider = opts?.provider ?? ctx.config.defaultProvider;
      return resolveHandler(ctx, provider).estimate(request);
    },
    /**
     * Registered image providers, in registration order (first = task default).
     *
     * @returns Registered provider names for the "image" task.
     * @example
     * ```ts
     * api.providers(); // => ["codex", "fal"]
     * ```
     */
    providers() {
      return ctx.require(registryPlugin).providers(TASK);
    }
  };
}
