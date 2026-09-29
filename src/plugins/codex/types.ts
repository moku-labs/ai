/**
 * @file codex provider plugin — types (Config/State/API), the
 * runner-compatible provider error types (the classes live in `./errors`),
 * and the domain context type shared by `api.ts`, `prices.ts`,
 * `image/handler.ts` and `prompt/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type {
  RetryableProviderError as RetryableProviderErrorClass,
  TerminalProviderError as TerminalProviderErrorClass
} from "./errors";

/**
 * codex plugin configuration: which CLI to run, which image and text models
 * and reasoning effort to ask for, the per-call timeout, where per-call temp
 * dirs live, per-model image price overrides, and the prompt-gen model map.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { codex: { textModel: "gpt-6-sol", timeoutMs: 600_000 } } });
 * ```
 */
export type Config = {
  /** Codex executable: a bare name looked up on PATH, or a path. Default: "codex". */
  bin: string;
  /** Image model used when an image request names none. Default: "gpt-6-astra". */
  model: string;
  /** Value passed as `-c model_reasoning_effort="<effort>"` for both tasks. Default: "low". */
  reasoningEffort: string;
  /** Kill the CLI after this long, ms. Default: 600_000. */
  timeoutMs: number;
  /** Root for per-call temp dirs, resolved against the cwd; "" = os.tmpdir(). Default: ".moku/tmp". */
  workDir: string;
  /** USD per image by model, merged over the bundled table. Default: {}. */
  priceOverrides: Record<string, number>;
  /** Prompt-gen model when the request model maps to none; "" leaves `-m` out (codex's own default). Default: "". */
  textModel: string;
  /** Exact request-model id (OpenRouter style) to codex model, checked before every other mapping rule. Default: {}. */
  modelMap: Record<string, string>;
};

/**
 * codex plugin state: the effective price table, computed once at first
 * use (bundled prices merged with `config.priceOverrides`).
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

// Type aliases, not `export type { … } from "./errors"`: the .d.ts bundler turns a type-only
// class re-export back into `declare class`, so `Codex.X` would pass tsc as a value that is
// `undefined` at runtime. The classes ship as values in `CodexErrors` from the package root.
/** Instance type of the retryable provider error; the class is `CodexErrors.RetryableProviderError`. */
export type RetryableProviderError = RetryableProviderErrorClass;
/** Instance type of the terminal provider error; the class is `CodexErrors.TerminalProviderError`. */
export type TerminalProviderError = TerminalProviderErrorClass;

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context shared by `api.ts`, `prices.ts`, `image/handler.ts` and
 * `prompt/handler.ts`:
 * `config`/`state`/`emit` from `PluginCtx`, `require` narrowed to the
 * registry, and the injected `env`/`log` core APIs.
 */
export type CodexContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — used to read PATH for `info()`. */
  env: EnvApi;
  /** Structured logger — model and byte counts only, never the prompt. */
  log: LogApi;
};
