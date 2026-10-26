/**
 * @file anthropic provider plugin — types (config, prices, state, the
 * structural AnthropicClient with this plugin's own Messages API request and
 * answer shapes, the public API, the domain context).
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
 * Prices of one model, USD per one million tokens. Cache writes are priced
 * per lifetime (5 minutes, 1 hour). `longContext` raises every rate of a
 * request whose total input passes `aboveInputTokens`.
 *
 * @example
 * ```ts
 * const haiku: AnthropicPrice = {
 *   inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWrite5mPerM: 0.125, cacheWrite1hPerM: 0.2,
 *   longContext: { aboveInputTokens: 100_000, inputMultiplier: 5, outputMultiplier: 5 }
 * };
 * ```
 */
export type AnthropicPrice = {
  /** Uncached input tokens. */
  inputPerM: number;
  /** Output tokens, thinking included. */
  outputPerM: number;
  /** Input tokens read from the prompt cache. */
  cacheReadPerM: number;
  /** Input tokens written to the 5-minute cache. */
  cacheWrite5mPerM: number;
  /** Input tokens written to the 1-hour cache. */
  cacheWrite1hPerM: number;
  /** Above `aboveInputTokens` total input, every input-side rate × `inputMultiplier` and output × `outputMultiplier`, for the whole request. */
  longContext?: { aboveInputTokens: number; inputMultiplier: number; outputMultiplier: number };
};

/**
 * Effective prices by native model id: the bundled table merged with
 * `config.priceOverrides`. A model with no complete price is absent.
 *
 * @example
 * ```ts
 * const prices: AnthropicPriceTable = new Map([["claude-sonnet-5", { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWrite5mPerM: 2.5, cacheWrite1hPerM: 4 }]]);
 * ```
 */
export type AnthropicPriceTable = ReadonlyMap<string, AnthropicPrice>;

/**
 * anthropic plugin configuration.
 *
 * @example
 * ```ts
 * createApp({ pluginConfigs: { anthropic: { model: "claude-sonnet-5-5", maxTokens: 64_000 } } });
 * ```
 */
export type Config = {
  /** Env var holding the API key, read through ctx.env at request time. Default: "ANTHROPIC_API_KEY". */
  apiKeyEnv: string;
  /** Optional API base URL override. Default: the SDK default. */
  baseUrl?: string;
  /** Model when the request names none (or "default"). Default: "claude-opus-5-5". */
  model: string;
  /** Output cap when `params.max_tokens` is not a positive integer. Default: 32_000. */
  maxTokens: number;
  /** Request timeout, ms. Default: 900_000. */
  timeoutMs: number;
  /** Per-model price overrides merged field by field over the bundled table. Default: {}. */
  priceOverrides: Record<string, Partial<AnthropicPrice>>;
};

/**
 * A JSON schema: open JSON by nature, sent as the tool input schema or the
 * structured-answer schema.
 *
 * @example
 * ```ts
 * const schema: JsonSchema = { type: "object", properties: { score: { type: "number" } } };
 * ```
 */
export type JsonSchema = Record<string, unknown>;

/**
 * The prompt-cache marker of a block: a cache breakpoint after it.
 *
 * @example
 * ```ts
 * const mark: AnthropicCacheControl = { type: "ephemeral" };
 * ```
 */
export type AnthropicCacheControl = {
  /** The only kind: kept for the default 5-minute lifetime. */
  type: "ephemeral";
};

/**
 * A text block, sent or answered.
 *
 * @example
 * ```ts
 * const block: AnthropicTextBlock = { type: "text", text: "Shot list.", cache_control: { type: "ephemeral" } };
 * ```
 */
export type AnthropicTextBlock = {
  /** Block kind. */
  type: "text";
  /** The text. */
  text: string;
  /** A cache breakpoint after this block; omitted otherwise. */
  cache_control?: AnthropicCacheControl;
};

/**
 * Image types the Messages API reads.
 *
 * @example
 * ```ts
 * const type: AnthropicImageMediaType = "image/png";
 * ```
 */
export type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * An image block: the file's bytes, base64.
 *
 * @example
 * ```ts
 * const block: AnthropicImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
 * ```
 */
export type AnthropicImageBlock = {
  /** Block kind. */
  type: "image";
  /** The image bytes and their type. */
  source: { type: "base64"; media_type: AnthropicImageMediaType; data: string };
};

/**
 * A thinking block of an answer; sent back unchanged with its tool turn.
 *
 * @example
 * ```ts
 * const block: AnthropicThinkingBlock = { type: "thinking", thinking: "Read frame 3 first.", signature: "EqQBCkgIBxABGAIi" };
 * ```
 */
export type AnthropicThinkingBlock = {
  /** Block kind. */
  type: "thinking";
  /** The thinking text. */
  thinking: string;
  /** The API's signature over the thinking; checked when the block is sent back. */
  signature: string;
};

/**
 * A redacted thinking block of an answer; sent back unchanged with its tool turn.
 *
 * @example
 * ```ts
 * const block: AnthropicRedactedThinkingBlock = { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" };
 * ```
 */
export type AnthropicRedactedThinkingBlock = {
  /** Block kind. */
  type: "redacted_thinking";
  /** The encrypted thinking. */
  data: string;
};

/**
 * A tool call of an answer, or of an assistant turn sent back.
 *
 * @example
 * ```ts
 * const block: AnthropicToolUseBlock = { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } };
 * ```
 */
export type AnthropicToolUseBlock = {
  /** Block kind. */
  type: "tool_use";
  /** The API's call id; a tool result answers it. */
  id: string;
  /** The called tool. */
  name: string;
  /** The parsed input of the call. */
  input: unknown;
};

/**
 * The result of one tool call, inside a user message.
 *
 * @example
 * ```ts
 * const block: AnthropicToolResultBlock = { type: "tool_result", tool_use_id: "toolu_01", content: "Subject is cut at the chin." };
 * ```
 */
export type AnthropicToolResultBlock = {
  /** Block kind. */
  type: "tool_result";
  /** Id of the tool call this result answers. */
  tool_use_id: string;
  /** The result: text, or text and image blocks. */
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
};

/**
 * A block of an answer's content that this plugin reads and sends back:
 * text, thinking, redacted thinking and tool calls.
 *
 * @example
 * ```ts
 * const content: AnthropicContentBlock[] = [
 *   { type: "thinking", thinking: "Read frame 3 first.", signature: "EqQBCkgIBxABGAIi" },
 *   { type: "tool_use", id: "toolu_01", name: "read_frame", input: { shot: 3 } }
 * ];
 * ```
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock;

/**
 * One message of the request: a user turn (text, images, tool results) or an
 * assistant turn (its answer blocks).
 *
 * @example
 * ```ts
 * const message: AnthropicInputMessage = { role: "user", content: "Check the framing of shot 3." };
 * ```
 */
export type AnthropicInputMessage =
  | {
      /** Who speaks. */
      role: "user";
      /** Text, or text, image and tool-result blocks. */
      content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock>;
    }
  | {
      /** Who speaks. */
      role: "assistant";
      /** The answer blocks of that turn. */
      content: AnthropicContentBlock[];
    };

/**
 * The input schema of a tool: an object schema.
 *
 * @example
 * ```ts
 * const schema: AnthropicInputSchema = { type: "object", properties: { shot: { type: "number" } }, required: ["shot"] };
 * ```
 */
export type AnthropicInputSchema = {
  /** Tool inputs are objects. */
  type: "object";
  /** The rest of the JSON schema, as given. */
  [keyword: string]: unknown;
};

/**
 * A tool the model may call.
 *
 * @example
 * ```ts
 * const tool: AnthropicTool = { name: "read_frame", description: "Return one frame.", input_schema: { type: "object" } };
 * ```
 */
export type AnthropicTool = {
  /** Tool name the model calls. */
  name: string;
  /** What the tool does. */
  description: string;
  /** JSON schema of the tool's input. */
  input_schema: AnthropicInputSchema;
};

/**
 * Whether and which tool the model must call.
 *
 * @example
 * ```ts
 * const choice: AnthropicToolChoice = { type: "tool", name: "read_frame" };
 * ```
 */
export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string };

/**
 * How much effort the model puts into an answer, thinking included.
 *
 * @example
 * ```ts
 * const effort: AnthropicEffort = "medium";
 * ```
 */
export type AnthropicEffort = "low" | "medium" | "high";

/**
 * The `output_config` of a request: the effort, and the answer schema when set.
 *
 * @example
 * ```ts
 * const config: AnthropicOutputConfig = { effort: "high", format: { type: "json_schema", schema: { type: "object" } } };
 * ```
 */
export type AnthropicOutputConfig = {
  /** Effort of the answer. */
  effort: AnthropicEffort;
  /** A JSON answer by this schema; omitted for a free-text answer. */
  format?: { type: "json_schema"; schema: JsonSchema };
};

/**
 * The Messages API request this plugin sends, fields in wire order. No
 * `temperature` and no `thinking` field, ever.
 *
 * @example
 * ```ts
 * const body: AnthropicRequestBody = {
 *   model: "claude-opus-5-5",
 *   max_tokens: 32_000,
 *   messages: [{ role: "user", content: "Judge these frames." }],
 *   output_config: { effort: "medium" }
 * };
 * ```
 */
export type AnthropicRequestBody = {
  /** Native model id. */
  model: string;
  /** Output token cap. */
  max_tokens: number;
  /** System text; one cached text block with `cacheSystem`; omitted without system text. */
  system?: string | AnthropicTextBlock[];
  /** The turns. */
  messages: AnthropicInputMessage[];
  /** Tools the model may call; omitted without tools. */
  tools?: AnthropicTool[];
  /** Whether and which tool the model must call; omitted when unset. */
  tool_choice?: AnthropicToolChoice;
  /** Effort and answer schema. */
  output_config: AnthropicOutputConfig;
};

/**
 * Token usage of one answer, as the API reports it. `input_tokens` is the
 * uncached input only; the cache counts are null when not reported.
 *
 * @example
 * ```ts
 * const usage: AnthropicUsage = {
 *   input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0,
 *   cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
 * };
 * ```
 */
export type AnthropicUsage = {
  /** Uncached input tokens. */
  input_tokens: number;
  /** Output tokens, thinking included. */
  output_tokens: number;
  /** Input tokens written to the cache, every lifetime together. */
  cache_creation_input_tokens?: number | null;
  /** Input tokens read from the cache. */
  cache_read_input_tokens?: number | null;
  /** Cache writes by lifetime. */
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
};

/**
 * The final message of one request: its blocks, why it stopped, its usage.
 *
 * @example
 * ```ts
 * const message: AnthropicMessage = {
 *   content: [{ type: "text", text: "The framing is tight." }],
 *   stop_reason: "end_turn",
 *   usage: { input_tokens: 120, output_tokens: 40 }
 * };
 * ```
 */
export type AnthropicMessage = {
  /** The answer blocks, in order. */
  content: AnthropicContentBlock[];
  /** Why the answer ended, e.g. `"end_turn"`, `"tool_use"`, `"max_tokens"`, `"refusal"`. */
  stop_reason: string | null;
  /** Token usage. */
  usage: AnthropicUsage;
};

/**
 * Per-request options of an {@link AnthropicClient} call: the abort signal only.
 *
 * @example
 * ```ts
 * const options: AnthropicCallOptions = { signal: AbortSignal.timeout(60_000) };
 * ```
 */
export type AnthropicCallOptions = { signal?: AbortSignal };

/**
 * A started streamed request: resolves to the whole message when the stream ends.
 *
 * @example
 * ```ts
 * const stream: AnthropicMessageStream = { finalMessage: async () => message };
 * ```
 */
export type AnthropicMessageStream = {
  /**
   * Waits for the end of the stream.
   *
   * @returns The final message.
   */
  finalMessage(): Promise<AnthropicMessage>;
};

/**
 * STRUCTURAL alias covering exactly the SDK surface this plugin calls:
 * `messages.stream(params, options).finalMessage()`. Deliberately not the
 * SDK's own class type (dropped by `.d.ts` bundling, spec/09 R9); a fake
 * object literal satisfies it in tests.
 *
 * @example
 * ```ts
 * const fakeClient: AnthropicClient = {
 *   messages: {
 *     stream: () => ({ finalMessage: async () => ({ content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }) })
 *   }
 * };
 * ```
 */
export type AnthropicClient = {
  messages: {
    /**
     * Starts a streamed Messages request.
     *
     * @param params - The request body.
     * @param options - Per-request options (abort signal).
     * @returns The started stream.
     */
    stream(params: AnthropicRequestBody, options?: AnthropicCallOptions): AnthropicMessageStream;
  };
};

/**
 * anthropic plugin state.
 *
 * @example
 * ```ts
 * const state: State = { client: null, prices: null, turns: new Map() };
 * ```
 */
export type State = {
  /** Lazily created structural SDK client (needs the key: built on the first execute). */
  client: AnthropicClient | null;
  /** Bundled prices merged with overrides, computed once. */
  prices: AnthropicPriceTable | null;
  /** Answer blocks of a tool turn, keyed by its first tool_use id; insertion order; at most 500, oldest dropped. */
  turns: Map<string, AnthropicContentBlock[]>;
};

/**
 * Public API surface of the `anthropic` plugin, exposed as `app.anthropic`.
 *
 * @example
 * ```ts
 * app.anthropic.info(); // { provider: "anthropic", configured: true, model: "claude-opus-5-5" }
 * ```
 */
export type AnthropicApi = {
  /**
   * Provider health and info: whether the API key is set, without ever
   * throwing and without building the SDK client, plus the default model.
   *
   * @returns The provider info snapshot.
   * @example
   * ```ts
   * // Before a run, check that ANTHROPIC_API_KEY is set.
   * const { configured, model } = app.anthropic.info();
   * // configured: false without the key, model: "claude-opus-5-5"
   * ```
   */
  info(): { provider: "anthropic"; configured: boolean; model: string };
};

/** The registry's public surface — declared once in `../registry` and re-exported for this plugin's consumers. */
export type { RegistryApi } from "../registry";
// Type aliases, not `export type { … } from "./errors"`: the .d.ts bundler turns a type-only
// class re-export back into `declare class`, so `Anthropic.X` would pass tsc as a value that is
// `undefined` at runtime. The classes ship as values in `AnthropicErrors` from the package root.
/** Instance type of the retryable provider error; the class is `AnthropicErrors.RetryableProviderError`. */
export type RetryableProviderError = RetryableProviderErrorClass;
/** Instance type of the terminal provider error; the class is `AnthropicErrors.TerminalProviderError`. */
export type TerminalProviderError = TerminalProviderErrorClass;
/** Instance type of the refusal provider error; the class is `AnthropicErrors.FlaggedProviderError`. */
export type FlaggedProviderError = FlaggedProviderErrorClass;

/**
 * Domain context of the plugin's extracted files: `config`/`state`/`emit`
 * from `PluginCtx`, `require` narrowed to `registry`, and the `env`/`log`
 * core APIs.
 *
 * @example
 * ```ts
 * export const createAnthropicApi = (ctx: AnthropicContext): AnthropicApi => ({ ... });
 * ```
 */
export type AnthropicContext = PluginCtx<Config, State> & {
  /** Resolves a dependency plugin's API by instance reference. */
  require: (plugin: typeof registryPlugin) => RegistryApi;
  /** Validated environment accessor; the API key is read here at request time. */
  env: EnvApi;
  /** Structured logging; never the prompt or the answer. */
  log: LogApi;
};
