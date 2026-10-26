/**
 * @file openai provider plugin — types (config, state, structural OpenaiClient,
 * request/response shapes, domain context).
 */
import type { EnvApi, LogApi } from "@moku-labs/common";
import type { PluginCtx } from "@moku-labs/core";
import type { RegistryApi, registryPlugin } from "../registry";
import type {
  FlaggedProviderError as FlaggedProviderErrorClass,
  RetryableProviderError as RetryableProviderErrorClass,
  TerminalProviderError as TerminalProviderErrorClass
} from "./errors";

/**
 * USD prices of one model: per one million tokens (input, cached input,
 * cache writes kept 30 minutes or 12 hours, output) and per one million
 * tts characters. A table entry carries only the fields its model uses.
 *
 * @example
 * ```ts
 * const astra: Partial<ModelPrice> = {
 *   inputPerM: 10,
 *   cachedInputPerM: 1,
 *   cacheWritePerM: 12.5,
 *   cacheWrite12hPerM: 25,
 *   outputPerM: 50
 * };
 * ```
 */
export type ModelPrice = {
  /** USD per 1M uncached input tokens. */
  inputPerM: number;
  /** USD per 1M input tokens read from the prompt cache. */
  cachedInputPerM: number;
  /** USD per 1M input tokens written to the cache for 30 minutes (the default lifetime). */
  cacheWritePerM: number;
  /** USD per 1M input tokens written to the cache for 12 hours. */
  cacheWrite12hPerM: number;
  /** USD per 1M output tokens (reasoning tokens included). */
  outputPerM: number;
  /** USD per 1M synthesized tts characters. */
  ttsPerMChars: number;
};

/**
 * openai plugin configuration: which env var holds the API key, an optional
 * base URL override (proxies / OpenAI-compatible endpoints), default models
 * per capability, the request timeouts, and per-model price overrides.
 *
 * @example
 * ```ts
 * createApp({
 *   pluginConfigs: {
 *     openai: { promptGenTimeoutMs: 1_200_000, priceOverrides: { "gpt-6-astra": { outputPerM: 45 } } }
 *   }
 * });
 * ```
 */
export type Config = {
  /** Env var name holding the API key — resolved via ctx.env at request time. */
  apiKeyEnv: string;
  /** Optional API base URL override (proxies / OpenAI-compatible endpoints). */
  baseUrl?: string;
  /** Default models per capability; `chat` is also the prompt-gen default. */
  models: { tts: string; chat: string };
  /** Request timeout for tts and translate, ms. */
  timeoutMs: number;
  /** Request timeout for prompt-gen (reasoning calls run for minutes), ms. */
  promptGenTimeoutMs: number;
  /** Price overrides by model, merged field by field over the bundled table. */
  priceOverrides: Record<string, Partial<ModelPrice>>;
};

/** Per-request options accepted by every {@link OpenaiClient} method: the abort signal and a timeout override, ms. */
export type OpenaiCallOptions = { signal?: AbortSignal; timeout?: number };

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
  /** Breakdown of the prompt tokens, when reported. */
  prompt_tokens_details?: {
    /** Prompt tokens served from the provider's prompt cache. */
    cached_tokens?: number;
  };
};

/** Response body returned by {@link OpenaiClient}'s `chat.completions.create`. */
export type OpenaiChatCompletion = {
  /** Generated choices; OpenAI returns at least one by default. */
  choices: Array<{
    /** The generated message. */
    message: OpenaiChatMessageResult;
    /** Why generation stopped, e.g. `"stop"` or `"length"`; absent in some fakes and proxies. */
    finish_reason?: string;
  }>;
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

/** An explicit prompt-cache breakpoint after an `input_text` part (GPT-6 models). */
export type OpenaiCacheBreakpoint = { mode: "explicit" };

/** A text part of a Responses input message or function call output. */
export type OpenaiInputText = {
  /** Part kind. */
  type: "input_text";
  /** The text. */
  text: string;
  /** A cache breakpoint after this part; omitted otherwise. */
  prompt_cache_breakpoint?: OpenaiCacheBreakpoint;
};

/** An image part of a Responses input: a base64 data URL of a local file. */
export type OpenaiInputImage = {
  /** Part kind. */
  type: "input_image";
  /** `data:<mimeType>;base64,<bytes>`. */
  image_url: string;
  /** Image detail level; always `"auto"`. */
  detail: "auto";
};

/** One part of a Responses input message or function call output. */
export type OpenaiInputContent = OpenaiInputText | OpenaiInputImage;

/** A developer (system text) or user message of a Responses input. */
export type OpenaiInputMessage = {
  /** Item kind. */
  type: "message";
  /** Who speaks. */
  role: "developer" | "user";
  /** Text and image parts, in order. */
  content: OpenaiInputContent[];
};

/** An earlier assistant text, sent back as a Responses input message. */
export type OpenaiAssistantInputMessage = {
  /** Item kind. */
  type: "message";
  /** Who speaks. */
  role: "assistant";
  /** The assistant text. */
  content: string;
};

/** A function call: read from an answer, and sent back (without `id`) on the next request. */
export type OpenaiFunctionCall = {
  /** Item kind. */
  type: "function_call";
  /** The call id a `function_call_output` answers. */
  call_id: string;
  /** Name of the called tool. */
  name: string;
  /** The call's arguments, JSON text. */
  arguments: string;
  /** The item id (`fc_…`) of an answer; never sent back. */
  id?: string;
};

/** The result of a function call, sent as a Responses input item. */
export type OpenaiFunctionCallOutput = {
  /** Item kind. */
  type: "function_call_output";
  /** The call this output answers. */
  call_id: string;
  /** Plain text, or text and image parts. */
  output: string | OpenaiInputContent[];
};

/**
 * A reasoning item of an answer, kept by the first call id of its tool turn
 * and sent back unchanged before that turn's function calls.
 *
 * @example
 * ```ts
 * const item: OpenaiReasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA…" };
 * ```
 */
export type OpenaiReasoningItem = {
  /** Item kind. */
  type: "reasoning";
  /** The reasoning item id. */
  id: string;
  /** Reasoning summary parts; often empty. */
  summary: Array<{ type: "summary_text"; text: string }>;
  /** The encrypted reasoning, present with `include: ["reasoning.encrypted_content"]`. */
  encrypted_content?: string | null;
};

/** One item of a Responses request `input`. */
export type OpenaiInputItem =
  | OpenaiInputMessage
  | OpenaiAssistantInputMessage
  | OpenaiReasoningItem
  | OpenaiFunctionCall
  | OpenaiFunctionCallOutput;

/** A function tool of a Responses request. */
export type OpenaiFunctionTool = {
  /** Tool kind. */
  type: "function";
  /** Tool name the model calls. */
  name: string;
  /** What the tool does. */
  description: string;
  /** JSON schema of the tool's input, open JSON by nature. */
  parameters: Record<string, unknown>;
  /** Strict schema adherence; always off (studio schemas are not strict-compatible). */
  strict: false;
};

/** Whether and which tool the model must call. */
export type OpenaiToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

/** Reasoning effort of a GPT-6 request. */
export type OpenaiReasoningEffort = "none" | "low" | "medium" | "high";

/** A structured-answer request: the answer follows a JSON schema. */
export type OpenaiTextFormat = {
  /** The JSON schema format. */
  format: {
    /** Format kind. */
    type: "json_schema";
    /** Name of the schema; always `"answer"`. */
    name: string;
    /** The JSON schema, open JSON by nature. */
    schema: Record<string, unknown>;
    /** Whether OpenAI enforces the schema strictly. */
    strict: boolean;
  };
};

/**
 * Request body accepted by {@link OpenaiClient}'s `responses.create`. This
 * plugin's own shape: the installed SDK's types predate GPT-6 fields
 * (`prompt_cache_breakpoint`).
 */
export type OpenaiResponsesRequestBody = {
  /** The model id. */
  model: string;
  /** Developer message, then the prompt or the turns. */
  input: OpenaiInputItem[];
  /** Never stored on OpenAI's side: reasoning is replayed from plugin state. */
  store: false;
  /** Output token cap, reasoning included. */
  max_output_tokens: number;
  /** Sampling temperature; non-reasoning models only, omitted when unset. */
  temperature?: number;
  /** Reasoning effort; GPT-6 models only. */
  reasoning?: { effort: OpenaiReasoningEffort };
  /** Extra answer fields; GPT-6 models ask for the encrypted reasoning. */
  include?: Array<"reasoning.encrypted_content">;
  /** Structured-answer request; omitted without a schema. */
  text?: OpenaiTextFormat;
  /** Tools the model may call; omitted without tools. */
  tools?: OpenaiFunctionTool[];
  /** Whether and which tool the model must call; omitted when unset. */
  tool_choice?: OpenaiToolChoice;
};

/** An `output_text` part of an answer message. */
export type OpenaiOutputText = { type: "output_text"; text: string };

/** A `refusal` part of an answer message. */
export type OpenaiOutputRefusal = { type: "refusal"; refusal: string };

/** An assistant message of an answer: text and refusal parts. */
export type OpenaiOutputMessage = {
  /** Item kind. */
  type: "message";
  /** Text and refusal parts, in order. */
  content: Array<OpenaiOutputText | OpenaiOutputRefusal>;
};

/**
 * One item of an answer's `output`: a message, a function call, a reasoning
 * item, or any other item kind (ignored by this plugin).
 */
export type OpenaiOutputItem =
  | OpenaiOutputMessage
  | OpenaiFunctionCall
  | OpenaiReasoningItem
  | {
      /** Item kind. */
      type: string;
    };

/**
 * Token usage of a Responses answer. Every field is optional: GPT-6 adds the
 * cache-write counts, and proxies may send fewer.
 */
export type OpenaiResponseUsage = {
  /** All input tokens: uncached, cache reads and cache writes. */
  input_tokens?: number;
  /** Output tokens, reasoning included. */
  output_tokens?: number;
  /** Breakdown of the input tokens. */
  input_tokens_details?: {
    /** Input tokens read from the prompt cache. */
    cached_tokens?: number;
    /** Input tokens written to the prompt cache. */
    cache_write_tokens?: number;
    /** Cache writes by lifetime; without it every write is a 30-minute write. */
    cache_write_tokens_details?: {
      /** Tokens written for 30 minutes. */
      ttl_30m_tokens?: number;
      /** Tokens written for 12 hours. */
      ttl_12h_tokens?: number;
    };
  };
};

/** Response body returned by {@link OpenaiClient}'s `responses.create`. */
export type OpenaiResponse = {
  /** `completed`, `incomplete`, `failed`, … */
  status?: string;
  /** Why an `incomplete` answer stopped. */
  incomplete_details?: { reason?: string } | null;
  /** The error of a `failed` answer. */
  error?: { code?: string } | null;
  /** The answer items, in order. */
  output: OpenaiOutputItem[];
  /** Token usage, when reported. */
  usage?: OpenaiResponseUsage;
};

/**
 * A local image file of a prompt-gen request (`params.images` or a message
 * image part).
 */
export type OpenaiLocalImage = {
  /** Path of the file on disk. */
  path: string;
  /** MIME type, e.g. `"image/png"`. */
  mimeType: string;
  /** Content hash of the file. */
  hash: string;
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
 *   chat: { completions: { create: async () => ({ choices: [] }) } },
 *   responses: { create: async () => ({ status: "completed", output: [] }) }
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
  responses: {
    /**
     * Generates a model response (Responses API).
     *
     * @param params - The Responses request body.
     * @param options - Per-request options (abort signal, timeout).
     * @returns The answer.
     */
    create(
      params: OpenaiResponsesRequestBody,
      options?: OpenaiCallOptions
    ): Promise<OpenaiResponse>;
  };
};

/** Effective price table: model name to its per-unit USD prices. */
export type PriceTable = Record<string, Partial<ModelPrice>>;

/**
 * openai plugin state: the lazily-created SDK client (constructed on first
 * use, not at init — no API key is needed until then), the effective
 * price table (bundled merged with `config.priceOverrides`, computed once),
 * and the reasoning items of recent prompt-gen tool turns.
 */
export type State = {
  /** Lazily-created SDK client (needs the API key — constructed on first use, not at init). */
  client: OpenaiClient | null;
  /** Effective price table (bundled merged with overrides). */
  prices: PriceTable | null;
  /** Reasoning items of a tool turn by its first call_id, replayed before the calls on the next request; at most 500, oldest dropped. */
  turns: Map<string, OpenaiReasoningItem[]>;
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
// Type aliases, not `export type { … } from "./errors"`: the .d.ts bundler turns a type-only
// class re-export back into `declare class`, so `Openai.X` would pass tsc as a value that is
// `undefined` at runtime. The classes ship as values in `OpenaiErrors` from the package root.
/** Instance type of the retryable provider error; the class is `OpenaiErrors.RetryableProviderError`. */
export type RetryableProviderError = RetryableProviderErrorClass;
/** Instance type of the terminal provider error; the class is `OpenaiErrors.TerminalProviderError`. */
export type TerminalProviderError = TerminalProviderErrorClass;
/** Instance type of the content-policy provider error; the class is `OpenaiErrors.FlaggedProviderError`. */
export type FlaggedProviderError = FlaggedProviderErrorClass;

/**
 * Domain context for the openai plugin's extracted files (api.ts, client.ts,
 * prices.ts, the three handlers). The framework's exported `PluginCtx` helper
 * gives `config`/`state`/`emit`; this plugin also needs `require` (narrowed
 * to its one dependency, `registry`) plus the `env`/`log` core APIs, which
 * `PluginCtx` intentionally omits (mock with matching structural APIs per
 * moku-testing conventions).
 */
export type OpenaiContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Validated environment accessor (get/require/has) injected by the framework's env plugin. */
  env: EnvApi;
  /** Structured logging API injected by the framework's log plugin. */
  log: LogApi;
};
