/**
 * @file openai provider plugin — types (config, state, structural OpenaiClient,
 * request/response shapes, domain context) + provider error classes.
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";

/**
 * openai plugin configuration: which env var holds the API key, an optional
 * base URL override (proxies / OpenAI-compatible endpoints), default models
 * per capability, the request timeout, and per-model price overrides.
 *
 * @example
 * ```ts
 * const config: Config = {
 *   apiKeyEnv: "OPENAI_API_KEY",
 *   models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" },
 *   timeoutMs: 60_000,
 *   priceOverrides: {}
 * };
 * ```
 */
export type Config = {
  /** Env var name holding the API key — resolved via ctx.env at request time. */
  apiKeyEnv: string;
  /** Optional API base URL override (proxies / OpenAI-compatible endpoints). */
  baseUrl?: string;
  /** Default models per capability. */
  models: { tts: string; chat: string };
  /** Request timeout, ms. */
  timeoutMs: number;
  /** Price overrides by model (merged over the bundled table). */
  priceOverrides: Record<
    string,
    { inputPerM?: number; outputPerM?: number; ttsPerMChars?: number }
  >;
};

/** Per-request options accepted by every {@link OpenaiClient} method — the abort signal only. */
export type OpenaiCallOptions = { signal?: AbortSignal };

/** One chat message accepted by {@link OpenaiClient}'s `chat.completions.create`. */
export type OpenaiChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Request body accepted by {@link OpenaiClient}'s `chat.completions.create`. */
export type OpenaiChatRequestBody = {
  /** The chat model to use. */
  model: string;
  /** The conversation, in order. */
  messages: OpenaiChatMessage[];
  /** Sampling temperature; omitted uses the provider's default. */
  temperature?: number;
};

/** One generated chat message: text content, or a refusal, never both. */
export type OpenaiChatMessageResult = {
  /** The generated text, or null when the model declined to answer. */
  content: string | null;
  /** The model's refusal explanation, or null when it answered normally. */
  refusal: string | null;
};

/** Token usage reported for a chat completion request. */
export type OpenaiChatUsage = {
  /** Tokens consumed by the prompt (system + user messages). */
  prompt_tokens: number;
  /** Tokens consumed by the generated completion. */
  completion_tokens: number;
};

/** Response body returned by {@link OpenaiClient}'s `chat.completions.create`. */
export type OpenaiChatCompletion = {
  /** Generated choices; OpenAI returns at least one by default. */
  choices: Array<{ message: OpenaiChatMessageResult }>;
  /** Token usage, when reported by the provider. */
  usage?: OpenaiChatUsage;
};

/** Request body accepted by {@link OpenaiClient}'s `audio.speech.create`. */
export type OpenaiSpeechRequestBody = {
  /** The tts model to use. */
  model: string;
  /** The provider-scoped voice id or name. */
  voice: string;
  /** The text to synthesize. */
  input: string;
  /** The output audio container/codec. */
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
};

/** Response returned by {@link OpenaiClient}'s `audio.speech.create` — a `Response`-like body. */
export type OpenaiSpeechResult = {
  /**
   * Reads the full response body as an ArrayBuffer.
   *
   * @returns The raw audio bytes.
   */
  arrayBuffer(): Promise<ArrayBuffer>;
};

/**
 * STRUCTURAL alias covering exactly the OpenAI SDK surface the handlers
 * call. Deliberately NOT the SDK's own namespace type (`import("openai").OpenAI`)
 * — that type is dropped by tsdown/rolldown `.d.ts` bundling. Every field
 * here is a plain type this plugin owns, so it survives the build and stays
 * trivially mockable in tests (a fake object literal satisfies it).
 *
 * @example
 * ```ts
 * const fakeClient: OpenaiClient = {
 *   audio: { speech: { create: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) } },
 *   chat: { completions: { create: async () => ({ choices: [] }) } }
 * };
 * ```
 */
export type OpenaiClient = {
  audio: {
    speech: {
      /**
       * Synthesizes speech from text.
       *
       * @param params - The tts request body.
       * @param options - Per-request options (abort signal).
       * @returns The synthesized audio response.
       */
      create(
        params: OpenaiSpeechRequestBody,
        options?: OpenaiCallOptions
      ): Promise<OpenaiSpeechResult>;
    };
  };
  chat: {
    completions: {
      /**
       * Generates a chat completion.
       *
       * @param params - The chat completion request body.
       * @param options - Per-request options (abort signal).
       * @returns The generated completion.
       */
      create(
        params: OpenaiChatRequestBody,
        options?: OpenaiCallOptions
      ): Promise<OpenaiChatCompletion>;
    };
  };
};

/** Effective price table: model name to its per-unit USD prices. */
export type PriceTable = Record<
  string,
  { inputPerM?: number; outputPerM?: number; ttsPerMChars?: number }
>;

/**
 * openai plugin state: the lazily-created SDK client (constructed on first
 * use, not at init — no API key is needed until then) and the effective
 * price table (bundled merged with `config.priceOverrides`, computed once).
 *
 * @example
 * ```ts
 * const state: State = { client: null, prices: null };
 * ```
 */
export type State = {
  /** Lazily-created SDK client (needs the API key — constructed on first use, not at init). */
  client: OpenaiClient | null;
  /** Effective price table (bundled merged with overrides). */
  prices: PriceTable | null;
};

/**
 * Public API surface of the `openai` plugin, exposed as `app.openai`.
 *
 * @example
 * ```ts
 * const info = app.openai.info(); // => { provider: "openai", configured: true, models: {...} }
 * ```
 */
export type OpenaiApi = {
  /**
   * Provider health/info: whether an API key is configured, without ever
   * throwing, plus the default models per capability.
   *
   * @returns The provider info snapshot.
   * @example
   * ```ts
   * // Before a run, check OPENAI_API_KEY is set; no SDK client is built by this call.
   * const { configured, models } = app.openai.info();
   * // configured: false without the key, models: { tts: "gpt-4o-mini-tts", chat: "gpt-4o-mini" }
   * ```
   */
  info(): { provider: "openai"; configured: boolean; models: { tts: string; chat: string } };
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";

/**
 * Domain context for the openai plugin's extracted files (api.ts, client.ts,
 * prices.ts, the three handlers). The framework's exported `PluginCtx` helper
 * gives `config`/`state`/`emit`; this plugin also needs `require` (narrowed
 * to its one dependency, `registry`) plus the `env`/`log` core APIs, which
 * `PluginCtx` intentionally omits (mock with matching structural APIs per
 * moku-testing conventions).
 *
 * @example
 * ```ts
 * export const createOpenaiApi = (ctx: OpenaiContext): OpenaiApi => ({ ... });
 * ```
 */
export type OpenaiContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Validated environment accessor (get/require/has) injected by the framework's env plugin. */
  env: EnvApi;
  /** Structured logging API injected by the framework's log plugin. */
  log: LogApi;
};

/**
 * Retryable transport/provider failure: 5xx, 429, timeout, or network.
 * Carries exactly the structural fields the runner's `classifyError`
 * (`src/plugins/runner/types.ts` `ProviderErrorHint`) reads: `status`,
 * `kind`, and `retryAfterMs`.
 */
export class RetryableProviderError extends Error {
  readonly status: number | undefined;
  readonly kind: "timeout" | "network" | undefined;
  readonly retryAfterMs: number | undefined;

  /**
   * Creates a retryable provider error.
   *
   * @param message - Redacted human-readable message (never request/response text).
   * @param hint - The runner's `ProviderErrorHint` fields for this failure.
   * @param hint.status - HTTP status code, when the failure came from an HTTP response.
   * @param hint.kind - Explicit classification hint overriding status-based inference.
   * @param hint.retryAfterMs - Provider-supplied Retry-After delay, ms.
   * @example
   * ```ts
   * throw new RetryableProviderError("[ai] OpenAI rate limited the request.", {
   *   status: 429,
   *   retryAfterMs: 1_000
   * });
   * ```
   */
  constructor(
    message: string,
    hint: { status?: number; kind?: "timeout" | "network"; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.status = hint.status;
    this.kind = hint.kind;
    this.retryAfterMs = hint.retryAfterMs;
  }
}

/** Deterministic 4xx failure (excluding 429) — never retried. */
export class TerminalProviderError extends Error {
  readonly status: number | undefined;

  /**
   * Creates a terminal provider error.
   *
   * @param message - Redacted human-readable message (never request/response text).
   * @param status - HTTP status code, when the failure came from an HTTP response.
   * @example
   * ```ts
   * throw new TerminalProviderError("[ai] OpenAI rejected the request (400).", 400);
   * ```
   */
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Content-policy rejection/refusal — terminal `flagged` state, never re-queued. */
export class FlaggedProviderError extends Error {
  readonly kind = "content-policy" as const;
}
