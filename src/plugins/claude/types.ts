/**
 * @file claude provider plugin — types (Config/API), the runner-compatible
 * provider error classes, and the domain context type shared by `api.ts`
 * and `prompt/handler.ts`.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";

/**
 * claude plugin configuration: which CLI to run, the model fallback and
 * exact-id overrides, the per-call timeout, and where per-call temp dirs live.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { claude: { bin: "claude", textModel: "sonnet", timeoutMs: 120_000 } } });
 * ```
 */
export type Config = {
  /** Claude executable: a bare name looked up on PATH, or a path. Default: "claude". */
  bin: string;
  /** Model when mapping gives none; "" = no --model (the CLI's default). Default: "". */
  textModel: string;
  /** Exact request-model id → claude model, checked before the built-in mapping. Default: {}. */
  modelMap: Record<string, string>;
  /** Kill the CLI (SIGTERM) after this long, ms. Default: 600_000. */
  timeoutMs: number;
  /** Root for per-call temp dirs; "" = os.tmpdir(). Default: "". Kept outside the repo so no project CLAUDE.md is loaded. */
  workDir: string;
};

/**
 * `params.reasoning` values a prompt-gen request may carry.
 *
 * @example
 * ```ts
 * const reasoning: Reasoning = "off"; // sent as --effort low
 * ```
 */
export type Reasoning = "off" | "low" | "medium" | "high";

/**
 * Values passed to `claude --effort`.
 *
 * @example
 * ```ts
 * const effort: Effort = "medium";
 * ```
 */
export type Effort = "low" | "medium" | "high";

/**
 * `meta` of a claude prompt-gen result. Optional fields appear only when
 * they carry a value: `model` when `--model` was passed, `effort` when
 * `--effort` was passed, `modelRequested` when the request named a model,
 * `ignored` when the request set fields claude cannot honour.
 *
 * @example
 * ```ts
 * const meta: ClaudePromptMeta = {
 *   provider: "claude",
 *   model: "claude-opus-5-5",
 *   modelRequested: "anthropic/claude-opus-5.5",
 *   effort: "low",
 *   listCostUsd: 0.114_22,
 *   usage: { inputTokens: 12, outputTokens: 3 }
 * };
 * ```
 */
export type ClaudePromptMeta = {
  /** Provider name. */
  provider: "claude";
  /** Mapped model passed as `--model`. Absent: the CLI's default model. */
  model?: string;
  /** Model id as the request named it. */
  modelRequested?: string;
  /** Level passed as `--effort`. Absent: no `--effort` flag. */
  effort?: Effort;
  /** The CLI's own list price (`total_cost_usd`), for reference only. */
  listCostUsd: number;
  /** Token usage reported by the CLI. */
  usage: {
    /** Input tokens. */
    inputTokens: number;
    /** Output tokens. */
    outputTokens: number;
  };
  /** Request fields claude ignores, e.g. `["temperature"]`. */
  ignored?: string[];
};

/**
 * Provider info returned by `app.claude.info()`.
 *
 * @example
 * ```ts
 * const info: ClaudeInfo = { provider: "claude", configured: true };
 * ```
 */
export type ClaudeInfo = {
  /** Provider name. */
  provider: "claude";
  /** True when `config.bin` resolves to an existing file (directly or on PATH). */
  configured: boolean;
};

/**
 * Public API surface of the `claude` plugin, exposed as `app.claude`. The
 * real capability surface is the registered `PromptGenHandler`, used through
 * `app.promptGen` and `app.runner`.
 *
 * @example
 * ```ts
 * app.claude.info(); // => { provider: "claude", configured: true }
 * ```
 */
export type ClaudeApi = {
  /**
   * Provider health/info for `moku status` and docs. A path-like `bin` is
   * checked directly; a bare name is searched in PATH, read through `ctx.env`.
   *
   * @returns Whether the Claude Code CLI is found.
   * @example
   * ```ts
   * // Before a scoring run, check that Claude Code is installed on this machine.
   * const { configured } = app.claude.info();
   * // configured: false when "claude" is not on PATH, so promptGen will fall back
   * ```
   */
  info(): ClaudeInfo;
};

/**
 * Retryable failure: the CLI ran past `timeoutMs`. Carries `kind`, the
 * field the runner's `classifyError` reads to bucket it as retryable.
 */
export class RetryableProviderError extends Error {
  /** Retry classification read by the runner's classifyError. */
  readonly kind: "timeout" | "network";

  /**
   * Creates a retryable provider error.
   *
   * @param message - Human-readable two-line message (never the prompt).
   * @param kind - Retry classification read by the runner.
   */
  constructor(message: string, kind: "timeout" | "network") {
    super(message);
    this.name = "RetryableProviderError";
    this.kind = kind;
  }
}

/**
 * Terminal failure: the CLI could not start, exited without a JSON result,
 * reported an error, wrote no answer, or answered off-schema. Has no `kind`
 * and no `status`, so the runner buckets it as "unknown" (never retried)
 * and promptGen never falls back on it.
 */
export class TerminalProviderError extends Error {
  /**
   * Creates a terminal provider error.
   *
   * @param message - Human-readable two-line message (never the prompt).
   */
  constructor(message: string) {
    super(message);
    this.name = "TerminalProviderError";
  }
}

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context shared by `api.ts` and `prompt/handler.ts`: `config` and
 * `emit` from `PluginCtx` (no state), `require` narrowed to the registry,
 * and the injected `env`/`log` core APIs.
 */
export type ClaudeContext = PluginCtx<Config, Record<string, never>> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Resolved-environment accessor — used to read PATH for `info()`. */
  env: EnvApi;
  /** Structured logger — model and text length only, never the prompt or the answer. */
  log: LogApi;
};
