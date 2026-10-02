/**
 * @file fal LLM chat — plan, sync POST to `<runUrl>/<CHAT_PATH>` (fal's
 * OpenRouter router) with a private retry, and answer reading. Only a 5xx or
 * a request timeout is retried, three attempts at most; 401/403 and 402/429
 * throw `PromptGenUnavailableError` at once, so `promptGen` can fall back
 * without a paid wait. The wire form of messages, tools and cache markers,
 * and the reading of tool calls and usage, live in `conversation.ts`.
 */
import type { PromptGenRequest, PromptGenResult, ToolCall } from "../../promptGen/contract";
import { PromptGenUnavailableError } from "../../promptGen/contract";
import {
  falFetch,
  parseJson,
  readField,
  readString,
  redacted,
  resolveApiKey
} from "../client/http";
import type { FalCall } from "../client/queue";
import { sleep } from "../client/queue";
import { uploadFiles } from "../client/upload";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../errors";
import type { RequestLog } from "../log";
import { withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type { FalContext, LocalFile } from "../types";
import type { WireMessage, WirePart, WireTool, WireToolChoice } from "./conversation";
import {
  finishReasonOf,
  imagePartsOf,
  promptTextOf,
  readToolCalls,
  systemMessages,
  toolFields,
  turnMessages,
  usageOf
} from "./conversation";
import { resolveModelId } from "./models";
import type { LlmPrice } from "./prices";
import { llmPriceOf } from "./prices";
import { actualUsd, reportedTokens } from "./tokens";

/**
 * Chat path under `config.runUrl`.
 *
 * @example
 * ```ts
 * `${"https://fal.run"}/${CHAT_PATH}`; // => "https://fal.run/openrouter/router/openai/v1/chat/completions"
 * ```
 */
export const CHAT_PATH = "openrouter/router/openai/v1/chat/completions";

/**
 * `max_tokens` when `params.max_tokens` is not a positive integer.
 *
 * @example
 * ```ts
 * DEFAULT_MAX_TOKENS; // => 32000
 * ```
 */
export const DEFAULT_MAX_TOKENS = 32_000;

/**
 * First retry backoff, ms; it doubles per attempt.
 *
 * @example
 * ```ts
 * RETRY_BASE_MS * 2 ** (2 - 1); // => 2000, the wait before the third attempt
 * ```
 */
export const RETRY_BASE_MS = 1000;

/**
 * How hard the model thinks: `off` sends no `reasoning` field.
 *
 * @example
 * ```ts
 * const level: ReasoningLevel = "high";
 * ```
 */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

/**
 * A JSON schema for a structured answer: open JSON by nature, passed to fal as is.
 *
 * @example
 * ```ts
 * const schema: JsonSchema = { type: "object", properties: { n: { type: "number" } } };
 * ```
 */
export type JsonSchema = Record<string, unknown>;

/**
 * The structured-answer request.
 *
 * @example
 * ```ts
 * const format: ResponseFormat = { type: "json_schema", json_schema: { name: "answer", schema: {}, strict: false } };
 * ```
 */
export type ResponseFormat = {
  /** Always a JSON schema answer. */
  type: "json_schema";
  /** The schema and whether fal enforces it strictly. */
  json_schema: { name: string; schema: JsonSchema; strict: boolean };
};

/**
 * The posted chat completions body, fields in wire order.
 *
 * @example
 * ```ts
 * const body: ChatBody = { model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 32_000 };
 * ```
 */
export type ChatBody = {
  /** OpenRouter model id. */
  model: string;
  /** System message (when set), then the user message or the turns. */
  messages: WireMessage[];
  /** Output token cap. */
  max_tokens: number;
  /** Sampling temperature, 0..2; omitted when unset. */
  temperature?: number;
  /** Reasoning effort; omitted for `off`. */
  reasoning?: { effort: Exclude<ReasoningLevel, "off"> };
  /** Structured-answer request; omitted without a schema. */
  response_format?: ResponseFormat;
  /** Tools the model may call; omitted without tools. */
  tools?: WireTool[];
  /** Whether and which tool the model must call; omitted when unset. */
  tool_choice?: WireToolChoice;
};

/**
 * Everything checked before any I/O.
 *
 * @example
 * ```ts
 * planChat(ctx, { prompt: "hi" }).maxTokens; // => 32000
 * ```
 */
export type ChatPlan = {
  /** OpenRouter model id. */
  modelId: string;
  /** The model's price. */
  price: LlmPrice;
  /** Output token cap. */
  maxTokens: number;
  /** Reasoning level. */
  reasoning: ReasoningLevel;
  /** Images to upload, in order. */
  images: LocalFile[];
  /** The body without images (they are added after the upload). */
  body: ChatBody;
};

/**
 * What one chat answer carries.
 */
type ChatAnswer = {
  /** fal's generation id, when present. */
  id: string | undefined;
  /** The answer text (`""` when only tool calls, or cut by length before any content). */
  text: string;
  /** The tool calls of the answer's message; `[]` when none. */
  toolCalls: ToolCall[];
  /** `choices[0].finish_reason`. */
  finishReason: string | undefined;
  /** The upstream provider OpenRouter picked. */
  provider: string | undefined;
  /** The untrusted `usage` object. */
  usage: unknown;
};

/** Attempts of one chat request, the first included. */
const MAX_ATTEMPTS = 3;

/** Reasoning level when `params.reasoning` is not set. */
const DEFAULT_REASONING: ReasoningLevel = "medium";

/** Reasoning levels fal accepts. */
const REASONING_LEVELS: ReadonlySet<string> = new Set(["off", "low", "medium", "high"]);

/** Temperature range fal accepts. */
const TEMPERATURE = { min: 0, max: 2 };

/** Name of the structured answer's schema. */
const SCHEMA_NAME = "answer";

/** `finish_reason` of an answer cut by `max_tokens`. */
const CUT_BY_LENGTH = "length";

/** `finish_reason`s whose answer may have no content: a tool-call turn, or cut by length. */
const EMPTY_CONTENT_REASONS: ReadonlySet<string> = new Set(["tool_calls", CUT_BY_LENGTH]);

/** Marker of a content-policy error in fal's text. */
const CONTENT_POLICY = "content_policy";

/** Longest slice of fal's error text copied into a message. */
const MAX_ERROR_TEXT = 300;

/** Status of a request refused before any charge, or an error answer. */
const BAD_REQUEST = 400;

/** HTTP statuses that mean the key was refused. */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** HTTP statuses that mean a plan or rate limit. */
const LIMIT_STATUSES: ReadonlySet<number> = new Set([402, 429]);

/** Lowest HTTP status of a server error (5xx): retried. */
const MIN_SERVER_ERROR = 500;

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
 * The reasoning level of `params.reasoning`.
 *
 * @param value - `params.reasoning`, untrusted.
 * @returns The level; medium when unset.
 * @throws {TerminalProviderError} A 400 for any other value.
 * @example
 * ```ts
 * reasoningOf("off"); // => "off"
 * ```
 */
function reasoningOf(value: unknown): ReasoningLevel {
  if (value === undefined) return DEFAULT_REASONING;
  if (isReasoningLevel(value)) return value;
  throw badRequest(
    '[ai] fal params.reasoning must be "off", "low", "medium" or "high".\n  Pass one of the four levels.'
  );
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
 * The structured-answer request of `params.responseSchema`.
 *
 * @param params - Request params.
 * @returns The `response_format` field, or nothing without a schema.
 * @throws {TerminalProviderError} A 400 when the schema is not a plain object.
 * @example
 * ```ts
 * responseFormatField({ responseSchema: { type: "object" }, strictSchema: true }); // => { response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" }, strict: true } } }
 * ```
 */
function responseFormatField(params: Record<string, unknown> | undefined): {
  response_format?: ResponseFormat;
} {
  const schema = params?.responseSchema;
  if (schema === undefined) return {};
  if (!isPlainObject(schema)) {
    throw badRequest(
      "[ai] fal params.responseSchema must be a JSON schema object.\n  Pass the schema as a plain object."
    );
  }
  const strict = params?.strictSchema === true;
  return {
    response_format: { type: "json_schema", json_schema: { name: SCHEMA_NAME, schema, strict } }
  };
}

/**
 * The images of `params.images`: one file or a list.
 *
 * @param value - `params.images`, untrusted.
 * @returns Local files, in order.
 * @throws {TerminalProviderError} A 400 when an image is not `{ path, mimeType, hash }`.
 * @example
 * ```ts
 * imagesOf({ path: "a.png", mimeType: "image/png", hash: "h" }).length; // => 1
 * ```
 */
function imagesOf(value: unknown): LocalFile[] {
  if (value === undefined) return [];

  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items.map(item => {
    const path = readString(item, "path");
    const mimeType = readString(item, "mimeType");
    const hash = readString(item, "hash");
    if (path === undefined || mimeType === undefined || hash === undefined) {
      throw badRequest(
        "[ai] fal params.images must be local files.\n  Pass { path, mimeType, hash } for every image."
      );
    }
    return { path, mimeType, hash };
  });
}

/**
 * The images to upload: `params.images` without messages; with messages,
 * every image part in message order (one upload per part), and
 * `params.images` is refused.
 *
 * @param request - The prompt-gen request.
 * @returns Local files, in the order their URLs go into the body.
 * @throws {TerminalProviderError} A 400 for `params.images` with messages, or an image that is not `{ path, mimeType, hash }`.
 * @example
 * ```ts
 * requestImages({ prompt: "", messages: [{ role: "user", content: [{ type: "image", path: "a.png", mimeType: "image/png", hash: "h" }] }] }).length; // => 1
 * ```
 */
function requestImages(request: PromptGenRequest): LocalFile[] {
  const images = request.params?.images;
  if (request.messages === undefined) return imagesOf(images);

  if (images !== undefined) {
    throw badRequest(
      "[ai] fal prompt-gen takes no params.images with messages.\n  Put images in message content parts."
    );
  }
  return imagesOf(imagePartsOf(request.messages));
}

/**
 * The output token cap: `params.max_tokens` when a positive integer.
 *
 * @param value - `params.max_tokens`, untrusted.
 * @returns The cap.
 * @example
 * ```ts
 * maxTokensOf(1.5); // => 32000
 * ```
 */
function maxTokensOf(value: unknown): number {
  const isPositiveInteger = typeof value === "number" && Number.isInteger(value) && value > 0;
  return isPositiveInteger ? value : DEFAULT_MAX_TOKENS;
}

/**
 * The temperature field: clamped to 0..2, omitted when unset.
 *
 * @param temperature - `request.temperature`.
 * @returns The field, or nothing.
 * @example
 * ```ts
 * temperatureField(3); // => { temperature: 2 }
 * ```
 */
function temperatureField(temperature: number | undefined): { temperature?: number } {
  if (temperature === undefined) return {};
  return { temperature: Math.min(Math.max(temperature, TEMPERATURE.min), TEMPERATURE.max) };
}

/**
 * The chat messages: the system message when set (one cached part with
 * `cacheSystem`), then the turns when `messages` is set, else the prompt;
 * with images the prompt's user content is the text part followed by one
 * part per image.
 *
 * @param request - The prompt-gen request.
 * @param imageUrls - Uploaded image URLs, in order.
 * @returns The messages.
 * @example
 * ```ts
 * chatMessages({ prompt: "hi", system: "be brief" }, []); // => [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]
 * ```
 */
export function chatMessages(
  request: Pick<PromptGenRequest, "prompt" | "system" | "messages" | "cacheSystem">,
  imageUrls: readonly string[]
): WireMessage[] {
  const system = systemMessages(request.system, request.cacheSystem === true);
  if (request.messages !== undefined) {
    return [...system, ...turnMessages(request.messages, imageUrls)];
  }
  if (imageUrls.length === 0) return [...system, { role: "user", content: request.prompt }];

  const images: WirePart[] = imageUrls.map(url => ({ type: "image_url", image_url: { url } }));
  const text: WirePart = { type: "text", text: request.prompt };
  return [...system, { role: "user", content: [text, ...images] }];
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
      "[ai] fal prompt-gen messages must not be empty.\n  Pass at least one user message."
    );
  }

  const hasPrompt = typeof request.prompt === "string" && request.prompt.trim() !== "";
  if (hasPrompt) return;
  throw badRequest(
    "[ai] fal prompt-gen needs a non-empty prompt.\n  Pass the text to generate from in request.prompt."
  );
}

/**
 * Plans a chat request without I/O: prompt or messages, model (default
 * `config.llmDefaultModel`), price, reasoning, schema, images, max tokens,
 * temperature, tools and tool choice. No other param is copied.
 *
 * @param ctx - Plugin context (config, price table).
 * @param request - The prompt-gen request.
 * @returns The plan, with the body before any image upload.
 * @throws {TerminalProviderError} A 400 for an empty prompt or messages, a bad param or image, or a model without a price.
 */
export function planChat(ctx: FalContext, request: PromptGenRequest): ChatPlan {
  assertHasInput(request);

  // Model and price first: a model without a price never runs.
  const modelId = resolveModelId(request.model, ctx.config.llmDefaultModel);
  const price = llmPriceOf(resolvePrices(ctx), modelId);

  // The params this handler reads; every other param is ignored.
  const { params } = request;
  const reasoning = reasoningOf(params?.reasoning);
  const maxTokens = maxTokensOf(params?.max_tokens);
  const images = requestImages(request);
  const body: ChatBody = {
    model: modelId,
    messages: chatMessages(request, []),
    max_tokens: maxTokens,
    ...temperatureField(request.temperature),
    ...(reasoning === "off" ? {} : { reasoning: { effort: reasoning } }),
    ...responseFormatField(params),
    ...toolFields(request)
  };
  return { modelId, price, maxTokens, reasoning, images, body };
}

/**
 * fal's error text of a 2xx answer, when it carries one.
 *
 * @param body - The parsed answer.
 * @returns The text, or undefined.
 * @example
 * ```ts
 * errorTextOf({ error: { message: "bad model" } }); // => "bad model"
 * ```
 */
function errorTextOf(body: unknown): string | undefined {
  const text = readString(readField(body, "error"), "message");
  return text === undefined || text === "" ? undefined : text;
}

/**
 * The error a 2xx error answer becomes: content policy is flagged, anything
 * else a terminal 400 with fal's text cut to 300 characters.
 *
 * @param text - fal's error text.
 * @returns The error to throw.
 * @example
 * ```ts
 * answerFailure("bad model").message; // => "[ai] fal LLM returned an error: bad model"
 * ```
 */
function answerFailure(text: string): Error {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  const cut = flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT)}...` : flat;
  if (flat.includes(CONTENT_POLICY)) {
    return new FlaggedProviderError(`[ai] fal flagged the LLM request (content policy): ${cut}`);
  }
  return new TerminalProviderError(`[ai] fal LLM returned an error: ${cut}`, BAD_REQUEST);
}

/**
 * Reads a chat answer: the text of `choices[0].message.content` and its tool
 * calls. A null or missing content is `""` when the answer has tool calls or
 * ended by `tool_calls` or `length`.
 *
 * @param body - The parsed 2xx answer.
 * @returns The answer.
 * @throws {Error} Flagged or terminal for an error answer; `ToolArgumentsError` for tool arguments that are not JSON; a plain error for an incomplete one.
 * @example
 * ```ts
 * readAnswer({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }).text; // => "hi"
 * ```
 */
export function readAnswer(body: unknown): ChatAnswer {
  // An error answer can come with a 2xx status: it fails the request before anything is read.
  const error = errorTextOf(body);
  if (error !== undefined) throw answerFailure(error);

  // The first choice carries the text and the tool calls; id, provider and usage come along.
  const choices = readField(body, "choices");
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = readField(choice, "message");
  const content = readField(message, "content");
  const finishReason = readString(choice, "finish_reason");
  const answer = {
    id: readString(body, "id"),
    finishReason,
    provider: readString(body, "provider"),
    usage: readField(body, "usage"),
    toolCalls: readToolCalls(readField(message, "tool_calls"))
  };

  // Text wins; no content is empty for a tool-call turn or a length cut; anything else is incomplete.
  if (typeof content === "string") return { ...answer, text: content };
  const hasNoContent = content === null || content === undefined;
  const mayBeEmpty =
    answer.toolCalls.length > 0 ||
    (finishReason !== undefined && EMPTY_CONTENT_REASONS.has(finishReason));
  if (hasNoContent && mayBeEmpty) return { ...answer, text: "" };
  throw new Error(
    "[ai] fal returned an incomplete LLM result.\n  Expected choices[0].message.content in the response."
  );
}

/**
 * The unavailable error for a refused or limited request, checked on the
 * classified HTTP error before any retry decision; undefined otherwise.
 *
 * @param ctx - Plugin context (`config.apiKeyEnv`).
 * @param error - What the POST threw.
 * @returns The error to throw instead, or undefined.
 */
function unavailableError(ctx: FalContext, error: unknown): PromptGenUnavailableError | undefined {
  const hasStatus =
    error instanceof TerminalProviderError || error instanceof RetryableProviderError;
  const status = hasStatus ? error.status : undefined;
  if (status === undefined) return undefined;

  if (AUTH_STATUSES.has(status)) {
    return new PromptGenUnavailableError(
      `[ai] fal refused the LLM request (HTTP ${status}).\n  Check ${ctx.config.apiKeyEnv}, or use another prompt-gen provider.`,
      "auth"
    );
  }
  if (LIMIT_STATUSES.has(status)) {
    return new PromptGenUnavailableError(
      `[ai] fal limited the LLM request (HTTP ${status}).\n  Wait, or use another prompt-gen provider.`,
      "limit"
    );
  }
  return undefined;
}

/**
 * Whether the chat retries a failure: a retryable 5xx or request timeout.
 * A 429 never gets here (it is unavailable); a network failure is not retried.
 *
 * @param error - What the POST threw.
 * @returns True for a 5xx or a timeout.
 * @example
 * ```ts
 * isRetried(new RetryableProviderError("[ai] fal returned HTTP 502.", { status: 502 })); // => true
 * ```
 */
function isRetried(error: unknown): error is RetryableProviderError {
  if (!(error instanceof RetryableProviderError)) return false;
  return (error.status ?? 0) >= MIN_SERVER_ERROR || error.kind === "timeout";
}

/**
 * Backoff before the next attempt: `RETRY_BASE_MS × 2^(attempt−1)`, or a
 * longer `Retry-After`.
 *
 * @param attempt - The attempt that failed, from 1.
 * @param retryAfterMs - fal's Retry-After, if any.
 * @returns Milliseconds to wait.
 * @example
 * ```ts
 * backoffMs(2, 3000); // => 3000
 * ```
 */
function backoffMs(attempt: number, retryAfterMs: number | undefined): number {
  const exponential = RETRY_BASE_MS * 2 ** (attempt - 1);
  return retryAfterMs !== undefined && retryAfterMs > exponential ? retryAfterMs : exponential;
}

/**
 * One chat POST: the posted body, fal's answer, one request log line.
 */
type ChatSend = {
  /** Posts once and reads the answer. */
  post: () => Promise<ChatAnswer>;
  /** The model id, for the retry log. */
  modelId: string;
  /** Caller abort signal; ends a backoff. */
  signal: AbortSignal | undefined;
};

/**
 * Posts with the private retry: at most {@link MAX_ATTEMPTS} attempts, only
 * a 5xx or a timeout retried, each retry logged `fal:llm:retry`. A refused or
 * limited request throws `PromptGenUnavailableError` at once.
 *
 * @param ctx - Plugin context (log, `config.apiKeyEnv`).
 * @param send - The POST, model id and signal.
 * @param attempt - This attempt, from 1.
 * @returns The answer.
 * @throws {Error} The unavailable error, the last retryable error, any other error, or the abort reason.
 */
async function postWithRetry(ctx: FalContext, send: ChatSend, attempt = 1): Promise<ChatAnswer> {
  try {
    return await send.post();
  } catch (error) {
    const unavailable = unavailableError(ctx, error);
    if (unavailable !== undefined) throw unavailable;
    if (!isRetried(error) || attempt >= MAX_ATTEMPTS) throw error;

    ctx.log.warn("fal:llm:retry", { model: send.modelId, attempt, ...redacted(error) });
    await sleep(backoffMs(attempt, error.retryAfterMs), send.signal);
    return postWithRetry(ctx, send, attempt + 1);
  }
}

/**
 * The prompt-gen result: text, tool calls, finish reason, actual cost, typed
 * usage and metadata. A length-cut answer is `partial` and logged
 * `fal:llm:partial`; every answer logs `fal:llm:done`.
 *
 * @param ctx - Plugin context (log).
 * @param request - The prompt-gen request.
 * @param plan - The plan.
 * @param answer - The answer.
 * @returns The result.
 */
function chatResult(
  ctx: FalContext,
  request: PromptGenRequest,
  plan: ChatPlan,
  answer: ChatAnswer
): PromptGenResult {
  const partial = answer.finishReason === CUT_BY_LENGTH;
  if (partial) ctx.log.warn("fal:llm:partial", { model: plan.modelId });

  const cost = actualUsd({ usage: answer.usage, text: answer.text }, plan.price, request);
  const { promptTokens, completionTokens } = reportedTokens(answer.usage);
  ctx.log.info("fal:llm:done", {
    model: plan.modelId,
    promptTokens,
    completionTokens,
    costSource: cost.source
  });

  const meta = {
    modelId: plan.modelId,
    reasoning: plan.reasoning,
    provider: answer.provider,
    finishReason: answer.finishReason,
    promptTokens,
    completionTokens,
    costSource: cost.source,
    partial
  };
  return {
    text: answer.text,
    costUsd: cost.usd,
    toolCalls: answer.toolCalls,
    finishReason: finishReasonOf(answer.finishReason),
    usage: usageOf(answer.usage),
    meta
  };
}

/**
 * Runs one chat request: plan, key, image upload, POST with the private
 * retry (one request log line per attempt), result.
 *
 * @param ctx - Plugin context.
 * @param requestLog - The request log, or undefined when off.
 * @param request - The prompt-gen request.
 * @param signal - Caller abort signal (uploads, POST and backoff).
 * @returns The result.
 * @throws {Error} A plan error, the missing key, `PromptGenUnavailableError`, or the POST's classified error.
 */
export async function runChat(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  request: PromptGenRequest,
  signal: AbortSignal | undefined
): Promise<PromptGenResult> {
  // Refuse a bad request and read the key before any upload.
  const plan = planChat(ctx, request);
  const apiKey = resolveApiKey(ctx);
  const call: FalCall = { apiKey, timeoutMs: ctx.config.timeoutMs, signal };

  // Images go through the shared upload, then into the user message or their message parts.
  const imageUrls = await uploadFiles(ctx, plan.images, { apiKey, signal });
  const body: ChatBody = { ...plan.body, messages: chatMessages(request, imageUrls) };
  const entry = {
    task: "prompt-gen" as const,
    model: plan.modelId,
    endpoint: CHAT_PATH,
    prompt: promptTextOf(request),
    body,
    files: plan.images
  };

  // Each attempt is one POST and one request log line.
  const post = async (): Promise<ChatAnswer> => {
    const response = await falFetch({
      url: `${ctx.config.runUrl}/${CHAT_PATH}`,
      method: "POST",
      json: body,
      ...call
    });
    return readAnswer(parseJson(response, "chat answer"));
  };
  const answer = await postWithRetry(ctx, {
    post: () => withRequestLog(requestLog, entry, post, sent => sent.id ?? ""),
    modelId: plan.modelId,
    signal
  });
  return chatResult(ctx, request, plan, answer);
}
