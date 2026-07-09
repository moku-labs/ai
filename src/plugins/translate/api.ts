/**
 * @file translate plugin — API factory (`app.translate.*`).
 *
 * Stateless facade over `registry`: resolves the configured (or requested)
 * provider's handler, performs the plugin's one audited cast to
 * `TranslateHandler` (spec/09 R9), and either executes it immediately
 * (`generate`) or asks it for a cost estimate (`estimate`) — neither path is
 * journaled; the durable path is `app.runner.run()`.
 */
import { registryPlugin } from "../registry";
import type {
  TranslateApi,
  TranslateContext,
  TranslateHandler,
  TranslateRequest,
  TranslateResult
} from "./types";

const TRANSLATE_TASK = "translate";

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param provider - The requested provider name that has no registration.
 * @param available - Provider names currently registered for "translate".
 * @returns A two-line `Error` in the exact `[ai] No translate provider ...` format.
 * @example
 * ```ts
 * throw unknownProviderError("openai", []);
 * ```
 */
function unknownProviderError(provider: string, available: string[]): Error {
  const list = available.length > 0 ? available.join(", ") : "none";
  return new Error(
    `[ai] No translate provider named "${provider}" is registered.\n  Available: ${list}.`
  );
}

/**
 * Runtime shape guard for a value resolved from the registry: checks that
 * it exposes function-typed `estimate` and `execute` members before the
 * plugin's one audited cast to `TranslateHandler`. Narrows via `in` so the
 * check itself needs no cast.
 *
 * @param value - The value resolved from the registry for "translate".
 * @returns True when `value` has function-typed `estimate` and `execute` members.
 * @example
 * ```ts
 * if (!hasTranslateHandlerShape(resolved)) throw new Error("malformed handler");
 * ```
 */
function hasTranslateHandlerShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    "estimate" in value &&
    "execute" in value &&
    typeof value.estimate === "function" &&
    typeof value.execute === "function"
  );
}

/**
 * Resolves the provider to use for a request: the caller's explicit
 * override, else the plugin's configured default.
 *
 * @param ctx - The translate plugin context.
 * @param requestedProvider - An explicit provider override, if given.
 * @returns The provider name to resolve against the registry.
 * @example
 * ```ts
 * const provider = resolveProviderName(ctx, undefined); // => ctx.config.defaultProvider
 * ```
 */
function resolveProviderName(ctx: TranslateContext, requestedProvider: string | undefined): string {
  return requestedProvider ?? ctx.config.defaultProvider;
}

/**
 * Resolves and shape-guards the handler registered for `provider`, throwing
 * the pinned "unknown provider" error when nothing is registered and a
 * descriptive error when a registered value doesn't implement the contract.
 *
 * @param ctx - The translate plugin context.
 * @param provider - The provider name to resolve.
 * @returns The resolved `TranslateHandler`.
 * @throws {Error} When `provider` is unregistered, or the registered value is malformed.
 * @example
 * ```ts
 * const handler = resolveHandler(ctx, "openai");
 * ```
 */
function resolveHandler(ctx: TranslateContext, provider: string): TranslateHandler {
  const registry = ctx.require(registryPlugin);
  const resolved = registry.resolve(TRANSLATE_TASK, provider);

  if (resolved === undefined) {
    throw unknownProviderError(provider, registry.providers(TRANSLATE_TASK));
  }
  if (!hasTranslateHandlerShape(resolved)) {
    throw new Error(
      `[ai] Registered translate provider "${provider}" does not implement TranslateHandler.\n  It must expose estimate() and execute() functions.`
    );
  }

  // ONE audited cast at the resolve() call site, guarded above (spec/09 R9).
  return resolved as TranslateHandler;
}

/**
 * Builds the `execute()` options object from `generate()`'s caller-supplied
 * options, omitting `signal` entirely rather than setting it to `undefined`
 * (required under `exactOptionalPropertyTypes`).
 *
 * @param opts - The caller-supplied generate options, if any.
 * @param opts.signal - Optional abort signal to forward, if provided.
 * @returns The options object to forward to `TranslateHandler.execute`.
 * @example
 * ```ts
 * const executeOptions = toExecuteOptions({ signal: controller.signal });
 * ```
 */
function toExecuteOptions(opts?: { signal?: AbortSignal }): { signal?: AbortSignal } {
  return opts?.signal === undefined ? {} : { signal: opts.signal };
}

/**
 * Creates the translate API surface (`generate`/`estimate`/`providers`).
 *
 * @param ctx - Plugin context: config plus a `registry`-narrowed `require`.
 * @returns The `app.translate` API.
 * @example
 * ```ts
 * const api = createTranslateApi(ctx);
 * const result = await api.generate({ text: "Hello", targetLang: "es" });
 * ```
 */
export function createTranslateApi(ctx: TranslateContext): TranslateApi {
  return {
    /**
     * One-off direct translation — resolves the configured (or requested)
     * provider, performs the plugin's one audited cast to
     * `TranslateHandler`, and executes it immediately. NOT journaled: this
     * is the direct facade path, not the durable path — use
     * `app.runner.run()` for resumable, progress-tracked execution.
     *
     * @param request - The translate request.
     * @param opts - Optional abort signal and provider override.
     * @param opts.signal - Optional abort signal to cancel the request.
     * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
     * @returns The translated text, cost, and metadata.
     * @throws {Error} When the resolved provider is unregistered or malformed.
     * @example
     * ```ts
     * const result = await app.translate.generate({ text: "Hello", targetLang: "es" });
     * ```
     */
    generate: async (
      request: TranslateRequest,
      opts?: { signal?: AbortSignal; provider?: string }
    ): Promise<TranslateResult> => {
      const provider = resolveProviderName(ctx, opts?.provider);
      const handler = resolveHandler(ctx, provider);
      return handler.execute(request, toExecuteOptions(opts));
    },
    /**
     * Cost estimate without executing.
     *
     * @param request - The translate request to estimate.
     * @param opts - Optional provider override.
     * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
     * @returns The estimated cost in USD.
     * @throws {Error} When the resolved provider is unregistered or malformed.
     * @example
     * ```ts
     * const { usd } = app.translate.estimate({ text: "Hello", targetLang: "es" });
     * ```
     */
    estimate: (request: TranslateRequest, opts?: { provider?: string }): { usd: number } => {
      const provider = resolveProviderName(ctx, opts?.provider);
      const handler = resolveHandler(ctx, provider);
      return handler.estimate(request);
    },
    /**
     * Registered translate providers.
     *
     * @returns Provider names in registration order (first = task default).
     * @example
     * ```ts
     * const names = app.translate.providers();
     * ```
     */
    providers: (): string[] => ctx.require(registryPlugin).providers(TRANSLATE_TASK)
  };
}
