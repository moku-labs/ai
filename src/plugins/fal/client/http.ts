/**
 * @file fal thin fetch client (global fetch — Node >= 24 and Bun). One
 * `falFetch` helper performs every HTTP call of this plugin (queue submit,
 * status, result, storage upload, CDN download, chat POST) and owns the one
 * place that classifies transport and HTTP failures into the plugin's
 * `RetryableProviderError` / `TerminalProviderError` / `FlaggedProviderError`
 * taxonomy. It also narrows fal's untrusted JSON bodies, reads the key through
 * `ctx.env` (MC3) and redacts errors for the logs. Shared by every task.
 */
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../errors";
import type { FalContext, FalProviderError } from "../types";

/**
 * HTTP method used against fal.
 *
 * @example
 * ```ts
 * const method: FalMethod = "PUT"; // the presigned storage upload
 * ```
 */
export type FalMethod = "GET" | "POST" | "PUT";

/**
 * One fal HTTP request. `apiKey` adds `Authorization: Key <key>`; `json`
 * sends a JSON body; `bytes` + `contentType` send a raw body.
 *
 * @example
 * ```ts
 * const request: FalRequest = { url: "https://queue.fal.run/fal-ai/nano-banana-pro", method: "POST", apiKey: "fal-key", json: { prompt: "hero" }, timeoutMs: 60_000 };
 * ```
 */
export type FalRequest = {
  /** Absolute URL, used verbatim. */
  url: string;
  /** HTTP method. */
  method: FalMethod;
  /** fal key; omitted for presigned uploads and CDN downloads. Never logged. */
  apiKey?: string | undefined;
  /** JSON body (the fal payload, open by contract because `params` is pass-through). */
  json?: Record<string, unknown> | undefined;
  /** Raw body bytes. */
  bytes?: Uint8Array | undefined;
  /** Content type of `bytes`. */
  contentType?: string | undefined;
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Caller abort signal; an abort is rethrown unchanged (clean pause). */
  signal?: AbortSignal | undefined;
};

/**
 * A successful (2xx) fal response with its body fully read.
 *
 * @example
 * ```ts
 * const response: FalResponse = { status: 200, headers: new Headers({ "content-type": "application/json" }), body: new TextEncoder().encode("{}") };
 * ```
 */
export type FalResponse = {
  /** HTTP status. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Body bytes. */
  body: Uint8Array;
};

/**
 * What fal said about a failure, narrowed from its JSON body: the error
 * types it named and its human-readable text.
 *
 * @example
 * ```ts
 * const info: FalErrorInfo = { types: ["content_policy_violation"], text: "NSFW content detected" };
 * ```
 */
export type FalErrorInfo = {
  /** `error_type` and `detail[].type` values, in that order. */
  types: string[];
  /** `error` / `detail` text, when present. */
  text: string | undefined;
};

/** Longest slice of fal's error text copied into an error message. */
const MAX_ERROR_TEXT = 300;

/** HTTP status of a rate-limited request: retryable, with an optional `Retry-After`. */
const TOO_MANY_REQUESTS = 429;

/** Lowest HTTP status of a server error (5xx): retryable. */
const MIN_SERVER_ERROR = 500;

/** Milliseconds per second, for a `Retry-After` given in seconds. */
const MS_PER_SECOND = 1000;

/** Marker fal uses in error types and texts for a content-policy rejection. */
const CONTENT_POLICY = "content_policy";

/**
 * Words in fal's text that name a content-policy rejection even without the
 * `content_policy` marker. Case-insensitive.
 */
const CONTENT_POLICY_WORDS = /sensitive|likeness|nsfw|moderation/i;

/** Job `error_type`s that are transient: the next attempt re-submits. */
const TRANSIENT_JOB_ERRORS: ReadonlySet<string> = new Set([
  "generation_timeout",
  "downstream_service_unavailable",
  "internal_server_error"
]);

/**
 * Reads a string property off an untrusted JSON value.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The string, or undefined when absent or not a string.
 * @example
 * ```ts
 * readString({ request_id: "r1" }, "request_id"); // => "r1"
 * ```
 */
export function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

/**
 * Reads a finite number property off an untrusted JSON value.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The number, or undefined when absent, not a number, or not finite.
 * @example
 * ```ts
 * readNumber({ width: 1152, height: "2048" }, "width"); // => 1152
 * ```
 */
export function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/**
 * Reads a property off an untrusted JSON value, still untrusted.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The property value, or undefined.
 * @example
 * ```ts
 * readField({ video: { url: "u" } }, "video"); // => { url: "u" }
 * ```
 */
export function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

/**
 * Collapses whitespace and cuts fal's text to {@link MAX_ERROR_TEXT} characters.
 *
 * @param text - fal's error text.
 * @returns The shortened text.
 * @example
 * ```ts
 * shorten("a\n  b"); // => "a b"
 * ```
 */
function shorten(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT)}...` : flat;
}

/**
 * Collects `detail[].type` and `detail[].msg` from a FastAPI-style detail list.
 *
 * @param detail - The `detail` array.
 * @param types - Receives the types found.
 * @returns The messages found, joined with "; ", or undefined when none.
 * @example
 * ```ts
 * detailMessages([{ msg: "bad", type: "value_error" }], []); // => "bad"
 * ```
 */
function detailMessages(detail: unknown[], types: string[]): string | undefined {
  const messages: string[] = [];
  for (const item of detail) {
    const type = readString(item, "type");
    const message = readString(item, "msg");
    if (type !== undefined) types.push(type);
    if (message !== undefined) messages.push(message);
  }
  return messages.length > 0 ? messages.join("; ") : undefined;
}

/**
 * Text of a job-level `error` field: a string, or an object's message.
 *
 * @param error - The `error` field.
 * @returns The text, or undefined.
 * @example
 * ```ts
 * errorText({ message: "odd" }); // => "odd"
 * ```
 */
function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  return readString(error, "message") ?? readString(error, "detail");
}

/**
 * Narrows a parsed fal error body (HTTP error or finished job) to the error
 * types and text it carries. Never reads request echoes such as `input`.
 *
 * @param body - Parsed JSON body, or undefined when unreadable.
 * @returns The error types and shortened text.
 * @example
 * ```ts
 * describeFalError({ detail: "Unauthorized" }); // => { types: [], text: "Unauthorized" }
 * ```
 */
export function describeFalError(body: unknown): FalErrorInfo {
  const types: string[] = [];
  const errorType = readString(body, "error_type");
  if (errorType !== undefined) types.push(errorType);

  const detail = readField(body, "detail");
  const detailText = Array.isArray(detail)
    ? detailMessages(detail, types)
    : readString(body, "detail");
  const text = errorText(readField(body, "error")) ?? detailText;

  return { types, text: text === undefined ? undefined : shorten(text) };
}

/**
 * Whether fal named a content-policy rejection: by type, by the
 * `content_policy` marker in its text, or by one of {@link CONTENT_POLICY_WORDS}.
 *
 * @param info - The narrowed error.
 * @returns True for a content-policy rejection.
 * @example
 * ```ts
 * isContentPolicy({ types: ["content_policy_violation"], text: undefined }); // => true
 * isContentPolicy({ types: [], text: "NSFW content detected" }); // => true
 * ```
 */
function isContentPolicy(info: FalErrorInfo): boolean {
  const text = info.text ?? "";
  const namedByType = info.types.some(type => type.includes(CONTENT_POLICY));
  const namedByText = text.includes(CONTENT_POLICY) || CONTENT_POLICY_WORDS.test(text);
  return namedByType || namedByText;
}

/**
 * Formats fal's text as a message suffix.
 *
 * @param text - fal's shortened text, if any.
 * @returns `": <text>"`, or `"."` when there is none.
 * @example
 * ```ts
 * suffixOf("bad duration"); // => ": bad duration"
 * ```
 */
function suffixOf(text: string | undefined): string {
  return text === undefined ? "." : `: ${text}`;
}

/**
 * Reads a `Retry-After` header (seconds or an HTTP date) into milliseconds.
 *
 * @param value - The header value, or null when absent.
 * @returns The delay in ms, or undefined when absent or unreadable.
 * @example
 * ```ts
 * retryAfterMsOf("3"); // => 3000
 * ```
 */
function retryAfterMsOf(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, Math.round(seconds * MS_PER_SECOND));
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/**
 * Parses a body as JSON, tolerating an empty or non-JSON body.
 *
 * @param body - Body bytes.
 * @returns The parsed value, or undefined.
 * @example
 * ```ts
 * tryParseJson(new TextEncoder().encode("{}")); // => {}
 * ```
 */
function tryParseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/**
 * Classifies a non-2xx response: content policy (by type or text) is
 * flagged, 429 and 5xx are retryable, every other status is terminal.
 *
 * @param response - The failed response, body read.
 * @returns The error to throw.
 * @example
 * ```ts
 * classifyHttpFailure({ status: 404, headers: new Headers(), body: new Uint8Array() }).message; // => "[ai] fal rejected the request (HTTP 404)."
 * ```
 */
function classifyHttpFailure(response: FalResponse): Error {
  const { status } = response;
  const info = describeFalError(tryParseJson(response.body));

  if (isContentPolicy(info)) {
    return new FlaggedProviderError(
      `[ai] fal flagged the request (content policy)${suffixOf(info.text)}`
    );
  }
  if (status === TOO_MANY_REQUESTS) {
    return new RetryableProviderError("[ai] fal rate-limited the request (HTTP 429).", {
      status,
      retryAfterMs: retryAfterMsOf(response.headers.get("retry-after"))
    });
  }
  if (status >= MIN_SERVER_ERROR) {
    return new RetryableProviderError(`[ai] fal returned HTTP ${status}.`, { status });
  }
  return new TerminalProviderError(
    `[ai] fal rejected the request (HTTP ${status})${suffixOf(info.text)}`,
    status
  );
}

/**
 * Classifies a fetch or body-read rejection: a caller abort passes through
 * unchanged, our own timeout is retryable `timeout`, anything else is
 * retryable `network`.
 *
 * @param error - What fetch threw.
 * @param caller - The caller's signal, if any.
 * @param timeout - This request's timeout signal.
 * @returns The value to throw.
 * @example
 * ```ts
 * transportFailure(new Error("x"), undefined, AbortSignal.abort()); // => RetryableProviderError "[ai] fal request timed out.", kind "timeout"
 * ```
 */
function transportFailure(
  error: unknown,
  caller: AbortSignal | undefined,
  timeout: AbortSignal
): unknown {
  if (caller?.aborted) return error;
  if (timeout.aborted) {
    return new RetryableProviderError("[ai] fal request timed out.", { kind: "timeout" });
  }
  return new RetryableProviderError("[ai] fal request failed (network).", { kind: "network" });
}

/**
 * Builds the request headers.
 *
 * @param request - The fal request.
 * @returns Header record.
 * @example
 * ```ts
 * headersOf({ url: "https://queue.fal.run", method: "GET", apiKey: "k", timeoutMs: 1 }); // => { Authorization: "Key k" }
 * ```
 */
function headersOf(request: FalRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (request.apiKey !== undefined) headers.Authorization = `Key ${request.apiKey}`;
  if (request.json !== undefined) headers["content-type"] = "application/json";
  if (request.contentType !== undefined) headers["content-type"] = request.contentType;
  return headers;
}

/**
 * Builds the request body.
 *
 * @param request - The fal request.
 * @returns JSON text, raw bytes, or undefined.
 * @example
 * ```ts
 * bodyOf({ url: "https://queue.fal.run", method: "POST", json: { a: 1 }, timeoutMs: 1 }); // => '{"a":1}'
 * ```
 */
function bodyOf(request: FalRequest): string | Uint8Array<ArrayBuffer> | undefined {
  if (request.json !== undefined) return JSON.stringify(request.json);
  if (request.bytes === undefined) return undefined;
  return new Uint8Array(request.bytes);
}

/**
 * Performs one fal HTTP call and reads the whole body. Enforces
 * `timeoutMs` through `AbortSignal.any([caller, AbortSignal.timeout(ms)])`.
 * Error messages start with "[ai] fal" and never contain the key.
 *
 * @param request - URL, method, key, body, timeout and caller signal.
 * @returns The 2xx response with its body bytes.
 * @throws {RetryableProviderError} On 5xx, 429, a timeout, or a network failure.
 * @throws {TerminalProviderError} On any other non-2xx status.
 * @throws {FlaggedProviderError} When fal names a content-policy rejection.
 */
export async function falFetch(request: FalRequest): Promise<FalResponse> {
  // Our timeout, joined with the caller's abort when there is one.
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

  // Fetch and read the whole body; a transport failure is classified here.
  let response: FalResponse;
  try {
    const raw = await fetch(request.url, {
      method: request.method,
      headers: headersOf(request),
      body: bodyOf(request),
      signal
    });
    const body = new Uint8Array(await raw.arrayBuffer());
    response = { status: raw.status, headers: raw.headers, body };
  } catch (error) {
    throw transportFailure(error, request.signal, timeout);
  }

  // Only a 2xx passes; every other status is classified.
  const isSuccess = response.status >= 200 && response.status < 300;
  if (!isSuccess) throw classifyHttpFailure(response);
  return response;
}

/**
 * Parses a successful response's JSON body.
 *
 * @param response - The fal response.
 * @param what - What the body is, for the error message (e.g. "submit response").
 * @returns The parsed, still untrusted value.
 * @throws {Error} A plain (terminal) error when the body is not JSON.
 * @example
 * ```ts
 * parseJson({ status: 200, headers: new Headers(), body: new TextEncoder().encode('{"a":1}') }, "status response"); // => { a: 1 }
 * ```
 */
export function parseJson(response: FalResponse, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    throw new Error(
      `[ai] fal returned an unreadable ${what}.\n  Expected JSON (HTTP ${response.status}).`
    );
  }
}

/**
 * Turns a finished job's `error` into the error `poll` reports: a transient
 * `error_type` is retryable (status 503, the next attempt re-submits), a
 * content-policy type or text is flagged, anything else is terminal (400).
 *
 * @param body - The parsed status body of a COMPLETED job with `error`.
 * @returns The classified error.
 * @example
 * ```ts
 * jobFailure({ status: "COMPLETED", error: "timeout", error_type: "generation_timeout" }); // RetryableProviderError
 * ```
 */
export function jobFailure(body: unknown): FalProviderError {
  const info = describeFalError(body);
  const label = info.types[0] ?? "error";
  const text = info.text ?? label;

  if (info.types.some(type => TRANSIENT_JOB_ERRORS.has(type))) {
    return new RetryableProviderError(`[ai] fal job failed (${label}): ${text}`, { status: 503 });
  }
  if (isContentPolicy(info)) {
    return new FlaggedProviderError(`[ai] fal flagged the job (content policy): ${text}`);
  }
  return new TerminalProviderError(`[ai] fal job failed (${label}): ${text}`, 400);
}

/**
 * Reads the fal key through the injected env API (MC3), at request time.
 *
 * @param ctx - Plugin context (`config.apiKeyEnv`, `env`).
 * @returns The key, or undefined when it is not set or empty.
 */
export function readApiKey(ctx: FalContext): string | undefined {
  const apiKey = ctx.env.get(ctx.config.apiKeyEnv);
  return apiKey === undefined || apiKey === "" ? undefined : apiKey;
}

/**
 * Reads the fal key for a request that needs it (submit, poll, chat POST).
 *
 * @param ctx - Plugin context (`config.apiKeyEnv`, `env`).
 * @returns The key.
 * @throws {Error} A plain (terminal) two-line error when the key is not set.
 */
export function resolveApiKey(ctx: FalContext): string {
  const apiKey = readApiKey(ctx);
  if (apiKey === undefined) {
    throw new Error(
      `[ai] ${ctx.config.apiKeyEnv} is not set.\n  Export it, or set fal.apiKeyEnv to the variable that holds your key.`
    );
  }
  return apiKey;
}

/**
 * Loggable fields of a failure: its class, status and kind only, never the
 * message (it may quote fal's text). An error outside the plugin's taxonomy
 * (an abort, a plain error) is `errorType: "error"`.
 *
 * @param error - Any thrown value.
 * @returns Redacted log fields.
 * @example
 * ```ts
 * redacted(new TerminalProviderError("[ai] fal rejected the request (HTTP 400).", 400)); // => { errorType: "terminal", status: 400 }
 * redacted(new RetryableProviderError("[ai] fal request timed out.", { kind: "timeout" })); // => { errorType: "retryable", status: undefined, kind: "timeout" }
 * redacted(new Error("x")); // => { errorType: "error" }
 * ```
 */
export function redacted(error: unknown): {
  errorType: "retryable" | "terminal" | "flagged" | "error";
  status?: number | undefined;
  kind?: string;
} {
  if (error instanceof FlaggedProviderError) return { errorType: "flagged", kind: error.kind };
  if (error instanceof TerminalProviderError) {
    return { errorType: "terminal", status: error.status };
  }
  if (!(error instanceof RetryableProviderError)) return { errorType: "error" };

  // A retryable error names its kind only when it has one, so HTTP failures log as before.
  if (error.kind === undefined) return { errorType: "retryable", status: error.status };
  return { errorType: "retryable", status: error.status, kind: error.kind };
}
