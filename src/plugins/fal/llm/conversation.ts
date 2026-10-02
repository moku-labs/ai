/**
 * @file fal LLM conversation — the OpenAI chat wire form of a multi-turn
 * prompt-gen request (system cache marker, user / assistant / tool turns,
 * text parts with `cache_control`, uploaded image parts, `tools` and
 * `tool_choice`), the reading of an answer's tool calls, finish reason and
 * usage, and the text of a conversation for the estimate, the character
 * rule and the request log. Pure: no I/O; images arrive as URLs already
 * uploaded.
 */
import type {
  ChatMessage,
  ContentPart,
  PromptGenRequest,
  PromptGenResult,
  PromptGenUsage,
  ToolCall,
  ToolDefinition
} from "../../promptGen/contract";
import { ToolArgumentsError } from "../../promptGen/contract";
import { readField, readNumber, readString } from "../client/http";

/**
 * The prompt-cache marker OpenRouter passes through to Anthropic models;
 * other model families ignore it.
 *
 * @example
 * ```ts
 * const marker: CacheControl = { type: "ephemeral" };
 * ```
 */
export type CacheControl = {
  /** The only cache kind: kept for the provider's cache lifetime. */
  type: "ephemeral";
};

/**
 * A text part on the wire; `cache_control` marks a cache breakpoint after it.
 *
 * @example
 * ```ts
 * const part: WireTextPart = { type: "text", text: "Shot list.", cache_control: { type: "ephemeral" } };
 * ```
 */
export type WireTextPart = {
  /** Part kind. */
  type: "text";
  /** The text. */
  text: string;
  /** A cache breakpoint after this part; omitted otherwise. */
  cache_control?: CacheControl;
};

/**
 * An image part on the wire: the URL of an uploaded file.
 *
 * @example
 * ```ts
 * const part: WireImagePart = { type: "image_url", image_url: { url: "https://v3.fal.media/files/a.png" } };
 * ```
 */
export type WireImagePart = {
  /** Part kind. */
  type: "image_url";
  /** The uploaded file's URL (or data URI). */
  image_url: { url: string };
};

/**
 * One part of a user or tool message on the wire.
 *
 * @example
 * ```ts
 * const part: WirePart = { type: "text", text: "Frame 12 of shot 3." };
 * ```
 */
export type WirePart = WireTextPart | WireImagePart;

/**
 * A tool call of an assistant turn on the wire; `arguments` is JSON text.
 *
 * @example
 * ```ts
 * const call: WireToolCall = { id: "toolu_01", type: "function", function: { name: "read_frame", arguments: '{"shot":3}' } };
 * ```
 */
export type WireToolCall = {
  /** The provider's call id. */
  id: string;
  /** Always a function call. */
  type: "function";
  /** The called tool and its JSON arguments. */
  function: { name: string; arguments: string };
};

/**
 * One chat message on the wire.
 *
 * @example
 * ```ts
 * const message: WireMessage = { role: "tool", tool_call_id: "toolu_01", content: "Subject is cut at the chin." };
 * ```
 */
export type WireMessage =
  | {
      /** Who speaks. */
      role: "system";
      /** The system text; one cached part with `cacheSystem`. */
      content: string | WireTextPart[];
    }
  | {
      /** Who speaks. */
      role: "user";
      /** Text, or text and image parts. */
      content: string | WirePart[];
    }
  | {
      /** Who speaks. */
      role: "assistant";
      /** The assistant text; `null` when the turn is only tool calls. */
      content: string | null;
      /** The turn's tool calls; omitted when it has none. */
      tool_calls?: WireToolCall[];
    }
  | {
      /** Who speaks. */
      role: "tool";
      /** Id of the tool call this message answers. */
      tool_call_id: string;
      /** The tool result: text, or text and image parts. */
      content: string | WirePart[];
    };

/**
 * A tool the model may call, on the wire.
 *
 * @example
 * ```ts
 * const tool: WireTool = { type: "function", function: { name: "read_frame", description: "Return one frame.", parameters: { type: "object" } } };
 * ```
 */
export type WireTool = {
  /** Always a function tool. */
  type: "function";
  /** Name, description and the JSON schema of the input. */
  function: { name: string; description: string; parameters: ToolDefinition["inputSchema"] };
};

/**
 * Whether and which tool the model must call, on the wire.
 *
 * @example
 * ```ts
 * const choice: WireToolChoice = { type: "function", function: { name: "read_frame" } };
 * ```
 */
export type WireToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      /** Always a function tool. */
      type: "function";
      /** The tool the model must call. */
      function: { name: string };
    };

/**
 * The body fields of a request with tools; each is omitted when unset.
 *
 * @example
 * ```ts
 * const fields: ToolFields = { tool_choice: "required" };
 * ```
 */
export type ToolFields = {
  /** The tools the model may call. */
  tools?: WireTool[];
  /** Whether and which tool the model must call. */
  tool_choice?: WireToolChoice;
};

/** An image part of a prompt-gen message. */
type ImagePart = Extract<ContentPart, { type: "image" }>;

/** An assistant turn of a prompt-gen conversation. */
type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

/** Why a turn ended, as the result carries it. */
type FinishReason = PromptGenResult["finishReason"];

/** Finish reasons the result keeps as sent; any other is `"other"`. */
const KNOWN_FINISH_REASONS: ReadonlySet<string> = new Set(["stop", "tool_calls", "length"]);

/** Separator between the texts of a conversation. */
const TEXT_SEPARATOR = "\n";

/**
 * A text part on the wire, with `cache_control` when a cache breakpoint
 * follows it.
 *
 * @param text - The text.
 * @param cache - Whether a cache breakpoint follows the part.
 * @returns The wire part.
 * @example
 * ```ts
 * textPart("Shot list.", true); // => { type: "text", text: "Shot list.", cache_control: { type: "ephemeral" } }
 * ```
 */
function textPart(text: string, cache: boolean): WireTextPart {
  if (!cache) return { type: "text", text };
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

/**
 * The image part of an uploaded URL; nothing before the upload.
 *
 * @param url - The uploaded URL, or undefined when not uploaded yet.
 * @returns One wire part, or none.
 * @example
 * ```ts
 * imagePart(undefined); // => []
 * ```
 */
function imagePart(url: string | undefined): WireImagePart[] {
  if (url === undefined) return [];
  return [{ type: "image_url", image_url: { url } }];
}

/**
 * The JSON text of a tool call's input; a missing input is `{}`.
 *
 * @param input - The parsed input.
 * @returns JSON text.
 * @example
 * ```ts
 * argumentsOf({ shot: 3 }); // => '{"shot":3}'
 * ```
 */
function argumentsOf(input: unknown): string {
  return JSON.stringify(input ?? {});
}

/**
 * An assistant turn on the wire: its text, plus `tool_calls` when it called
 * tools.
 *
 * @param message - The assistant turn.
 * @returns The wire message.
 * @example
 * ```ts
 * assistantMessage({ role: "assistant", content: "Done." }); // => { role: "assistant", content: "Done." }
 * ```
 */
function assistantMessage(message: AssistantMessage): WireMessage {
  const calls = message.toolCalls ?? [];
  if (calls.length === 0) return { role: "assistant", content: message.content };

  const toolCalls: WireToolCall[] = calls.map(call => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: argumentsOf(call.input) }
  }));
  return { role: "assistant", content: message.content, tool_calls: toolCalls };
}

/**
 * The system message: none without system text; with `cacheSystem` the text
 * is one part with a cache breakpoint after it.
 *
 * @param system - `request.system`.
 * @param cacheSystem - Whether a cache breakpoint follows the system text.
 * @returns Zero or one message.
 * @example
 * ```ts
 * systemMessages("Be brief.", false); // => [{ role: "system", content: "Be brief." }]
 * systemMessages("Be brief.", true); // => [{ role: "system", content: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }] }]
 * ```
 */
export function systemMessages(system: string | undefined, cacheSystem: boolean): WireMessage[] {
  if (system === undefined) return [];
  if (!cacheSystem) return [{ role: "system", content: system }];
  return [{ role: "system", content: [textPart(system, true)] }];
}

/**
 * The image parts of a conversation, in message order: one upload per part.
 *
 * @param messages - The prompt-gen turns.
 * @returns The image parts.
 * @example
 * ```ts
 * imagePartsOf([{ role: "user", content: [{ type: "image", path: "a.png", mimeType: "image/png", hash: "h" }] }]).length; // => 1
 * ```
 */
export function imagePartsOf(messages: readonly ChatMessage[]): ImagePart[] {
  return messages.flatMap(message => {
    if (message.role === "assistant" || typeof message.content === "string") return [];
    return message.content.flatMap(part => (part.type === "text" ? [] : [part]));
  });
}

/**
 * The turns on the wire, in order. Each image part takes the next uploaded
 * URL, in message order (the order of {@link imagePartsOf}); an image part
 * without a URL yet is left out.
 *
 * @param messages - The prompt-gen turns.
 * @param imageUrls - Uploaded image URLs, one per image part, in order.
 * @returns The wire messages.
 * @example
 * ```ts
 * turnMessages([{ role: "tool", toolCallId: "toolu_01", content: "ok" }], []); // => [{ role: "tool", tool_call_id: "toolu_01", content: "ok" }]
 * ```
 */
export function turnMessages(
  messages: readonly ChatMessage[],
  imageUrls: readonly string[]
): WireMessage[] {
  // Each image part takes the next URL: one walk in message order.
  const urls = imageUrls.values();
  const partsOf = (content: string | readonly ContentPart[]): string | WirePart[] => {
    if (typeof content === "string") return content;
    return content.flatMap((part): WirePart[] =>
      part.type === "text"
        ? [textPart(part.text, part.cache === true)]
        : imagePart(urls.next().value)
    );
  };

  return messages.map((message): WireMessage => {
    if (message.role === "user") return { role: "user", content: partsOf(message.content) };
    if (message.role === "assistant") return assistantMessage(message);
    return { role: "tool", tool_call_id: message.toolCallId, content: partsOf(message.content) };
  });
}

/**
 * The `tools` and `tool_choice` body fields. `tools` is sent only when
 * there is at least one tool, `tool_choice` only when set; a `{ name }`
 * choice becomes a function choice.
 *
 * @param request - The prompt-gen request.
 * @returns The fields, or nothing.
 * @example
 * ```ts
 * toolFields({ toolChoice: { name: "read_frame" } }); // => { tool_choice: { type: "function", function: { name: "read_frame" } } }
 * ```
 */
export function toolFields(request: Pick<PromptGenRequest, "tools" | "toolChoice">): ToolFields {
  const { tools, toolChoice } = request;
  const hasTools = tools !== undefined && tools.length > 0;
  const toolsField: ToolFields = hasTools
    ? {
        tools: tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        }))
      }
    : {};
  if (toolChoice === undefined) return toolsField;

  const choice: WireToolChoice =
    typeof toolChoice === "string"
      ? toolChoice
      : { type: "function", function: { name: toolChoice.name } };
  return { ...toolsField, tool_choice: choice };
}

/**
 * The parsed input of a tool call: `""` or missing arguments are `{}`,
 * arguments already parsed are kept, JSON text is parsed.
 *
 * @param name - The called tool, for the error.
 * @param raw - `function.arguments`, untrusted.
 * @returns The input.
 * @throws {ToolArgumentsError} When the text is not JSON.
 * @example
 * ```ts
 * toolInputOf("read_frame", '{"shot":3}'); // => { shot: 3 }
 * ```
 */
function toolInputOf(name: string, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ToolArgumentsError(name, raw);
  }
}

/**
 * One tool call of an answer.
 *
 * @param item - One `tool_calls` entry, untrusted.
 * @returns The call with its parsed input.
 * @throws {ToolArgumentsError} When the arguments are not JSON.
 * @throws {Error} A plain error when the id or the function name is missing.
 * @example
 * ```ts
 * toolCallOf({ id: "toolu_01", type: "function", function: { name: "read_frame", arguments: "" } }); // => { id: "toolu_01", name: "read_frame", input: {} }
 * ```
 */
function toolCallOf(item: unknown): ToolCall {
  const id = readString(item, "id");
  const fn = readField(item, "function");
  const name = readString(fn, "name");
  if (id === undefined || name === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete tool call.\n  Expected id and function.name on every choices[0].message.tool_calls entry."
    );
  }
  return { id, name, input: toolInputOf(name, readField(fn, "arguments")) };
}

/**
 * The tool calls of an answer's message; none when the field is missing.
 *
 * @param value - `choices[0].message.tool_calls`, untrusted.
 * @returns The calls, in order.
 * @throws {ToolArgumentsError} When a call's arguments are not JSON.
 * @throws {Error} A plain error when a call has no id or no function name.
 * @example
 * ```ts
 * readToolCalls([{ id: "toolu_01", type: "function", function: { name: "read_frame", arguments: '{"shot":3}' } }]); // => [{ id: "toolu_01", name: "read_frame", input: { shot: 3 } }]
 * ```
 */
export function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => toolCallOf(item));
}

/**
 * Whether a finish reason is one the result keeps as sent.
 *
 * @param value - `choices[0].finish_reason`.
 * @returns True for stop, tool_calls or length.
 * @example
 * ```ts
 * isKnownFinishReason("content_filter"); // => false
 * ```
 */
function isKnownFinishReason(value: string | undefined): value is Exclude<FinishReason, "other"> {
  return value !== undefined && KNOWN_FINISH_REASONS.has(value);
}

/**
 * The result's finish reason: stop, tool_calls and length as sent, anything
 * else (missing included) `"other"`.
 *
 * @param value - `choices[0].finish_reason`.
 * @returns The finish reason.
 * @example
 * ```ts
 * finishReasonOf("content_filter"); // => "other"
 * ```
 */
export function finishReasonOf(value: string | undefined): FinishReason {
  return isKnownFinishReason(value) ? value : "other";
}

/**
 * The typed usage of an answer; each count is 0 when fal does not report it.
 * Cache writes are `cache_creation_input_tokens`, else
 * `prompt_tokens_details.cache_write_tokens`.
 *
 * @param usage - The answer's `usage` field, untrusted.
 * @returns The usage.
 * @example
 * ```ts
 * usageOf({ prompt_tokens: 2400, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 1800 } }); // => { promptTokens: 2400, completionTokens: 120, cachedTokens: 1800, cacheWriteTokens: 0 }
 * ```
 */
export function usageOf(usage: unknown): PromptGenUsage {
  const details = readField(usage, "prompt_tokens_details");
  const cacheWrites =
    readNumber(usage, "cache_creation_input_tokens") ?? readNumber(details, "cache_write_tokens");
  return {
    promptTokens: readNumber(usage, "prompt_tokens") ?? 0,
    completionTokens: readNumber(usage, "completion_tokens") ?? 0,
    cachedTokens: readNumber(details, "cached_tokens") ?? 0,
    cacheWriteTokens: cacheWrites ?? 0
  };
}

/**
 * The texts of a message content: the string, or every text part.
 *
 * @param content - A user or tool message content.
 * @returns The texts, in order.
 * @example
 * ```ts
 * contentTexts([{ type: "text", text: "a" }, { type: "image", path: "b.png", mimeType: "image/png", hash: "h" }]); // => ["a"]
 * ```
 */
function contentTexts(content: string | readonly ContentPart[]): string[] {
  if (typeof content === "string") return [content];
  return content.flatMap(part => (part.type === "text" ? [part.text] : []));
}

/**
 * The texts a message sends: its text parts, or an assistant's text and the
 * JSON arguments of its tool calls.
 *
 * @param message - One turn.
 * @returns The texts, in order.
 * @example
 * ```ts
 * messageTexts({ role: "assistant", content: null, toolCalls: [{ id: "c", name: "t", input: { shot: 3 } }] }); // => ['{"shot":3}']
 * ```
 */
function messageTexts(message: ChatMessage): string[] {
  if (message.role !== "assistant") return contentTexts(message.content);

  const text = message.content === null ? [] : [message.content];
  const calls = (message.toolCalls ?? []).map(call => argumentsOf(call.input));
  return [...text, ...calls];
}

/**
 * Everything a request sends as text, for the estimate and the character
 * rule. Without messages: system and prompt, joined as before. With
 * messages: the system text, every text part, assistant texts and tool-call
 * argument JSON, one per line.
 *
 * @param request - The prompt-gen request.
 * @returns The input text.
 * @example
 * ```ts
 * inputTextOf({ prompt: "", system: "s", messages: [{ role: "user", content: "hi" }] }); // => "s\nhi"
 * ```
 */
export function inputTextOf(
  request: Pick<PromptGenRequest, "system" | "prompt" | "messages">
): string {
  if (request.messages === undefined) return `${request.system ?? ""}${request.prompt}`;

  const system = request.system === undefined ? [] : [request.system];
  const turns = request.messages.flatMap(message => messageTexts(message));
  return [...system, ...turns].join(TEXT_SEPARATOR);
}

/**
 * The prompt the request log carries: `request.prompt` without messages;
 * with messages the text of the last user or tool message (`""` when none).
 *
 * @param request - The prompt-gen request.
 * @returns The logged prompt.
 * @example
 * ```ts
 * promptTextOf({ prompt: "", messages: [{ role: "user", content: "Check shot 3." }] }); // => "Check shot 3."
 * ```
 */
export function promptTextOf(request: Pick<PromptGenRequest, "prompt" | "messages">): string {
  if (request.messages === undefined) return request.prompt;

  const last = request.messages.findLast(message => message.role !== "assistant");
  return last === undefined ? "" : contentTexts(last.content).join(TEXT_SEPARATOR);
}
