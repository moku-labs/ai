/**
 * @file promptGen plugin — API factory (`app.promptGen.*`).
 *
 * Stateless facade over `registry`: resolves the configured (or requested)
 * provider's handler, performs the plugin's one audited cast to
 * `PromptGenHandler` (spec/09 R9), and either executes it immediately
 * (`generate`) or asks it for a cost estimate (`estimate`) — neither path is
 * journaled; the durable path is `app.runner.run()`.
 */
import { registryPlugin } from "../registry";
import type { PromptGenApi, PromptGenContext, PromptGenHandler, PromptGenRequest } from "./types";

const PROMPT_GEN_TASK = "prompt-gen";

/**
 * Builds the pinned two-line "unknown provider" error.
 *
 * @param provider - The requested provider name that has no registration.
 * @param available - Provider names currently registered for "prompt-gen".
 * @returns A two-line `Error` in the exact `[ai] No prompt-gen provider ...` format.
 * @example
 * ```ts
 * throw unknownProviderError("openai", []);
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
 * if (!hasPromptGenHandlerShape(resolved)) throw new Error("malformed handler");
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
 * Resolves the provider to use for a request: the caller's explicit
 * override, else the plugin's configured default.
 *
 * @param ctx - The promptGen plugin context.
 * @param requestedProvider - An explicit provider override, if given.
 * @returns The provider name to resolve against the registry.
 * @example
 * ```ts
 * const provider = resolveProviderName(ctx, undefined); // => ctx.config.defaultProvider
 * ```
 */
function resolveProviderName(ctx: PromptGenContext, requestedProvider: string | undefined): string {
  return requestedProvider ?? ctx.config.defaultProvider;
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
 * @example
 * ```ts
 * const handler = resolveHandler(ctx, "openai");
 * ```
 */
function resolveHandler(ctx: PromptGenContext, provider: string): PromptGenHandler {
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

/**
 * Builds the `execute()` options object from `generate()`'s caller-supplied
 * options, omitting `signal` entirely rather than setting it to `undefined`
 * (required under `exactOptionalPropertyTypes`).
 *
 * @param opts - The caller-supplied generate options, if any.
 * @param opts.signal - Optional abort signal to cancel the request.
 * @returns The options object to forward to `PromptGenHandler.execute`.
 * @example
 * ```ts
 * const executeOptions = toExecuteOptions({ signal: controller.signal });
 * ```
 */
function toExecuteOptions(opts?: { signal?: AbortSignal }): { signal?: AbortSignal } {
  return opts?.signal === undefined ? {} : { signal: opts.signal };
}

/**
 * Creates the prompt-gen API surface (`generate`/`estimate`/`providers`).
 *
 * @param ctx - Plugin context: config plus a `registry`-narrowed `require`.
 * @returns The `app.promptGen` API.
 * @example
 * ```ts
 * const api = createPromptGenApi(ctx);
 * const result = await api.generate({ prompt: "Describe a sunset." });
 * ```
 */
export function createPromptGenApi(ctx: PromptGenContext): PromptGenApi {
  return {
    /**
     * One-off text generation. NOT journaled — the durable, resumable path
     * is `app.runner.run()`.
     *
     * @param request - The prompt-gen request.
     * @param opts - Optional abort signal and provider override.
     * @param opts.signal - Optional abort signal to cancel the request.
     * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
     * @returns The generated text, cost, and metadata.
     * @example
     * ```ts
     * await app.promptGen.generate({ prompt: "Describe a sunset." });
     * ```
     */
    generate: async (
      request: PromptGenRequest,
      opts?: { signal?: AbortSignal; provider?: string }
    ) => {
      const provider = resolveProviderName(ctx, opts?.provider);
      const handler = resolveHandler(ctx, provider);
      return handler.execute(request, toExecuteOptions(opts));
    },
    /**
     * Cost estimate without executing.
     *
     * @param request - The prompt-gen request to estimate.
     * @param opts - Optional provider override.
     * @param opts.provider - Provider override; defaults to `config.defaultProvider`.
     * @returns The estimated cost in USD.
     * @example
     * ```ts
     * app.promptGen.estimate({ prompt: "Describe a sunset." });
     * ```
     */
    estimate: (request: PromptGenRequest, opts?: { provider?: string }) => {
      const provider = resolveProviderName(ctx, opts?.provider);
      const handler = resolveHandler(ctx, provider);
      return handler.estimate(request);
    },
    /**
     * Registered prompt-gen providers.
     *
     * @returns Provider names in registration order.
     * @example
     * ```ts
     * app.promptGen.providers(); // ["openai"]
     * ```
     */
    providers: (): string[] => ctx.require(registryPlugin).providers(PROMPT_GEN_TASK)
  };
}
