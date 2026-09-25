/**
 * @file codex provider plugin — types (Config/State/API), the
 * runner-compatible provider error classes, and the domain context type
 * shared by `api.ts`, `prices.ts` and `image/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";

/**
 * codex plugin configuration: which CLI to run, which model and reasoning
 * effort to ask for, the per-call timeout, where per-call temp dirs live,
 * and per-model price overrides.
 *
 * @example
 * ```ts
 * const config: Config = {
 *   bin: "codex",
 *   model: "gpt-6-astra",
 *   reasoningEffort: "low",
 *   timeoutMs: 600_000,
 *   workDir: ".moku/tmp",
 *   priceOverrides: {}
 * };
 * ```
 */
export type Config = {
  /** Codex executable: a bare name looked up on PATH, or a path. Default: "codex". */
  bin: string;
  /** Codex model used when a request names none. Default: "gpt-6-astra". */
  model: string;
  /** Value passed as `-c model_reasoning_effort="<effort>"`. Default: "low". */
  reasoningEffort: string;
  /** Kill the CLI after this long, ms. Default: 600_000. */
  timeoutMs: number;
  /** Root directory for per-call temp dirs, resolved against the cwd. Default: ".moku/tmp". */
  workDir: string;
  /** USD per image by model, merged over the bundled table. Default: {}. */
  priceOverrides: Record<string, number>;
};

/**
 * codex plugin state: the effective price table, computed once at first
 * use (bundled prices merged with `config.priceOverrides`).
 *
 * @example
 * ```ts
 * const state: State = { prices: null };
 * ```
 */
export type State = {
  /** Effective price table, or null until first use. */
  prices: Record<string, number> | null;
};

/**
 * Provider info returned by `app.codex.info()`.
 *
 * @example
 * ```ts
 * const info: CodexInfo = { provider: "codex", configured: true, models: ["gpt-6-astra"] };
 * ```
 */
export type CodexInfo = {
  /** Provider name. */
  provider: "codex";
  /** True when `config.bin` resolves to an existing file (directly or on PATH). */
  configured: boolean;
  /** Models known to the effective price table. */
  models: string[];
};

/**
 * Public API surface of the `codex` plugin, exposed as `app.codex`. The real
 * capability surface is the registered `ImageHandler`, used through
 * `app.image` and `app.runner`.
 *
 * @example
 * ```ts
 * app.codex.info(); // => { provider: "codex", configured: true, models: ["gpt-6-astra"] }
 * ```
 */
export type CodexApi = {
  /**
   * Provider health/info for `moku status` and docs.
   *
   * @returns Whether the CLI is found, and the models with a known price.
   * @example
   * ```ts
   * // Before a keyframe run, check the Codex CLI is installed.
   * const { configured, models } = app.codex.info();
   * // configured: false when "codex" is not on PATH, models: ["gpt-6-astra"]
   * ```
   */
  info(): CodexInfo;
};

/**
 * Retryable failure: the CLI ran past `timeoutMs`. Carries `kind`, the
 * field the runner's `classifyError` reads to bucket it as retryable.
 */
export class RetryableProviderError extends Error {
  readonly kind: "timeout" | "network";

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable message (never the prompt).
   * @param kind - Retry classification read by the runner.
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] Codex timed out.", "timeout");
   * ```
   */
  constructor(message: string, kind: "timeout" | "network") {
    super(message);
    this.name = "RetryableProviderError";
    this.kind = kind;
  }
}

/**
 * Terminal failure: CLI missing, non-zero exit, or no image written. Has no
 * `kind` and no `status`, so the runner buckets it as "unknown" (terminal,
 * never retried).
 */
export class TerminalProviderError extends Error {
  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable two-line message (never the prompt).
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] Codex exited with code 1.\n  Run codex exec by hand.");
   * ```
   */
  constructor(message: string) {
    super(message);
    this.name = "TerminalProviderError";
  }
}

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context shared by `api.ts`, `prices.ts` and `image/handler.ts`:
 * `config`/`state`/`emit` from `PluginCtx`, `require` narrowed to the
 * registry, and the injected `env`/`log` core APIs.
 *
 * @example
 * ```ts
 * export const createCodexApi = (ctx: CodexContext): CodexApi => ({ ... });
 * ```
 */
export type CodexContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — used to read PATH for `info()`. */
  env: EnvApi;
  /** Structured logger — model and byte counts only, never the prompt. */
  log: LogApi;
};
