/**
 * @file prompt-gen capability contract — task-owned; providers implement this.
 */

/**
 * One part of a multi-part message: text, or a picture on disk. A text part
 * with `cache: true` marks a prompt-cache breakpoint after it.
 *
 * @example
 * ```ts
 * // A tool result that returns a rendered frame plus a caption.
 * const parts: ContentPart[] = [
 *   { type: "text", text: "Frame 12 of shot 3." },
 *   { type: "image", path: "frames/s3-012.png", mimeType: "image/png", hash: "9f2c1a" }
 * ];
 * ```
 */
export type ContentPart =
  | {
      /** Part kind. */
      type: "text";
      /** The text. */
      text: string;
      /** A prompt-cache breakpoint after this part. */
      cache?: true;
    }
  | {
      /** Part kind. */
      type: "image";
      /** Path of the image file on disk. */
      path: string;
      /** MIME type of the image, e.g. `"image/png"`. */
      mimeType: string;
      /** Content hash of the image; same shape as `params.images` entries. */
      hash: string;
    };

/**
 * One turn of a conversation after the system text: a user turn, an
 * assistant turn (text and/or tool calls), or a tool result.
 *
 * @example
 * ```ts
 * // Second step of a tool loop: the model asked for a frame, the caller answers it.
 * const messages: ChatMessage[] = [
 *   { role: "user", content: "Check the framing of shot 3." },
 *   { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read_frame", input: { shot: 3 } }] },
 *   { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "Subject is cut at the chin." }] }
 * ];
 * ```
 */
export type ChatMessage =
  | {
      /** Turn author. */
      role: "user";
      /** Plain text, or text and image parts. */
      content: string | ContentPart[];
    }
  | {
      /** Turn author. */
      role: "assistant";
      /** The assistant text; `null` when the turn is only tool calls. */
      content: string | null;
      /** Tool calls the assistant made in this turn. */
      toolCalls?: ToolCall[];
    }
  | {
      /** Turn author. */
      role: "tool";
      /** Id of the {@link ToolCall} this message answers. */
      toolCallId: string;
      /** The tool result: plain text, or text and image parts. */
      content: string | ContentPart[];
    };

/**
 * A tool call the model made: which tool, with which input.
 *
 * @example
 * ```ts
 * const call: ToolCall = { id: "call_1", name: "read_frame", input: { shot: 3, frame: 12 } };
 * ```
 */
export type ToolCall = {
  /** Provider-assigned id; a `tool` message answers it by `toolCallId`. */
  id: string;
  /** Name of the called tool, as in its {@link ToolDefinition}. */
  name: string;
  /** Parsed JSON of the call's arguments. */
  input: unknown;
};

/**
 * A tool the model may call, described by a JSON schema of its input.
 *
 * @example
 * ```ts
 * const tool: ToolDefinition = {
 *   name: "read_frame",
 *   description: "Return one rendered frame of a shot as an image.",
 *   inputSchema: { type: "object", properties: { shot: { type: "number" } }, required: ["shot"] }
 * };
 * ```
 */
export type ToolDefinition = {
  /** Tool name the model calls. */
  name: string;
  /** What the tool does; the model reads it to decide when to call. */
  description: string;
  /** JSON schema of the tool's input. */
  inputSchema: Record<string, unknown>;
};

/**
 * A one-off text-generation request. Providers map/clamp `temperature` and
 * `params` as needed for their own API. A request without `messages`,
 * `tools`, `toolChoice` and `cacheSystem` is the one-turn `prompt` request.
 *
 * @example
 * ```ts
 * const request: PromptGenRequest = { prompt: "Describe a sunset over the ocean." };
 * // A tool turn: messages replace prompt, the system text is cached.
 * const toolTurn: PromptGenRequest = {
 *   prompt: "",
 *   system: "You review storyboard frames.",
 *   cacheSystem: true,
 *   messages: [{ role: "user", content: "Check the framing of shot 3." }],
 *   tools: [{ name: "read_frame", description: "Return one frame.", inputSchema: { type: "object" } }]
 * };
 * ```
 */
export type PromptGenRequest = {
  /** The user prompt; ignored when `messages` is set (may be `""`). */
  prompt: string;
  /** System text sent before the turns. */
  system?: string;
  /** Provider model id; the provider's default when absent. */
  model?: string;
  /** Provider maps/clamps as needed. */
  temperature?: number;
  /** Provider-specific parameters, e.g. `images`. */
  params?: Record<string, unknown>;
  /** The turns after the system text; replaces `prompt`. */
  messages?: ChatMessage[];
  /** Tools the model may call. */
  tools?: ToolDefinition[];
  /** Whether and which tool the model must call. Default: `"auto"`. */
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /** A prompt-cache breakpoint after the system text. */
  cacheSystem?: boolean;
};

/**
 * Token usage of one call. Counts a provider does not report are 0.
 *
 * @example
 * ```ts
 * // A tool-loop step whose cached system text served 1800 of the prompt tokens.
 * const usage: PromptGenUsage = { promptTokens: 2400, completionTokens: 120, cachedTokens: 1800, cacheWriteTokens: 0 };
 * ```
 */
export type PromptGenUsage = {
  /** Prompt (input) tokens. */
  promptTokens: number;
  /** Completion (output) tokens. */
  completionTokens: number;
  /** Prompt tokens served from the cache (0 when unknown). */
  cachedTokens: number;
  /** Tokens written to the cache (0 when unknown). */
  cacheWriteTokens: number;
};

/**
 * The result of a prompt-gen request: the generated text, any tool calls,
 * why the turn ended, the cost and the token usage, plus optional provider
 * metadata.
 *
 * @example
 * ```ts
 * const result: PromptGenResult = {
 *   text: "A fiery orange sunset.",
 *   costUsd: 0.0002,
 *   toolCalls: [],
 *   finishReason: "stop",
 *   usage: { promptTokens: 12, completionTokens: 6, cachedTokens: 0, cacheWriteTokens: 0 }
 * };
 * ```
 */
export type PromptGenResult = {
  /** The generated text; `""` when the turn is only tool calls. */
  text: string;
  /** Cost of the call in USD. */
  costUsd: number;
  /** Tool calls the model made; `[]` when none. */
  toolCalls: ToolCall[];
  /** Why the turn ended. */
  finishReason: "stop" | "tool_calls" | "length" | "other";
  /** Token usage of the call. */
  usage: PromptGenUsage;
  /** Token counts, model — metadata only; keeps its keys for compatibility. */
  meta?: Record<string, unknown>;
};

/**
 * The handler contract a prompt-gen provider plugin registers with
 * `registry` under the `"prompt-gen"` task. Provider plugins `import type`
 * this to implement it; `promptGen` performs the one audited cast to this
 * type at its own `resolve()` call site (spec/09 R9).
 *
 * @example
 * ```ts
 * const handler: PromptGenHandler = {
 *   estimate: request => ({ usd: request.prompt.length * 0.00001 }),
 *   execute: async request => ({
 *     text: request.prompt,
 *     costUsd: 0,
 *     toolCalls: [],
 *     finishReason: "stop",
 *     usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
 *   })
 * };
 * ```
 */
export type PromptGenHandler = {
  /**
   * Estimates the cost of executing `request`, without performing it.
   *
   * @param request - The prompt-gen request to estimate.
   * @returns The estimated cost in USD.
   */
  estimate(request: PromptGenRequest): { usd: number };
  /**
   * Executes `request` against the provider.
   *
   * @param request - The prompt-gen request to execute.
   * @param opts - Execution options.
   * @param opts.signal - Optional abort signal to cancel the request.
   * @returns The generated result.
   */
  execute(request: PromptGenRequest, opts: { signal?: AbortSignal }): Promise<PromptGenResult>;
};

/** HTTP statuses that mean "this provider cannot serve now": auth, payment, forbidden, rate limit. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429]);

/**
 * Thrown by a prompt-gen provider that cannot serve right now: its binary is
 * missing, it is not logged in, it hit a plan or rate limit, or it cannot
 * express the request (messages, tools, cache). `promptGen`
 * moves to the next provider of its `fallback` chain on this error only; any
 * other error means the provider answered badly and is rethrown at once.
 * Plugin-free (no plugin import), so providers value-import it without a
 * `depends` edge.
 *
 * @example
 * ```ts
 * // A local CLI handler whose spawn failed with ENOENT: promptGen tries the next provider.
 * throw new PromptGenUnavailableError(
 *   "[ai] Claude CLI not found: claude.\n  Install Claude Code or set claude.bin.",
 *   "missing"
 * ); // error.unavailable === true, error.reason === "missing"
 * ```
 */
export class PromptGenUnavailableError extends Error {
  /** Marker read by {@link isPromptGenUnavailable}; survives a structural copy of the error. */
  readonly unavailable = true;
  /** Why the provider cannot serve: binary missing, not logged in, plan/rate limit, or a request it cannot express. */
  readonly reason: "missing" | "auth" | "limit" | "unsupported";

  /**
   * Creates the error with the provider's two-line message.
   *
   * @param message - Two-line `[ai] …` message; never contains the prompt.
   * @param reason - Why the provider cannot serve.
   */
  constructor(message: string, reason: "missing" | "auth" | "limit" | "unsupported") {
    super(message);
    this.name = "PromptGenUnavailableError";
    this.reason = reason;
  }
}

/** How many characters of the raw arguments a {@link ToolArgumentsError} message quotes. */
const RAW_QUOTE_LENGTH = 200;

/**
 * Thrown by a prompt-gen provider when the model called a tool with
 * arguments that do not parse as JSON. Not an unavailable error: `promptGen`
 * rethrows it at once. Plugin-free (no plugin import), so providers
 * value-import it without a `depends` edge.
 *
 * @example
 * ```ts
 * // A provider reading the model's tool call.
 * throw new ToolArgumentsError("read_frame", "{shot: 3");
 * // message: [ai] Tool call "read_frame" has arguments that are not JSON.
 * //            The model sent: {shot: 3.
 * ```
 */
export class ToolArgumentsError extends Error {
  /** Name of the tool the model called. */
  readonly toolName: string;
  /** The unparsed `arguments` text, in full. */
  readonly raw: string;

  /**
   * Creates the error; the message quotes the first 200 characters of `raw`.
   *
   * @param toolName - Name of the tool the model called.
   * @param raw - The unparsed `arguments` text.
   */
  constructor(toolName: string, raw: string) {
    super(
      `[ai] Tool call "${toolName}" has arguments that are not JSON.\n  The model sent: ${raw.slice(0, RAW_QUOTE_LENGTH)}.`
    );
    this.name = "ToolArgumentsError";
    this.toolName = toolName;
    this.raw = raw;
  }
}

/**
 * Tells whether an error means "provider unavailable" rather than "provider
 * failed": `error.unavailable === true` (a {@link PromptGenUnavailableError}),
 * or a numeric `error.status` of 401, 402, 403 or 429 (so HTTP providers such
 * as openai and fal take part in the fallback chain).
 *
 * @param error - Any thrown value.
 * @returns True when the fallback chain may move to the next provider.
 * @example
 * ```ts
 * // A consumer's own retry loop, reusing promptGen's switch rule.
 * isPromptGenUnavailable(new PromptGenUnavailableError("[ai] Codex CLI is not logged in.\n  Run codex login, or use another provider.", "auth")); // true
 * isPromptGenUnavailable({ status: 429 }); // true
 * isPromptGenUnavailable({ status: 500 }); // false
 * ```
 */
export function isPromptGenUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("unavailable" in error && error.unavailable === true) return true;

  return (
    "status" in error && typeof error.status === "number" && UNAVAILABLE_STATUSES.has(error.status)
  );
}

/**
 * Throws when a request asks for a conversation or tool calling
 * (`messages`, `tools` or `toolChoice`), for a provider that maps only one
 * turn. The error is "unsupported", so `promptGen` falls back to the next
 * provider. `cacheSystem` alone does not count: such a provider ignores it.
 *
 * @param request - The prompt-gen request.
 * @param providerLabel - The provider name for the message, e.g. `"Claude"`.
 * @throws {PromptGenUnavailableError} With reason "unsupported".
 * @example
 * ```ts
 * assertOneTurnRequest({ prompt: "p", cacheSystem: true }, "Codex"); // returns
 * assertOneTurnRequest({ prompt: "", messages: [] }, "Claude");
 * // throws "[ai] Claude prompt-gen does not support messages or tools.\n  Use the fal provider for tool calling."
 * ```
 */
export function assertOneTurnRequest(request: PromptGenRequest, providerLabel: string): void {
  const asksForTools =
    request.messages !== undefined ||
    request.tools !== undefined ||
    request.toolChoice !== undefined;
  if (!asksForTools) return;

  throw new PromptGenUnavailableError(
    `[ai] ${providerLabel} prompt-gen does not support messages or tools.\n  Use the fal provider for tool calling.`,
    "unsupported"
  );
}
