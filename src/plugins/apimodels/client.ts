/**
 * @file apimodels thin fetch client (global fetch — Node >= 24 and Bun). One
 * `apiFetch` helper performs every HTTP call of this plugin (upload, asset
 * group, asset registration, submit, poll, records, result download) and
 * owns the one place that classifies transport, HTTP and envelope failures
 * into the plugin's `RetryableProviderError` / `TerminalProviderError` /
 * `FlaggedProviderError` taxonomy. `apiData` reads the `{ code, msg, data }`
 * envelope, where a `code` other than 200 is read like the HTTP status.
 */
import {
  AUTH_STATUSES,
  CONTENT_MODERATION,
  MS_PER_SECOND,
  PAYMENT_REQUIRED,
  RATE_LIMITED
} from "./http";
import type { UpstreamFailure } from "./types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./types";
import type { SubmitBody } from "./video/models";

/**
 * HTTP method used against apimodels.
 */
export type ApiMethod = "GET" | "POST";

/**
 * One apimodels HTTP request. `apiKey` adds `Authorization: Bearer <key>`;
 * `json` sends a JSON body; `form` sends a multipart body.
 */
export type ApiRequest = {
  /** Absolute URL, used verbatim. */
  url: string;
  /** HTTP method. */
  method: ApiMethod;
  /** API key; omitted for the result download (a third-party host). Never logged. */
  apiKey?: string | undefined;
  /**
   * JSON body: the video submit body (a closed `SeedanceBody`, open only
   * through the `request.params` merged over it), or a flat text body (asset
   * group, asset registration).
   */
  json?: SubmitBody | Readonly<Record<string, string>> | undefined;
  /** Multipart body (file upload). */
  form?: FormData | undefined;
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Caller abort signal; an abort is rethrown unchanged (clean pause). */
  signal?: AbortSignal | undefined;
  /** True where apimodels answers 422 on moderation (asset registration): a 422 is then flagged. */
  moderated?: boolean | undefined;
  /** Strings cut out of any upstream text copied into an error (the prompt). The key always is. */
  redact?: readonly string[] | undefined;
};

/**
 * A successful (2xx) apimodels response with its body fully read.
 */
export type ApiResponse = {
  /** HTTP status. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Body bytes. */
  body: Uint8Array;
};

/**
 * A failed call, as the classifier sees it: the status (HTTP or envelope
 * `code`), the headers, and what apimodels said.
 */
type Failure = {
  /** HTTP status, or the envelope `code` of an HTTP 200. */
  status: number;
  /** Response headers (for `Retry-After`). */
  headers: Headers;
  /** apimodels' failCode and redacted text. */
  upstream: UpstreamFailure;
};

/** Longest slice of apimodels' text copied into an error message. */
const MAX_ERROR_TEXT = 300;

/** What replaces a redacted string in upstream text. */
const REDACTED = "[redacted]";

/** Status apimodels answers when an asset registration fails moderation or fetching. */
const UNPROCESSABLE = 422;

/** Status carried by an unreadable 2xx body, so the runner classifies it retryable (5xx). */
const UNREADABLE_STATUS = 502;

/** Envelope `code` of a successful call. */
const SUCCESS_CODE = 200;

/** Default wait after a 429 without a readable `Retry-After`, ms. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 1000;

/**
 * Reads a string property off an untrusted JSON value.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The string, or undefined when absent or not a string.
 * @example
 * ```ts
 * readString({ taskId: "t1" }, "taskId"); // => "t1"
 * ```
 */
export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}

/**
 * Reads a property off an untrusted JSON value, still untrusted.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The property value, or undefined.
 * @example
 * ```ts
 * readField({ data: { id: "g1" } }, "data"); // => { id: "g1" }
 * ```
 */
export function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

/**
 * Cuts every non-empty secret out of a text.
 *
 * @param text - Upstream text.
 * @param secrets - Strings that must not appear.
 * @returns The text with each secret replaced by `[redacted]`.
 * @example
 * ```ts
 * redact("bad key k1", ["k1"]); // => "bad key [redacted]"
 * ```
 */
function redact(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret !== "") clean = clean.replaceAll(secret, REDACTED);
  }
  return clean;
}

/**
 * Collapses whitespace, drops trailing periods and cuts the text to
 * {@link MAX_ERROR_TEXT} characters.
 *
 * @param text - apimodels' text, already redacted.
 * @returns The shortened text.
 * @example
 * ```ts
 * shorten("asset  not\nfound."); // => "asset not found"
 * ```
 */
function shorten(text: string): string {
  let flat = text.replaceAll(/\s+/g, " ").trim();
  while (flat.endsWith(".")) flat = flat.slice(0, -1);
  return flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT)}...` : flat;
}

/**
 * Whether a text is absent or holds only whitespace. False narrows it to a
 * string.
 *
 * @param text - A text, if any.
 * @returns True for undefined, null, `""` or whitespace only.
 * @example
 * ```ts
 * isBlank(" \n"); // => true
 * ```
 */
function isBlank(text: string | null | undefined): text is "" | null | undefined {
  return (text ?? "").trim() === "";
}

/**
 * Whether a string is absent or empty. Unlike a blank text, whitespace counts
 * as content here: an API key or a task id is used as it came.
 *
 * @param value - A string, if any.
 * @returns True for undefined or `""`.
 * @example
 * ```ts
 * isEmpty(""); // => true
 * ```
 */
export function isEmpty(value: string | undefined): value is "" | undefined {
  return value === undefined || value === "";
}

/**
 * Cleans upstream text for an error message: redacted, then shortened.
 *
 * @param text - apimodels' text, if any.
 * @param secrets - Strings that must not appear (key, prompt).
 * @returns The clean text, or undefined when there is none.
 * @example
 * ```ts
 * cleanText("key k1 is bad.", ["k1"]); // => "key [redacted] is bad"
 * ```
 */
export function cleanText(
  text: string | undefined,
  secrets: readonly string[]
): string | undefined {
  if (isBlank(text)) return undefined;
  return shorten(redact(text, secrets));
}

/**
 * Formats apimodels' text as a message suffix.
 *
 * @param text - Clean text, if any.
 * @returns `": <text>"`, or `""` when there is none.
 * @example
 * ```ts
 * suffixOf("bad duration"); // => ": bad duration"
 * ```
 */
export function suffixOf(text: string | undefined): string {
  return text === undefined ? "" : `: ${text}`;
}

/**
 * Narrows an error envelope to its failCode and text: `data.failCode` or
 * `failCode`, then `data.failMsg`, `msg`, `message` or `error`.
 *
 * @param body - Parsed body, or undefined when unreadable.
 * @param secrets - Strings that must not appear in the text.
 * @returns The failCode and the clean text.
 * @example
 * ```ts
 * describeFailure({ code: 400, msg: "bad", data: { failCode: "INVALID_INPUT" } }, []); // => { failCode: "INVALID_INPUT", detail: "bad" }
 * ```
 */
function describeFailure(body: unknown, secrets: readonly string[]): UpstreamFailure {
  const data = readField(body, "data");
  const failCode = readString(data, "failCode") ?? readString(body, "failCode");
  const text =
    readString(data, "failMsg") ??
    readString(body, "msg") ??
    readString(body, "message") ??
    readString(body, "error");
  return { failCode, detail: cleanText(text, secrets) };
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
  if (isBlank(value)) return undefined;
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
 * Classifies a 4xx that is not a rate limit: a bad key, a low balance, a
 * moderated 422, or any other rejection.
 *
 * @param failure - The failed call.
 * @param request - The request (key presence, moderated flag).
 * @returns The terminal or flagged error.
 * @example
 * ```ts
 * rejectionError({ status: 402, headers: new Headers(), upstream: {} }, { url: "u", method: "POST", timeoutMs: 1 }).message; // => "[ai] apimodels balance is too low (HTTP 402).\n  Top up the apimodels account, then run again."
 * ```
 */
function rejectionError(failure: Failure, request: ApiRequest): Error {
  const { status, upstream } = failure;
  const suffix = suffixOf(upstream.detail);

  if (status === UNPROCESSABLE && request.moderated === true) {
    return new FlaggedProviderError(
      `[ai] apimodels flagged the asset (HTTP 422)${suffix}.\n  Use another image, or remove it from params.assets; nothing was charged.`
    );
  }
  if (AUTH_STATUSES.has(status) && request.apiKey !== undefined) {
    return new TerminalProviderError(
      `[ai] apimodels rejected the API key (HTTP ${status}).\n  Check APIMODELS_API_KEY, or the env var named by apimodels.apiKeyEnv.`,
      status,
      upstream
    );
  }
  if (status === PAYMENT_REQUIRED) {
    return new TerminalProviderError(
      "[ai] apimodels balance is too low (HTTP 402).\n  Top up the apimodels account, then run again.",
      status,
      upstream
    );
  }
  return new TerminalProviderError(
    `[ai] apimodels rejected the request (HTTP ${status})${suffix}.\n  Check the request fields against the apimodels docs.`,
    status,
    upstream
  );
}

/**
 * Classifies a failed call: a content-moderation failCode is flagged, 429
 * and 5xx are retryable, every other status goes to {@link rejectionError}.
 *
 * @param failure - The failed call (HTTP status or envelope code).
 * @param request - The request.
 * @returns The error to throw.
 * @example
 * ```ts
 * classifyFailure({ status: 503, headers: new Headers(), upstream: {} }, { url: "u", method: "GET", timeoutMs: 1 }).message; // => "[ai] apimodels returned HTTP 503.\n  The runner retries it."
 * ```
 */
function classifyFailure(failure: Failure, request: ApiRequest): Error {
  const { status, upstream } = failure;

  if (upstream.failCode === CONTENT_MODERATION) {
    return new FlaggedProviderError(
      `[ai] apimodels flagged the request (content moderation)${suffixOf(upstream.detail)}.\n  Change the prompt or the inputs.`
    );
  }
  if (status === RATE_LIMITED) {
    return new RetryableProviderError(
      "[ai] apimodels rate-limited the request (HTTP 429).\n  The runner retries after Retry-After.",
      { status, retryAfterMs: retryAfterMsOf(failure.headers.get("retry-after")) }
    );
  }
  if (status >= 500) {
    return new RetryableProviderError(
      `[ai] apimodels returned HTTP ${status}.\n  The runner retries it.`,
      { status }
    );
  }
  return rejectionError(failure, request);
}

/**
 * Classifies a fetch or body-read rejection: a caller abort passes through
 * unchanged, our own timeout is retryable `timeout`, anything else (a fetch
 * `TypeError`) is retryable `network`.
 *
 * @param error - What fetch threw.
 * @param caller - The caller's signal, if any.
 * @param timeout - This request's timeout signal.
 * @returns The value to throw.
 * @example
 * ```ts
 * transportFailure(new TypeError("fetch failed"), undefined, new AbortController().signal); // => RetryableProviderError, kind "network"
 * ```
 */
function transportFailure(
  error: unknown,
  caller: AbortSignal | undefined,
  timeout: AbortSignal
): unknown {
  if (caller?.aborted) return error;
  if (timeout.aborted) {
    return new RetryableProviderError(
      "[ai] apimodels request timed out.\n  The runner retries it; raise apimodels.timeoutMs for large files.",
      { kind: "timeout" }
    );
  }
  return new RetryableProviderError(
    "[ai] apimodels request failed (network).\n  The runner retries it.",
    { kind: "network" }
  );
}

/**
 * Builds the request headers. A multipart body gets no content type: fetch
 * sets it with the boundary.
 *
 * @param request - The apimodels request.
 * @returns Header record.
 * @example
 * ```ts
 * headersOf({ url: "u", method: "GET", apiKey: "k", timeoutMs: 1 }); // => { Authorization: "Bearer k" }
 * ```
 */
function headersOf(request: ApiRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (request.apiKey !== undefined) headers.Authorization = `Bearer ${request.apiKey}`;
  if (request.json !== undefined) headers["content-type"] = "application/json";
  return headers;
}

/**
 * Builds the request body.
 *
 * @param request - The apimodels request.
 * @returns JSON text, form data, or undefined.
 * @example
 * ```ts
 * bodyOf({ url: "u", method: "POST", json: { a: 1 }, timeoutMs: 1 }); // => '{"a":1}'
 * ```
 */
function bodyOf(request: ApiRequest): string | FormData | undefined {
  if (request.json !== undefined) return JSON.stringify(request.json);
  return request.form;
}

/**
 * The strings no error of this request may contain: the key, and whatever
 * the caller asked to redact.
 *
 * @param request - The apimodels request.
 * @returns The secrets.
 * @example
 * ```ts
 * secretsOf({ url: "u", method: "GET", apiKey: "k", redact: ["p"], timeoutMs: 1 }); // => ["k", "p"]
 * ```
 */
function secretsOf(request: ApiRequest): string[] {
  return [...(request.apiKey === undefined ? [] : [request.apiKey]), ...(request.redact ?? [])];
}

/**
 * Performs one apimodels HTTP call and reads the whole body. Enforces
 * `timeoutMs` through `AbortSignal.any([caller, AbortSignal.timeout(ms)])`.
 * Error messages start with "[ai] apimodels" and never contain the key or
 * a redacted string.
 *
 * @param request - URL, method, key, body, timeout and caller signal.
 * @returns The 2xx response with its body bytes.
 * @throws {RetryableProviderError} On 5xx, 429, a timeout, or a network failure.
 * @throws {TerminalProviderError} On any other non-2xx status.
 * @throws {FlaggedProviderError} On a moderated 422 or a CONTENT_MODERATION failCode.
 */
export async function apiFetch(request: ApiRequest): Promise<ApiResponse> {
  // Our timeout, joined with the caller's abort when there is one.
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

  // Fetch and read the whole body; a transport failure is classified here.
  let response: ApiResponse;
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
  if (isSuccess) return response;
  const upstream = describeFailure(tryParseJson(response.body), secretsOf(request));
  throw classifyFailure({ status: response.status, headers: response.headers, upstream }, request);
}

/**
 * Reads the envelope `code` as a status number.
 *
 * @param body - The parsed envelope.
 * @returns The code, or undefined when absent or not numeric.
 * @example
 * ```ts
 * envelopeCode({ code: "429" }); // => 429
 * ```
 */
function envelopeCode(body: unknown): number | undefined {
  const code = readField(body, "code");
  const value = typeof code === "string" ? Number(code) : code;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Performs one JSON call and returns the envelope's `data`. A `code` other
 * than 200 on a 2xx response is classified like the HTTP status.
 *
 * @param request - The apimodels request.
 * @param what - What the body is, for the error message (e.g. "submit response").
 * @returns The envelope's `data`, still untrusted.
 * @throws {RetryableProviderError} When the body is not JSON (502), or as {@link apiFetch}.
 * @throws {TerminalProviderError} As {@link apiFetch}.
 * @throws {FlaggedProviderError} As {@link apiFetch}.
 */
export async function apiData(request: ApiRequest, what: string): Promise<unknown> {
  // Read the envelope; an unreadable body may be a proxy page, so it is retried.
  const response = await apiFetch(request);
  const body = tryParseJson(response.body);
  if (body === undefined) {
    throw new RetryableProviderError(
      `[ai] apimodels returned an unreadable ${what}.\n  Expected JSON (HTTP ${response.status}); the runner retries it.`,
      { status: UNREADABLE_STATUS }
    );
  }

  // The envelope code is the truth, even on an HTTP 200.
  const code = envelopeCode(body);
  const isFailureCode = code !== undefined && code !== SUCCESS_CODE;
  if (isFailureCode) {
    const upstream = describeFailure(body, secretsOf(request));
    throw classifyFailure({ status: code, headers: response.headers, upstream }, request);
  }
  return readField(body, "data");
}

/**
 * Whether an error is a rate limit (a retryable 429).
 *
 * @param error - What a call threw.
 * @returns True for a {@link RetryableProviderError} with status 429.
 * @example
 * ```ts
 * isRateLimited(new RetryableProviderError("x", { status: 429 })); // => true
 * ```
 */
function isRateLimited(error: unknown): error is RetryableProviderError {
  return error instanceof RetryableProviderError && error.status === RATE_LIMITED;
}

/**
 * Waits `ms`, rejecting with the signal's reason as soon as it aborts.
 *
 * @param ms - Delay, ms.
 * @param signal - Caller abort signal.
 * @returns A promise that resolves after the delay.
 * @example
 * ```ts
 * await sleep(0, undefined); // resolves on the next timer tick
 * ```
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    /** Cancels the timer and rejects with the abort reason. */
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `call`; after a 429 it waits the `Retry-After` delay once (capped at
 * `capMs`, 1 s when there is none) and calls again. Used for the uploads and
 * registrations inside one submit, which the runner's lane does not pace.
 *
 * @param call - The HTTP call.
 * @param capMs - Longest wait, ms (`config.timeoutMs`).
 * @param signal - Caller abort signal; an abort ends the wait.
 * @returns What `call` returned.
 * @throws {RetryableProviderError} The second 429, or any other error `call` threw.
 */
export async function withRateLimitWait<T>(
  call: () => Promise<T>,
  capMs: number,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    await sleep(Math.min(error.retryAfterMs ?? DEFAULT_RATE_LIMIT_WAIT_MS, capMs), signal);
    return call();
  }
}
