/**
 * @file openai prompt-gen request — the checks every request passes before
 * any I/O (each a terminal 400), the Responses request body (developer
 * message, prompt or turns, replayed reasoning, images, cache breakpoints,
 * reasoning or temperature, structured answer, tools) and the offline input
 * estimate. Pure: images arrive as data URLs already read.
 */
import type {
  ChatMessage,
  ContentPart,
  PromptGenRequest,
  ToolDefinition
} from "../../promptGen/contract";
import { TerminalProviderError } from "../errors";
import { estimateTokenCount } from "../prices";
import type {
  OpenaiCacheBreakpoint,
  OpenaiFunctionCall,
  OpenaiFunctionTool,
  OpenaiInputContent,
  OpenaiInputItem,
  OpenaiInputText,
  OpenaiLocalImage,
  OpenaiReasoningItem,
  OpenaiResponsesRequestBody,
  OpenaiTextFormat,
  OpenaiToolChoice
} from "../types";
import type { ReasoningLevel } from "./models";
import { effortOf, isGpt6Model, resolveModelId } from "./models";

/**
 * `max_output_tokens` when `params.max_tokens` is not a positive integer.
 *
 * @example
 * ```ts
 * planResponses({ prompt: "hi" }, "gpt-4o-mini").maxOutputTokens; // => 32000
 * ```
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Estimated input tokens of one image.
 *
 * @example
 * ```ts
 * estimateInputTokens({ prompt: "abcd" }, 2); // => 1 + 2 * IMAGE_TOKENS
 * ```
 */
export const IMAGE_TOKENS = 1600;

/**
 * Cache breakpoints one request may carry; later marks are dropped.
 *
 * @example
 * ```ts
 * // system + 4 marked parts: the system and the first 3 parts keep their mark.
 * MAX_CACHE_MARKS; // => 4
 * ```
 */
export const MAX_CACHE_MARKS = 4;

/**
 * Everything checked before any I/O, and what the body needs from params.
 *
 * @example
 * ```ts
 * const plan: ResponsesPlan = { model: "gpt-6-astra", reasoning: "medium", maxOutputTokens: 32_000, text: undefined, images: [] };
 * ```
 */
export type ResponsesPlan = {
  /** The OpenAI model id. */
  model: string;
  /** Reasoning level; medium when unset. */
  reasoning: ReasoningLevel;
  /** Output token cap. */
  maxOutputTokens: number;
  /** Structured-answer request; undefined without a schema. */
  text: OpenaiTextFormat | undefined;
  /** Images to read, in the order their data URLs go into the body. */
  images: OpenaiLocalImage[];
};

/** Takes one cache mark while the request has marks left; false once they are gone. */
type MarkBudget = () => boolean;

/** Reasoning level when `params.reasoning` is not set. */
const DEFAULT_REASONING: ReasoningLevel = "medium";

/** Reasoning levels the studio sends. */
const REASONING_LEVELS: ReadonlySet<string> = new Set(["off", "low", "medium", "high"]);

/** Name of the structured answer's schema. */
const SCHEMA_NAME = "answer";

/** Status of a request refused before any I/O. */
const BAD_REQUEST = 400;

/** Separator between the texts of a conversation in the estimate. */
const TEXT_SEPARATOR = "\n";

/** The explicit cache breakpoint of a marked `input_text`. */
const CACHE_BREAKPOINT: OpenaiCacheBreakpoint = { mode: "explicit" };

/**
 * A terminal 400 for a bad request field.
 *
 * @param message - The two-line message.
 * @returns The error to throw.
 * @example
 * ```ts
 * badRequest("[ai] x.\n  y.").status; // => 400
 * ```
 */
function badRequest(message: string): TerminalProviderError {
  return new TerminalProviderError(message, BAD_REQUEST);
}

/**
 * Whether a value is a reasoning level.
 *
 * @param value - Any value.
 * @returns True for off, low, medium or high.
 * @example
 * ```ts
 * isReasoningLevel("max"); // => false
 * ```
 */
function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && REASONING_LEVELS.has(value);
}

/**
 * The reasoning level of `params.reasoning`.
 *
 * @param value - `params.reasoning`, untrusted.
 * @returns The level; medium when unset.
 * @throws {TerminalProviderError} A 400 for any other value.
 * @example
 * ```ts
 * reasoningOf(undefined); // => "medium"
 * ```
 */
function reasoningOf(value: unknown): ReasoningLevel {
  if (value === undefined) return DEFAULT_REASONING;
  if (isReasoningLevel(value)) return value;
  throw badRequest(
    '[ai] OpenAI params.reasoning must be "off", "low", "medium" or "high".\n  Pass one of the four levels.'
  );
}

/**
 * Whether a value is a plain object (a JSON schema).
 *
 * @param value - Any value.
 * @returns True for a non-null, non-array object.
 * @example
 * ```ts
 * isPlainObject([]); // => false
 * ```
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The structured-answer request of `params.responseSchema`.
 *
 * @param params - Request params.
 * @returns The `text` field, or undefined without a schema.
 * @throws {TerminalProviderError} A 400 when the schema is not a plain object.
 * @example
 * ```ts
 * textFormatOf({ responseSchema: { type: "object" }, strictSchema: true });
 * // => { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } }
 * ```
 */
function textFormatOf(params: Record<string, unknown> | undefined): OpenaiTextFormat | undefined {
  const schema = params?.responseSchema;
  if (schema === undefined) return undefined;
  if (!isPlainObject(schema)) {
    throw badRequest(
      "[ai] OpenAI params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object."
    );
  }
  const strict = params?.strictSchema === true;
  return { format: { type: "json_schema", name: SCHEMA_NAME, schema, strict } };
}

/**
 * The output token cap: `params.max_tokens` when a positive integer.
 *
 * @param value - `params.max_tokens`, untrusted.
 * @returns The cap.
 * @example
 * ```ts
 * maxOutputTokensOf(1.5); // => 32000
 * ```
 */
function maxOutputTokensOf(value: unknown): number {
  const isPositiveInteger = typeof value === "number" && Number.isInteger(value) && value > 0;
  return isPositiveInteger ? value : DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * A string property of an untrusted value.
 *
 * @param value - Any value.
 * @param key - Property name.
 * @returns The string, or undefined when absent or not a string.
 * @example
 * ```ts
 * stringField({ path: "a.png" }, "path"); // => "a.png"
 * ```
 */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

/**
 * One image of `params.images`.
 *
 * @param item - One entry, untrusted.
 * @returns The local file.
 * @throws {TerminalProviderError} A 400 when the entry is not `{ path, mimeType, hash }`.
 * @example
 * ```ts
 * localImageOf({ path: "a.png", mimeType: "image/png", hash: "h" }); // => { path: "a.png", mimeType: "image/png", hash: "h" }
 * ```
 */
function localImageOf(item: unknown): OpenaiLocalImage {
  const path = stringField(item, "path");
  const mimeType = stringField(item, "mimeType");
  const hash = stringField(item, "hash");
  if (path === undefined || mimeType === undefined || hash === undefined) {
    throw badRequest(
      "[ai] OpenAI params.images must be local files.\n  Pass { path, mimeType, hash } for every image."
    );
  }
  return { path, mimeType, hash };
}

/**
 * The image parts of a conversation, in message order.
 *
 * @param messages - The prompt-gen turns.
 * @returns The images.
 * @example
 * ```ts
 * imagePartsOf([{ role: "user", content: [{ type: "image", path: "a.png", mimeType: "image/png", hash: "h" }] }]).length; // => 1
 * ```
 */
function imagePartsOf(messages: readonly ChatMessage[]): OpenaiLocalImage[] {
  return messages.flatMap(message => {
    if (message.role === "assistant" || typeof message.content === "string") return [];
    return message.content.flatMap(part =>
      part.type === "image" ? [{ path: part.path, mimeType: part.mimeType, hash: part.hash }] : []
    );
  });
}

/**
 * The images a request sends: `params.images` (one file or a list) without
 * messages; with messages every image part, and `params.images` is refused.
 *
 * @param request - The prompt-gen request.
 * @returns The images, in body order.
 * @throws {TerminalProviderError} A 400 for `params.images` with messages, or an image that is not `{ path, mimeType, hash }`.
 * @example
 * ```ts
 * imagesOf({ prompt: "p", params: { images: { path: "a.png", mimeType: "image/png", hash: "h" } } }).length; // => 1
 * ```
 */
function imagesOf(request: PromptGenRequest): OpenaiLocalImage[] {
  const images = request.params?.images;
  if (request.messages !== undefined) {
    if (images === undefined) return imagePartsOf(request.messages);
    throw badRequest(
      "[ai] OpenAI prompt-gen takes no params.images with messages.\n  Put images in message content parts."
    );
  }

  if (images === undefined) return [];
  const items: unknown[] = Array.isArray(images) ? images : [images];
  return items.map(item => localImageOf(item));
}

/**
 * Refuses a request with nothing to send: empty `messages`, or an empty
 * prompt without messages (with messages the prompt is ignored).
 *
 * @param request - The prompt-gen request.
 * @throws {TerminalProviderError} A 400 for empty messages or an empty prompt.
 * @example
 * ```ts
 * assertHasInput({ prompt: "", messages: [{ role: "user", content: "hi" }] }); // passes: messages replace the prompt
 * ```
 */
function assertHasInput(request: PromptGenRequest): void {
  if (request.messages !== undefined) {
    if (request.messages.length > 0) return;
    throw badRequest(
      "[ai] OpenAI prompt-gen messages must not be empty.\n  Pass at least one user message."
    );
  }

  if (request.prompt.trim() !== "") return;
  throw badRequest(
    "[ai] OpenAI prompt-gen needs a non-empty prompt.\n  Pass the text to generate from in request.prompt."
  );
}

/**
 * Plans a Responses request without I/O: input present, model (default
 * `config.models.chat`, `openai/` alias dropped), reasoning level, output
 * cap, structured answer and images. No other param is read.
 *
 * @param request - The prompt-gen request.
 * @param defaultModel - `config.models.chat`.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an empty prompt or messages, a bad reasoning value, a schema that is not an object, or bad images.
 * @example
 * ```ts
 * planResponses({ prompt: "hi", model: "openai/gpt-6-luna", params: { reasoning: "off" } }, "gpt-4o-mini");
 * // => { model: "gpt-6-luna", reasoning: "off", maxOutputTokens: 32000, text: undefined, images: [] }
 * ```
 */
export function planResponses(request: PromptGenRequest, defaultModel: string): ResponsesPlan {
  assertHasInput(request);
  const { params } = request;
  return {
    model: resolveModelId(request.model, defaultModel),
    reasoning: reasoningOf(params?.reasoning),
    maxOutputTokens: maxOutputTokensOf(params?.max_tokens),
    text: textFormatOf(params),
    images: imagesOf(request)
  };
}

/**
 * The cache marks of one request: up to {@link MAX_CACHE_MARKS} on a GPT-6
 * model, none on any other model (it ignores the marks).
 *
 * @param model - The OpenAI model id.
 * @returns A function that takes one mark, true while marks remain.
 * @example
 * ```ts
 * markBudgetOf("gpt-4o")(); // => false
 * ```
 */
function markBudgetOf(model: string): MarkBudget {
  let left = isGpt6Model(model) ? MAX_CACHE_MARKS : 0;
  return () => {
    if (left === 0) return false;
    left -= 1;
    return true;
  };
}

/**
 * An `input_text` part, with the explicit cache breakpoint when the part
 * asks for one and the request still has a mark.
 *
 * @param text - The text.
 * @param wantsMark - Whether the part asks for a cache breakpoint.
 * @param takeMark - The request's mark budget.
 * @returns The part.
 * @example
 * ```ts
 * inputText("Bible.", true, () => true); // => { type: "input_text", text: "Bible.", prompt_cache_breakpoint: { mode: "explicit" } }
 * ```
 */
function inputText(text: string, wantsMark: boolean, takeMark: MarkBudget): OpenaiInputText {
  if (wantsMark && takeMark()) {
    return { type: "input_text", text, prompt_cache_breakpoint: CACHE_BREAKPOINT };
  }
  return { type: "input_text", text };
}

/**
 * The `input_image` part of a data URL; nothing when there is no URL.
 *
 * @param url - The data URL, or undefined.
 * @returns Zero or one part.
 * @example
 * ```ts
 * inputImage("data:image/png;base64,AA=="); // => [{ type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" }]
 * ```
 */
function inputImage(url: string | undefined): OpenaiInputContent[] {
  if (url === undefined) return [];
  return [{ type: "input_image", image_url: url, detail: "auto" }];
}

/**
 * The parts of a user or tool content: a string is one text part; each image
 * part takes the next data URL.
 *
 * @param content - The content.
 * @param nextUrl - The next data URL, in body order.
 * @param takeMark - The request's mark budget.
 * @returns The parts.
 * @example
 * ```ts
 * contentOf("hi", () => undefined, () => false); // => [{ type: "input_text", text: "hi" }]
 * ```
 */
function contentOf(
  content: string | readonly ContentPart[],
  nextUrl: () => string | undefined,
  takeMark: MarkBudget
): OpenaiInputContent[] {
  if (typeof content === "string") return [inputText(content, false, takeMark)];
  return content.flatMap(part =>
    part.type === "text"
      ? [inputText(part.text, part.cache === true, takeMark)]
      : inputImage(nextUrl())
  );
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
 * The items of an earlier assistant turn: the reasoning items remembered for
 * its first call id, its text, then its function calls without ids, in the
 * order the model produced them.
 *
 * @param message - The assistant turn.
 * @param turns - Remembered reasoning items by first call id.
 * @returns The input items.
 * @example
 * ```ts
 * assistantItems({ role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "read_frame", input: {} }] }, new Map());
 * // => [{ type: "function_call", call_id: "call_1", name: "read_frame", arguments: "{}" }]
 * ```
 */
function assistantItems(
  message: Extract<ChatMessage, { role: "assistant" }>,
  turns: ReadonlyMap<string, readonly OpenaiReasoningItem[]>
): OpenaiInputItem[] {
  const calls = message.toolCalls ?? [];
  const firstCallId = calls[0]?.id;
  const reasoning = firstCallId === undefined ? [] : (turns.get(firstCallId) ?? []);

  const { content } = message;
  const text: OpenaiInputItem[] =
    content === null || content === "" ? [] : [{ type: "message", role: "assistant", content }];
  const functionCalls = calls.map(
    (call): OpenaiFunctionCall => ({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: argumentsOf(call.input)
    })
  );
  return [...reasoning, ...text, ...functionCalls];
}

/**
 * The turns as input items, in order: user messages, assistant turns (with
 * replayed reasoning), and tool results as `function_call_output` items.
 *
 * @param messages - The prompt-gen turns.
 * @param imageUrls - Data URLs of the image parts, in message order.
 * @param turns - Remembered reasoning items by first call id.
 * @param takeMark - The request's mark budget.
 * @returns The input items.
 * @example
 * ```ts
 * turnItems([{ role: "tool", toolCallId: "call_1", content: "ok" }], [], new Map(), () => false);
 * // => [{ type: "function_call_output", call_id: "call_1", output: "ok" }]
 * ```
 */
function turnItems(
  messages: readonly ChatMessage[],
  imageUrls: readonly string[],
  turns: ReadonlyMap<string, readonly OpenaiReasoningItem[]>,
  takeMark: MarkBudget
): OpenaiInputItem[] {
  // Each image part takes the next URL: one walk in message order.
  const urls = imageUrls.values();
  const nextUrl = (): string | undefined => urls.next().value;

  return messages.flatMap((message): OpenaiInputItem[] => {
    if (message.role === "assistant") return assistantItems(message, turns);
    const content = contentOf(message.content, nextUrl, takeMark);
    if (message.role === "user") return [{ type: "message", role: "user", content }];

    // A tool result keeps a plain string as is.
    const output = typeof message.content === "string" ? message.content : content;
    return [{ type: "function_call_output", call_id: message.toolCallId, output }];
  });
}

/**
 * The developer message (system text) and then the prompt with its images,
 * or the turns.
 *
 * @param request - The prompt-gen request.
 * @param imageUrls - Data URLs, in plan order.
 * @param turns - Remembered reasoning items by first call id.
 * @param takeMark - The request's mark budget.
 * @returns The `input` items.
 * @example
 * ```ts
 * inputOf({ prompt: "hi" }, [], new Map(), () => false);
 * // => [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]
 * ```
 */
function inputOf(
  request: PromptGenRequest,
  imageUrls: readonly string[],
  turns: ReadonlyMap<string, readonly OpenaiReasoningItem[]>,
  takeMark: MarkBudget
): OpenaiInputItem[] {
  // The system text goes first, so it takes the first cache mark.
  const system: OpenaiInputItem[] =
    request.system === undefined
      ? []
      : [
          {
            type: "message",
            role: "developer",
            content: [inputText(request.system, request.cacheSystem === true, takeMark)]
          }
        ];
  if (request.messages !== undefined) {
    return [...system, ...turnItems(request.messages, imageUrls, turns, takeMark)];
  }

  const images = imageUrls.flatMap(url => inputImage(url));
  const prompt = inputText(request.prompt, false, takeMark);
  return [...system, { type: "message", role: "user", content: [prompt, ...images] }];
}

/**
 * The reasoning or sampling fields: a GPT-6 model gets the reasoning effort
 * and asks for the encrypted reasoning, never a temperature; any other model
 * gets no reasoning and the caller's temperature when set.
 *
 * @param plan - The plan (model, reasoning level).
 * @param temperature - `request.temperature`.
 * @returns The fields.
 * @example
 * ```ts
 * samplingFields({ model: "gpt-4o", reasoning: "high", maxOutputTokens: 1, text: undefined, images: [] }, 0.7); // => { temperature: 0.7 }
 * ```
 */
function samplingFields(
  plan: ResponsesPlan,
  temperature: number | undefined
): Pick<OpenaiResponsesRequestBody, "temperature" | "reasoning" | "include"> {
  if (isGpt6Model(plan.model)) {
    return {
      reasoning: { effort: effortOf(plan.model, plan.reasoning) },
      include: ["reasoning.encrypted_content"]
    };
  }
  return temperature === undefined ? {} : { temperature };
}

/**
 * A tool on the wire: a function tool, schema not strict.
 *
 * @param tool - The tool definition.
 * @returns The function tool.
 * @example
 * ```ts
 * functionToolOf({ name: "read_frame", description: "One frame.", inputSchema: { type: "object" } });
 * // => { type: "function", name: "read_frame", description: "One frame.", parameters: { type: "object" }, strict: false }
 * ```
 */
function functionToolOf(tool: ToolDefinition): OpenaiFunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false
  };
}

/**
 * The `tools` and `tool_choice` fields: `tools` only with at least one
 * tool, `tool_choice` only when set; a `{ name }` choice forces that function.
 *
 * @param request - The prompt-gen request.
 * @returns The fields, or nothing.
 * @example
 * ```ts
 * toolFields({ toolChoice: { name: "read_frame" } }); // => { tool_choice: { type: "function", name: "read_frame" } }
 * ```
 */
function toolFields(
  request: Pick<PromptGenRequest, "tools" | "toolChoice">
): Pick<OpenaiResponsesRequestBody, "tools" | "tool_choice"> {
  const tools = request.tools ?? [];
  const toolsField = tools.length === 0 ? {} : { tools: tools.map(tool => functionToolOf(tool)) };
  const { toolChoice } = request;
  if (toolChoice === undefined) return toolsField;

  const choice: OpenaiToolChoice =
    typeof toolChoice === "string" ? toolChoice : { type: "function", name: toolChoice.name };
  return { ...toolsField, tool_choice: choice };
}

/**
 * The Responses request body of a planned request: never stored, the output
 * cap, reasoning or temperature, the structured answer and the tools.
 *
 * @param request - The prompt-gen request.
 * @param plan - Its plan.
 * @param imageUrls - Data URLs of `plan.images`, in order.
 * @param turns - Remembered reasoning items by first call id.
 * @returns The body.
 * @example
 * ```ts
 * buildResponsesBody({ prompt: "hi" }, planResponses({ prompt: "hi" }, "gpt-4o-mini"), [], new Map());
 * // => { model: "gpt-4o-mini", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], store: false, max_output_tokens: 32000 }
 * ```
 */
export function buildResponsesBody(
  request: PromptGenRequest,
  plan: ResponsesPlan,
  imageUrls: readonly string[],
  turns: ReadonlyMap<string, readonly OpenaiReasoningItem[]>
): OpenaiResponsesRequestBody {
  const takeMark = markBudgetOf(plan.model);
  return {
    model: plan.model,
    input: inputOf(request, imageUrls, turns, takeMark),
    store: false,
    max_output_tokens: plan.maxOutputTokens,
    ...samplingFields(plan, request.temperature),
    ...(plan.text === undefined ? {} : { text: plan.text }),
    ...toolFields(request)
  };
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
  if (message.role === "assistant") {
    const text = message.content === null ? [] : [message.content];
    return [...text, ...(message.toolCalls ?? []).map(call => argumentsOf(call.input))];
  }
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
}

/**
 * Estimated input tokens of a request, offline: chars/4 of all the text it
 * sends (system, prompt or every turn, tool-call arguments) plus
 * {@link IMAGE_TOKENS} per image.
 *
 * @param request - The prompt-gen request.
 * @param imageCount - Images the request sends.
 * @returns Token estimate.
 * @example
 * ```ts
 * estimateInputTokens({ prompt: "abcdefg", system: "abcdefgh" }, 1); // => 4 + 1600
 * ```
 */
export function estimateInputTokens(request: PromptGenRequest, imageCount: number): number {
  const system = request.system === undefined ? [] : [request.system];
  const turns =
    request.messages === undefined
      ? [request.prompt]
      : request.messages.flatMap(message => messageTexts(message));
  const text = [...system, ...turns].join(TEXT_SEPARATOR);
  return estimateTokenCount(text) + IMAGE_TOKENS * imageCount;
}
