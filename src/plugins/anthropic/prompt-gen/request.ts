/**
 * @file anthropic prompt-gen request — the plan of a prompt-gen request
 * (every check before any I/O: input, model and price, effort, answer
 * schema, max tokens, images), the Messages API body built from it, and the
 * offline input-token estimate. The body is built in request order: the
 * system text, then the turns, so the first 4 cache marks are the ones kept.
 */
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type {
  ChatMessage,
  ContentPart,
  PromptGenRequest,
  ToolDefinition
} from "../../promptGen/contract";
import { badRequest } from "../client";
import type { ImageFile } from "../images";
import { imageFileOf } from "../images";
import { resolveModelId } from "../models";
import { getPrices, priceOf } from "../prices";
import type {
  AnthropicContentBlock,
  AnthropicContext,
  AnthropicEffort,
  AnthropicImageBlock,
  AnthropicInputMessage as AnthropicInputMessageeter,
  AnthropicOutputConfig,
  AnthropicPrice,
  AnthropicRequestBody,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  JsonSchema
} from "../types";

/**
 * Everything checked before any I/O.
 *
 * @example
 * ```ts
 * planRequest(ctx, { prompt: "Judge." }).outputConfig; // => { effort: "medium" }
 * ```
 */
export type RequestPlan = {
  /** Native model id. */
  model: string;
  /** The model's price. */
  price: AnthropicPrice;
  /** Output token cap. */
  maxTokens: number;
  /** Effort and answer schema. */
  outputConfig: AnthropicOutputConfig;
  /** Images to read, in the order their blocks go into the body. */
  images: ImageFile[];
};

/** What the turn mapping reads besides the messages. */
type TurnSources = {
  /** Takes one of the request's cache marks; false once they are used up. */
  takeMark: () => boolean;
  /** The next image block, in message order. */
  nextImage: () => AnthropicImageBlock | undefined;
  /** Remembered answer blocks by first tool_use id. */
  turns: ReadonlyMap<string, AnthropicContentBlock[]>;
};

/** A user or tool message's content as sent. */
type SentContent = string | Array<AnthropicTextBlock | AnthropicImageBlock>;

/** The assistant turn of a prompt-gen conversation. */
type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

/** `params.reasoning` → effort. Thinking cannot be switched off, so `off` asks for the least. */
const EFFORT_OF_REASONING: ReadonlyMap<string, AnthropicEffort> = new Map([
  ["off", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"]
]);

/** Effort when `params.reasoning` is not set. */
const DEFAULT_EFFORT: AnthropicEffort = "medium";

/** Most cache breakpoints one request may carry. */
const MAX_CACHE_MARKS = 4;

/** Characters per estimated token. */
const CHARS_PER_TOKEN = 4;

/** Estimated input tokens of one image. */
const IMAGE_TOKENS = 1600;

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
      "[ai] Anthropic prompt-gen messages must not be empty.\n  Pass at least one user message."
    );
  }

  const hasPrompt = typeof request.prompt === "string" && request.prompt.trim() !== "";
  if (hasPrompt) return;
  throw badRequest(
    "[ai] Anthropic prompt-gen needs a non-empty prompt.\n  Pass the text to generate from in request.prompt."
  );
}

/**
 * The effort of `params.reasoning`: off and low → low, medium, high; unset → medium.
 *
 * @param reasoning - `params.reasoning`, untrusted.
 * @returns The effort.
 * @throws {TerminalProviderError} A 400 for any other value.
 * @example
 * ```ts
 * effortOf("off"); // => "low"
 * ```
 */
function effortOf(reasoning: unknown): AnthropicEffort {
  if (reasoning === undefined) return DEFAULT_EFFORT;

  const effort = typeof reasoning === "string" ? EFFORT_OF_REASONING.get(reasoning) : undefined;
  if (effort !== undefined) return effort;
  throw badRequest(
    '[ai] Anthropic params.reasoning must be "off", "low", "medium" or "high".\n  Pass one of the four levels.'
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
function isPlainObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The schema in the form structured output accepts (objects closed,
 * unsupported keywords moved into descriptions); a schema the SDK's
 * normalizer cannot read, such as one with no type, is sent as given.
 *
 * @param schema - `params.responseSchema`.
 * @returns The schema to send.
 * @example
 * ```ts
 * normalizedSchema({ type: "object", properties: {} }); // => { type: "object", properties: {}, additionalProperties: false }
 * ```
 */
function normalizedSchema(schema: JsonSchema): JsonSchema {
  try {
    return transformJSONSchema(schema);
  } catch {
    return schema;
  }
}

/**
 * The `output_config` of a request: the effort, and the answer schema of
 * `params.responseSchema` when set.
 *
 * @param params - Request params.
 * @returns The output config.
 * @throws {TerminalProviderError} A 400 for a bad reasoning level or a schema that is not a plain object.
 * @example
 * ```ts
 * outputConfigOf({ reasoning: "high" }); // => { effort: "high" }
 * ```
 */
function outputConfigOf(params: Record<string, unknown> | undefined): AnthropicOutputConfig {
  const effort = effortOf(params?.reasoning);
  const schema = params?.responseSchema;
  if (schema === undefined) return { effort };

  if (!isPlainObject(schema)) {
    throw badRequest(
      "[ai] Anthropic params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object."
    );
  }
  return { effort, format: { type: "json_schema", schema: normalizedSchema(schema) } };
}

/**
 * The output token cap: `params.max_tokens` when a positive integer.
 *
 * @param value - `params.max_tokens`, untrusted.
 * @param fallback - `config.maxTokens`.
 * @returns The cap.
 * @example
 * ```ts
 * maxTokensOf(1.5, 32_000); // => 32000
 * ```
 */
function maxTokensOf(value: unknown, fallback: number): number {
  const isPositiveInteger = typeof value === "number" && Number.isInteger(value) && value > 0;
  return isPositiveInteger ? value : fallback;
}

/**
 * The image parts of a conversation, in message order (user and tool turns).
 *
 * @param messages - The prompt-gen turns.
 * @returns The image parts.
 * @example
 * ```ts
 * imagePartsOf([{ role: "user", content: [{ type: "image", path: "a.png", mimeType: "image/png", hash: "h" }] }]).length; // => 1
 * ```
 */
function imagePartsOf(messages: readonly ChatMessage[]): ContentPart[] {
  return messages.flatMap(message => {
    if (message.role === "assistant" || typeof message.content === "string") return [];
    return message.content.filter(part => part.type === "image");
  });
}

/**
 * The images of a request: `params.images` (one file or a list) without
 * messages; the image parts in message order with messages, where
 * `params.images` is refused.
 *
 * @param request - The prompt-gen request.
 * @returns The checked image files, in body order.
 * @throws {TerminalProviderError} A 400 for `params.images` with messages, a value that is not a local file, or an image type the API cannot read.
 * @example
 * ```ts
 * requestImages({ prompt: "p", params: { images: { path: "a.png", mimeType: "image/png", hash: "h" } } }).length; // => 1
 * ```
 */
function requestImages(request: PromptGenRequest): ImageFile[] {
  const images = request.params?.images;
  if (request.messages === undefined) {
    if (images === undefined) return [];
    const items: unknown[] = Array.isArray(images) ? images : [images];
    return items.map(item => imageFileOf(item));
  }

  if (images !== undefined) {
    throw badRequest(
      "[ai] Anthropic prompt-gen takes no params.images with messages.\n  Put images in message content parts."
    );
  }
  return imagePartsOf(request.messages).map(part => imageFileOf(part));
}

/**
 * Plans a request without I/O: input, model (default `config.model`) and
 * its price, max tokens, effort and answer schema, images. No other param
 * is read: `temperature` is never sent.
 *
 * @param ctx - Plugin context (config, price table).
 * @param request - The prompt-gen request.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an empty prompt or messages, a model without a price, a bad param or image.
 */
export function planRequest(ctx: AnthropicContext, request: PromptGenRequest): RequestPlan {
  assertHasInput(request);

  // Model and price first: a model without a price never runs.
  const model = resolveModelId(request.model, ctx.config.model);
  const price = priceOf(getPrices(ctx), model);

  // The params this handler reads; every other param is ignored.
  const { params } = request;
  return {
    model,
    price,
    maxTokens: maxTokensOf(params?.max_tokens, ctx.config.maxTokens),
    outputConfig: outputConfigOf(params),
    images: requestImages(request)
  };
}

/**
 * A counter of the request's cache marks: each call takes one while any is left.
 *
 * @param limit - Marks the request may carry.
 * @returns A function that takes a mark, true while one was left.
 * @example
 * ```ts
 * const takeMark = cacheMarks(1); takeMark(); // => true, then false
 * ```
 */
function cacheMarks(limit: number): () => boolean {
  let left = limit;
  return (): boolean => {
    if (left === 0) return false;
    left -= 1;
    return true;
  };
}

/**
 * A text block, with `cache_control` when it carries a cache mark.
 *
 * @param text - The text.
 * @param cached - Whether a cache breakpoint follows the block.
 * @returns The block.
 * @example
 * ```ts
 * textBlock("Bible.", true); // => { type: "text", text: "Bible.", cache_control: { type: "ephemeral" } }
 * ```
 */
function textBlock(text: string, cached: boolean): AnthropicTextBlock {
  if (!cached) return { type: "text", text };
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

/**
 * The `system` field: omitted without system text, a string without
 * `cacheSystem`, one cached text block with it.
 *
 * @param system - `request.system`.
 * @param cacheSystem - Whether a cache breakpoint follows the system text.
 * @param takeMark - Takes a cache mark.
 * @returns The field, or nothing.
 * @example
 * ```ts
 * systemField("Be brief.", false, () => true); // => { system: "Be brief." }
 * ```
 */
function systemField(
  system: string | undefined,
  cacheSystem: boolean,
  takeMark: () => boolean
): { system?: string | AnthropicTextBlock[] } {
  if (system === undefined) return {};
  if (!cacheSystem) return { system };
  return { system: [textBlock(system, takeMark())] };
}

/**
 * The one user message of a prompt request: the prompt text, after the
 * image blocks when there are images.
 *
 * @param prompt - `request.prompt`.
 * @param imageBlocks - The image blocks of `params.images`, in order.
 * @returns The message.
 * @example
 * ```ts
 * promptMessage("Judge.", []); // => { role: "user", content: "Judge." }
 * ```
 */
function promptMessage(
  prompt: string,
  imageBlocks: readonly AnthropicImageBlock[]
): AnthropicInputMessageeter {
  if (imageBlocks.length === 0) return { role: "user", content: prompt };
  return { role: "user", content: [...imageBlocks, { type: "text", text: prompt }] };
}

/**
 * A user or tool content as sent: a string as is; parts as text blocks
 * (cached when the part asks and a mark is left) and image blocks taken in
 * message order.
 *
 * @param content - The message content.
 * @param sources - Cache marks and image blocks.
 * @returns The sent content.
 */
function contentOf(content: string | readonly ContentPart[], sources: TurnSources): SentContent {
  if (typeof content === "string") return content;
  return content.flatMap((part): Array<AnthropicTextBlock | AnthropicImageBlock> => {
    if (part.type === "text")
      return [textBlock(part.text, part.cache === true && sources.takeMark())];
    const image = sources.nextImage();
    return image === undefined ? [] : [image];
  });
}

/**
 * An assistant turn as sent: the remembered answer blocks of its first
 * tool call, unchanged (thinking included); else its text and one tool_use
 * block per call.
 *
 * @param message - The assistant turn.
 * @param turns - Remembered answer blocks by first tool_use id.
 * @returns The message.
 * @example
 * ```ts
 * assistantMessage({ role: "assistant", content: "Done." }, new Map()); // => { role: "assistant", content: [{ type: "text", text: "Done." }] }
 * ```
 */
function assistantMessage(
  message: AssistantMessage,
  turns: ReadonlyMap<string, AnthropicContentBlock[]>
): AnthropicInputMessageeter {
  const calls = message.toolCalls ?? [];
  const firstCallId = calls[0]?.id;
  const remembered = firstCallId === undefined ? undefined : turns.get(firstCallId);
  if (remembered !== undefined) return { role: "assistant", content: remembered };

  const text: AnthropicContentBlock[] =
    message.content === null || message.content === ""
      ? []
      : [{ type: "text", text: message.content }];
  const toolUses: AnthropicContentBlock[] = calls.map(call => ({
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: call.input
  }));
  return { role: "assistant", content: [...text, ...toolUses] };
}

/**
 * The turns as sent, in order. Consecutive tool messages become one user
 * message of tool_result blocks.
 *
 * @param messages - The prompt-gen turns.
 * @param sources - Cache marks, image blocks and remembered turns.
 * @returns The messages.
 */
function turnMessages(
  messages: readonly ChatMessage[],
  sources: TurnSources
): AnthropicInputMessageeter[] {
  const sent: AnthropicInputMessageeter[] = [];
  let toolResults: AnthropicToolResultBlock[] | undefined;

  for (const message of messages) {
    // A tool result joins the open tool-result message, or opens one.
    if (message.role === "tool") {
      if (toolResults === undefined) {
        toolResults = [];
        sent.push({ role: "user", content: toolResults });
      }
      const content = contentOf(message.content, sources);
      toolResults.push({ type: "tool_result", tool_use_id: message.toolCallId, content });
      continue;
    }

    // Any other turn closes it.
    toolResults = undefined;
    sent.push(
      message.role === "user"
        ? { role: "user", content: contentOf(message.content, sources) }
        : assistantMessage(message, sources.turns)
    );
  }
  return sent;
}

/**
 * A tool as sent. Tool inputs are objects; the schema itself goes as given.
 *
 * @param tool - The tool definition.
 * @returns The tool.
 * @example
 * ```ts
 * toolOf({ name: "t", description: "d", inputSchema: { type: "object" } }); // => { name: "t", description: "d", input_schema: { type: "object" } }
 * ```
 */
function toolOf(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", ...tool.inputSchema }
  };
}

/**
 * The tool choice as sent: auto, none, required → any, a name → tool.
 *
 * @param choice - `request.toolChoice`.
 * @returns The choice.
 * @example
 * ```ts
 * toolChoiceOf("required"); // => { type: "any" }
 * ```
 */
function toolChoiceOf(choice: NonNullable<PromptGenRequest["toolChoice"]>): AnthropicToolChoice {
  if (typeof choice !== "string") return { type: "tool", name: choice.name };
  if (choice === "required") return { type: "any" };
  return choice === "auto" ? { type: "auto" } : { type: "none" };
}

/**
 * The `tools` and `tool_choice` fields: tools only when there is one,
 * the choice only when set.
 *
 * @param request - The prompt-gen request.
 * @returns The fields, or nothing.
 * @example
 * ```ts
 * toolFields({ toolChoice: "none" }); // => { tool_choice: { type: "none" } }
 * ```
 */
function toolFields(request: Pick<PromptGenRequest, "tools" | "toolChoice">): {
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
} {
  const { tools, toolChoice } = request;
  const toolsField =
    tools === undefined || tools.length === 0 ? {} : { tools: tools.map(tool => toolOf(tool)) };
  if (toolChoice === undefined) return toolsField;
  return { ...toolsField, tool_choice: toolChoiceOf(toolChoice) };
}

/**
 * Builds the Messages API body in request order: the system text (the
 * first cache mark), then the prompt message or the turns. A remembered
 * tool turn goes back unchanged. No `temperature`, no `thinking`.
 *
 * @param request - The prompt-gen request.
 * @param plan - Its plan.
 * @param imageBlocks - The image blocks of `plan.images`, in order.
 * @param turns - Remembered answer blocks by first tool_use id.
 * @returns The body.
 */
export function buildRequestBody(
  request: PromptGenRequest,
  plan: RequestPlan,
  imageBlocks: readonly AnthropicImageBlock[],
  turns: ReadonlyMap<string, AnthropicContentBlock[]>
): AnthropicRequestBody {
  const takeMark = cacheMarks(MAX_CACHE_MARKS);
  const system = systemField(request.system, request.cacheSystem === true, takeMark);

  // The prompt request is one user message; a conversation takes its image blocks in order.
  const images = imageBlocks.values();
  const sources: TurnSources = { takeMark, nextImage: () => images.next().value, turns };
  const messages =
    request.messages === undefined
      ? [promptMessage(request.prompt, imageBlocks)]
      : turnMessages(request.messages, sources);

  return {
    model: plan.model,
    max_tokens: plan.maxTokens,
    ...system,
    messages,
    ...toolFields(request),
    output_config: plan.outputConfig
  };
}

/**
 * The texts a message sends: its text parts, or an assistant's text and
 * the JSON of its tool-call inputs.
 *
 * @param message - One turn.
 * @returns The texts.
 * @example
 * ```ts
 * messageTexts({ role: "assistant", content: null, toolCalls: [{ id: "c", name: "t", input: { shot: 3 } }] }); // => ['{"shot":3}']
 * ```
 */
function messageTexts(message: ChatMessage): string[] {
  if (message.role === "assistant") {
    const text = message.content === null ? [] : [message.content];
    const calls = (message.toolCalls ?? []).map(call => JSON.stringify(call.input ?? {}));
    return [...text, ...calls];
  }
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
}

/**
 * Estimated input tokens of a request: its characters / 4 (system, and the
 * prompt or every message text and tool-call JSON), plus 1 600 per image.
 *
 * @param request - The prompt-gen request.
 * @param imageCount - Images the request sends.
 * @returns Token estimate.
 * @example
 * ```ts
 * estimateInputTokens({ prompt: "abcd", system: "abcdefgh" }, 1); // => 1603
 * ```
 */
export function estimateInputTokens(request: PromptGenRequest, imageCount: number): number {
  const system = request.system === undefined ? [] : [request.system];
  const turns =
    request.messages === undefined
      ? [request.prompt]
      : request.messages.flatMap(message => messageTexts(message));
  const chars = [...system, ...turns].reduce((sum, text) => sum + text.length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + IMAGE_TOKENS * imageCount;
}
