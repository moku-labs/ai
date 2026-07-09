/**
 * @file voiceover plugin — API factory (`app.voiceover.*`).
 *
 * Owns the ONE audited cast for the "voiceover" task: registry deliberately
 * transports providers' `VoiceoverHandler` values as `unknown` (spec/09 R9's
 * "genuine dynamic boundary" — it never inspects what it transports), and
 * this file is the one place that narrows it back to the known
 * `VoiceoverHandler` shape, guarded by a runtime check so a malformed
 * registration fails with a descriptive error instead of a crash.
 */
import { registryPlugin } from "../registry";
import { narrationPack } from "./packs/narration";
import type { VoiceoverApi, VoiceoverContext, VoiceoverHandler, VoiceoverRequest } from "./types";

/**
 * A versioned template pack, structurally: per-provider param presets keyed
 * by provider name. Matches the shape of `packs/narration.ts`'s export
 * without importing that module's `as const` literal type, so any future
 * pack (with a different provider key set) satisfies it too.
 *
 * @example
 * ```ts
 * const pack: TemplatePack = { name: "narration", version: "1.0.0", values: {} };
 * ```
 */
export type TemplatePack = {
  readonly name: string;
  readonly version: string;
  readonly values: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

/**
 * Merges a template pack's per-provider defaults with a request's own
 * params — request params win on key conflicts (ratified OQ5: `pack
 * defaults -> request params`, request wins). Exported (but not part of
 * `VoiceoverApi`) so the merge precedence rule is directly unit-testable
 * against any pack fixture, independent of the M0 `narrationPack`'s
 * current (empty) `values`.
 *
 * @param pack - The template pack whose per-provider `values` supply defaults.
 * @param provider - The resolved provider name to look up pack defaults for.
 * @param requestParameters - The request's own params, layered on top of pack defaults.
 * @returns The merged params object passed on to the provider handler.
 * @example
 * ```ts
 * mergePackParameters(narrationPack, "elevenlabs", { stability: 0.8 });
 * ```
 */
export function mergePackParameters(
  pack: TemplatePack,
  provider: string,
  requestParameters: Record<string, unknown> | undefined
): Record<string, unknown> {
  const packDefaults = pack.values[provider] ?? {};
  return { ...packDefaults, ...requestParameters };
}

/**
 * Runtime shape guard narrowing the registry's opaque `unknown` into a
 * `VoiceoverHandler`. This is the ONE audited cast site for the voiceover
 * task (spec/09 R9) — every required method is checked before the value is
 * trusted as a handler.
 *
 * @param candidate - The raw value returned by `registry.resolve()`.
 * @returns True when `candidate` structurally satisfies `VoiceoverHandler`.
 * @example
 * ```ts
 * if (isVoiceoverHandler(raw)) return raw;
 * ```
 */
function isVoiceoverHandler(candidate: unknown): candidate is VoiceoverHandler {
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
 * @param available - Provider names currently registered for "voiceover".
 * @returns A two-line `Error` listing the available providers, or "none".
 * @example
 * ```ts
 * throw unknownProviderError("acme", ["elevenlabs", "openai"]);
 * ```
 */
function unknownProviderError(name: string, available: readonly string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No voiceover provider named "${name}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Resolves `provider`'s registered handler and performs the one audited
 * cast, throwing the pinned two-line error for both an unregistered
 * provider and a registered-but-malformed value.
 *
 * @param ctx - The voiceover plugin context (used to reach the registry).
 * @param provider - The provider name to resolve.
 * @returns The resolved, shape-checked `VoiceoverHandler`.
 * @throws {Error} The pinned two-line "unknown provider" error.
 * @example
 * ```ts
 * const handler = resolveHandler(ctx, "elevenlabs");
 * ```
 */
function resolveHandler(ctx: VoiceoverContext, provider: string): VoiceoverHandler {
  const registry = ctx.require(registryPlugin);
  const raw = registry.resolve("voiceover", provider);
  if (!isVoiceoverHandler(raw)) {
    throw unknownProviderError(provider, registry.providers("voiceover"));
  }
  return raw;
}

/**
 * Resolves the final request passed to a provider handler: pack defaults
 * merged under the request's own params (request wins), and `format`
 * defaulted from `config.defaultFormat` when the request omits it.
 *
 * @param ctx - The voiceover plugin context (for `config.defaultFormat`).
 * @param request - The caller's original request.
 * @param provider - The resolved provider name (for pack lookup).
 * @returns The final request, ready to hand to a provider handler.
 * @example
 * ```ts
 * const resolved = resolveRequest(ctx, request, "elevenlabs");
 * ```
 */
function resolveRequest(
  ctx: VoiceoverContext,
  request: VoiceoverRequest,
  provider: string
): VoiceoverRequest {
  return {
    ...request,
    format: request.format ?? ctx.config.defaultFormat,
    params: mergePackParameters(narrationPack, provider, request.params)
  };
}

/**
 * Creates the voiceover API surface (`app.voiceover.*`): resolve, audit,
 * and dispatch to registered "voiceover" providers.
 *
 * @param ctx - The voiceover plugin context.
 * @returns The `app.voiceover` API.
 * @example
 * ```ts
 * const api = createVoiceoverApi(ctx);
 * const result = await api.generate({ text: "Hi", voice: "en-US-1" });
 * ```
 */
export function createVoiceoverApi(ctx: VoiceoverContext): VoiceoverApi {
  return {
    /**
     * One-off direct generation — resolves the named (or default)
     * provider, performs the one audited cast, and executes it. NOT
     * journaled; see the `VoiceoverApi.generate` JSDoc for the durable
     * alternative.
     *
     * @param request - The voiceover request.
     * @param opts - Optional abort signal and provider override.
     * @returns The generated audio result.
     * @example
     * ```ts
     * await api.generate({ text: "Hi", voice: "en-US-1" });
     * ```
     */
    async generate(request, opts) {
      const provider = opts?.provider ?? ctx.config.defaultProvider;
      const handler = resolveHandler(ctx, provider);
      const resolvedRequest = resolveRequest(ctx, request, provider);
      const { signal } = opts ?? {};
      return signal === undefined
        ? handler.execute(resolvedRequest, {})
        : handler.execute(resolvedRequest, { signal });
    },
    /**
     * Cost estimate without executing — delegates to the resolved
     * provider's own `estimate()`.
     *
     * @param request - The voiceover request to estimate.
     * @param opts - Optional provider override.
     * @returns The estimated cost in USD.
     * @example
     * ```ts
     * api.estimate({ text: "Hi", voice: "en-US-1" }); // => { usd: 0.00006 }
     * ```
     */
    estimate(request, opts) {
      const provider = opts?.provider ?? ctx.config.defaultProvider;
      const handler = resolveHandler(ctx, provider);
      const resolvedRequest = resolveRequest(ctx, request, provider);
      return handler.estimate(resolvedRequest);
    },
    /**
     * Registered voiceover providers, in registration order.
     *
     * @returns Registered provider names for the "voiceover" task.
     * @example
     * ```ts
     * api.providers(); // => ["elevenlabs", "openai"]
     * ```
     */
    providers() {
      return ctx.require(registryPlugin).providers("voiceover");
    }
  };
}
