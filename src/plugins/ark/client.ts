/**
 * @file ark thin fetch client (global fetch — Node >= 24 and Bun). `arkFetch`
 * performs every HTTP call of this plugin (video tasks, the clip download,
 * the signed asset OpenAPI) and owns the one place that classifies transport
 * and HTTP failures into `RetryableProviderError` / `TerminalProviderError` /
 * `FlaggedProviderError`. Every error it throws carries a `status` or a
 * `kind`, so the runner never classifies an ark failure as `unknown`.
 * `openApiCall` signs one control-plane call and unwraps the OpenAPI envelope.
 */

import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "./errors";
import { arkRegions, controlPlaneUrl, OPENAPI_VERSION } from "./regions";
import { signRequest } from "./sign";
import type { ArkContext, ArkProviderError } from "./types";

/**
 * HTTP method used against ark.
 *
 * @example
 * ```ts
 * const method: ArkMethod = "GET";
 * ```
 */
export type ArkMethod = "GET" | "POST";

/**
 * One request's method, headers and body.
 *
 * @example
 * ```ts
 * const init: ArkInit = { method: "POST", headers: { Authorization: "Bearer k" }, body: '{"model":"m"}' };
 * ```
 */
export type ArkInit = {
  /** HTTP method. */
  method: ArkMethod;
  /** Request headers; none for the clip download. Never logged. */
  headers?: Record<string, string> | undefined;
  /** JSON body text. */
  body?: string | undefined;
};

/**
 * How one call runs and how its failures read.
 *
 * @example
 * ```ts
 * const options: ArkFetchOptions = { timeoutMs: 60_000, label: "/contents/generations/tasks", localImage: true };
 * ```
 */
export type ArkFetchOptions = {
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Caller abort signal; an abort is rethrown unchanged (clean pause). */
  signal?: AbortSignal | undefined;
  /** What the call is, for error messages: an OpenAPI Action or a data-plane path. Never a URL. */
  label: string;
  /** Whether the request carries a plain local image: picks the face-refusal message. */
  localImage?: boolean | undefined;
};

/**
 * A successful (2xx) ark response with its body fully read.
 *
 * @example
 * ```ts
 * const response: ArkResponse = { status: 200, headers: new Headers(), body: new Uint8Array() };
 * ```
 */
export type ArkResponse = {
  /** HTTP status. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Body bytes. */
  body: Uint8Array;
};

/**
 * What ark said about a failure, narrowed from a data-plane body
 * (`error.code` / `error.message`) or an OpenAPI envelope
 * (`ResponseMetadata.Error.Code` / `.Message`).
 *
 * @example
 * ```ts
 * const info: ArkErrorInfo = { code: "InvalidParameter", message: "bad ratio", envelope: false };
 * ```
 */
export type ArkErrorInfo = {
  /** ark's error code, when it gave one. */
  code: string | undefined;
  /** ark's message, shortened, without a trailing period. */
  message: string | undefined;
  /** True when it came from an OpenAPI envelope. */
  envelope: boolean;
};

/**
 * Request bodies of the asset OpenAPI actions this plugin calls.
 *
 * @example
 * ```ts
 * const body: OpenApiBodies["CreateAsset"] = { GroupId: "group-1", URL: "https://cdn.example/m.png", AssetType: "Image", Name: "m.png" };
 * ```
 */
export type OpenApiBodies = {
  /** Creates an AIGC asset group. */
  CreateAssetGroup: { GroupType: "AIGC"; Name: string };
  /** Registers one image from a public URL into a group. */
  CreateAsset: { GroupId: string; URL: string; AssetType: "Image"; Name: string };
  /** Reads one asset's status. */
  GetAsset: { Id: string };
};

/**
 * An asset OpenAPI action this plugin calls.
 *
 * @example
 * ```ts
 * const action: OpenApiAction = "GetAsset";
 * ```
 */
export type OpenApiAction = keyof OpenApiBodies;

/** Longest slice of ark's error text copied into an error message. */
const MAX_ERROR_TEXT = 300;

/** Status carried by a response ark sent but that could not be read: retryable (5xx). */
const UNREADABLE_STATUS = 502;

/** Status used for an OpenAPI envelope error inside a 2xx response. */
const ENVELOPE_ERROR_STATUS = 400;

/** HTTP 429 Too Many Requests: retryable, honouring Retry-After. */
const HTTP_TOO_MANY_REQUESTS = 429;

/** Lowest HTTP server-error status: every 5xx is retryable. */
const HTTP_SERVER_ERROR_MIN = 500;

/** Milliseconds in a second, for a Retry-After given in seconds. */
const MS_PER_SECOND = 1000;

/** HTTP statuses on which a SensitiveContent code is a refusal. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/** OpenAPI error-code prefixes of ark-mcp's throttling set: retryable as 429. */
const THROTTLING_CODE = /^(Throttling|RequestLimitExceeded|FlowLimitExceeded|TooManyRequests)/;

/** Second line of an entitlement-related OpenAPI error. */
const ENTITLEMENT_HINT =
  "Check the Seedance Advanced Creation Rights and the AIGC authorization letter in the Ark console";

/**
 * Reads a property off an untrusted JSON value, still untrusted.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The property value, or undefined.
 * @example
 * ```ts
 * readField({ content: { video_url: "u" } }, "content"); // => { video_url: "u" }
 * ```
 */
export function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

/**
 * Reads a string property off an untrusted JSON value.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The string, or undefined when absent or not a string.
 * @example
 * ```ts
 * readString({ id: "cgt-1" }, "id"); // => "cgt-1"
 * ```
 */
export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}

/**
 * Reads a finite number property off an untrusted JSON value.
 *
 * @param value - Parsed JSON (anything).
 * @param key - Property name.
 * @returns The number, or undefined when absent or not a finite number.
 * @example
 * ```ts
 * readNumber({ completion_tokens: 108900 }, "completion_tokens"); // => 108900
 * ```
 */
export function readNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/**
 * Parses a response body as JSON, tolerating an empty or non-JSON body.
 *
 * @param response - The response.
 * @returns The parsed, still untrusted value, or undefined.
 * @example
 * ```ts
 * readJson({ status: 200, headers: new Headers(), body: new TextEncoder().encode('{"id":"a"}') }); // => { id: "a" }
 * ```
 */
export function readJson(response: ArkResponse): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return undefined;
  }
}

/**
 * Collapses whitespace, cuts ark's text to {@link MAX_ERROR_TEXT} characters
 * and drops a trailing period (the message adds its own).
 *
 * @param text - ark's error text, if any.
 * @returns The shortened text, or undefined.
 * @example
 * ```ts
 * shorten("bad\n  ratio."); // => "bad ratio"
 * ```
 */
export function shorten(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replaceAll(/\s+/g, " ").trim();
  const cut = flat.length > MAX_ERROR_TEXT ? `${flat.slice(0, MAX_ERROR_TEXT)}...` : flat;
  const withoutPeriod = cut.endsWith(".") && !cut.endsWith("...") ? cut.slice(0, -1) : cut;
  return withoutPeriod === "" ? undefined : withoutPeriod;
}

/**
 * Narrows an ark error body: an OpenAPI envelope error when there is one,
 * else a data-plane `error` object.
 *
 * @param body - Parsed JSON body, or undefined when unreadable.
 * @returns The code, the shortened message and where they came from.
 * @example
 * ```ts
 * describeArkError({ error: { code: "InvalidParameter", message: "bad ratio." } }); // => { code: "InvalidParameter", message: "bad ratio", envelope: false }
 * ```
 */
export function describeArkError(body: unknown): ArkErrorInfo {
  const envelopeError = readField(readField(body, "ResponseMetadata"), "Error");
  if (typeof envelopeError === "object" && envelopeError !== null) {
    return {
      code: readString(envelopeError, "Code"),
      message: shorten(readString(envelopeError, "Message")),
      envelope: true
    };
  }
  const error = readField(body, "error");
  return {
    code: readString(error, "code"),
    message: shorten(readString(error, "message")),
    envelope: false
  };
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
 * The content-policy error for a refusal code. A request with a plain local
 * image gets the "make it an asset" hint, because ark refuses real faces in
 * plain images but takes them as registered assets.
 *
 * @param code - ark's refusal code, e.g. `InputImageSensitiveContentDetected.PrivacyInformation`.
 * @param localImage - Whether the request carries a plain local image.
 * @returns The flagged error.
 * @example
 * ```ts
 * flaggedError("InputTextSensitiveContentDetected", false).message;
 * // => "[ai] ark flagged the request: InputTextSensitiveContentDetected.\n  Change the prompt or the inputs."
 * ```
 */
export function flaggedError(code: string, localImage: boolean): FlaggedProviderError {
  const message = localImage
    ? `[ai] ark refused an image with a face: ${code}.\n  Make it an asset item and $ref it.`
    : `[ai] ark flagged the request: ${code}.\n  Change the prompt or the inputs.`;
  return new FlaggedProviderError(message);
}

/**
 * The error for a 2xx response ark sent but that could not be read:
 * retryable, so the runner asks again.
 *
 * @param label - The Action or path.
 * @returns A retryable error with status 502.
 * @example
 * ```ts
 * unreadableResponse("GetAsset").status; // => 502
 * ```
 */
export function unreadableResponse(label: string): RetryableProviderError {
  return new RetryableProviderError(
    `[ai] ark ${label} returned an unreadable response.\n  The runner asks again.`,
    { status: UNREADABLE_STATUS }
  );
}

/**
 * The terminal error for a 4xx, with ark's code and message.
 *
 * @param label - The Action or path.
 * @param status - The HTTP status.
 * @param info - The narrowed error.
 * @param hint - Optional second line.
 * @returns The terminal error.
 * @example
 * ```ts
 * terminalFailure("GetAsset", 404, { code: undefined, message: undefined, envelope: false }).message; // => "[ai] ark GetAsset failed (404)."
 * ```
 */
function terminalFailure(
  label: string,
  status: number,
  info: ArkErrorInfo,
  hint?: string
): TerminalProviderError {
  const code = info.code === undefined ? "" : ` ${info.code}`;
  const message = info.message === undefined ? "" : `: ${info.message}`;
  const second = hint === undefined ? "" : `\n  ${hint}.`;
  return new TerminalProviderError(
    `[ai] ark ${label} failed (${status}${code})${message}.${second}`,
    status,
    info.code
  );
}

/**
 * Whether an OpenAPI error code is a throttling code.
 *
 * @param code - The OpenAPI error code.
 * @returns True for `Throttling*`, `RequestLimitExceeded*`, `FlowLimitExceeded*` and `TooManyRequests*`.
 * @example
 * ```ts
 * isThrottlingCode("RequestLimitExceeded"); // => true
 * ```
 */
function isThrottlingCode(code: string): boolean {
  return THROTTLING_CODE.test(code);
}

/**
 * Whether an OpenAPI error code is about the account's entitlement.
 *
 * @param code - The OpenAPI error code.
 * @returns True for `QuotaExceeded`, `AccessDenied*` and `InvalidAuthorization*`.
 * @example
 * ```ts
 * isEntitlementCode("AccessDenied.Unauthorized"); // => true
 * ```
 */
function isEntitlementCode(code: string): boolean {
  return (
    code === "QuotaExceeded" ||
    code.startsWith("AccessDenied") ||
    code.startsWith("InvalidAuthorization")
  );
}

/**
 * Classifies a failed call: 429 and 5xx are retryable, a SensitiveContent
 * code on 400/422 is flagged, an OpenAPI throttling code is retryable 429,
 * an entitlement code is terminal with a hint, anything else terminal.
 *
 * @param label - The Action or path.
 * @param status - The HTTP status (400 for an envelope error in a 2xx).
 * @param headers - The response headers (Retry-After).
 * @param info - The narrowed error.
 * @param localImage - Whether the request carries a plain local image.
 * @returns The error to throw.
 * @example
 * ```ts
 * failureOf("GetAsset", 503, new Headers(), { code: undefined, message: undefined, envelope: false }, false).message; // => "[ai] ark returned HTTP 503 for GetAsset."
 * ```
 */
function failureOf(
  label: string,
  status: number,
  headers: Headers,
  info: ArkErrorInfo,
  localImage: boolean
): ArkProviderError {
  // Rate limits and server errors are retryable, whatever the body says.
  const retryAfterMs = retryAfterMsOf(headers.get("retry-after"));
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return new RetryableProviderError(`[ai] ark rate-limited ${label} (HTTP 429).`, {
      status,
      retryAfterMs
    });
  }
  if (status >= HTTP_SERVER_ERROR_MIN) {
    return new RetryableProviderError(`[ai] ark returned HTTP ${status} for ${label}.`, { status });
  }

  // A 4xx: ark's code decides.
  const code = info.code ?? "";
  const isRefusal = REFUSAL_STATUSES.has(status) && code.includes("SensitiveContent");
  const isThrottled = info.envelope && isThrottlingCode(code);
  const isEntitlement = info.envelope && isEntitlementCode(code);
  if (isRefusal) return flaggedError(code, localImage);
  if (isThrottled) {
    return new RetryableProviderError(
      `[ai] ark ${label} was throttled (${code}).\n  The runner retries it.`,
      { status: HTTP_TOO_MANY_REQUESTS, retryAfterMs }
    );
  }
  if (isEntitlement) {
    return terminalFailure(label, status, info, ENTITLEMENT_HINT);
  }
  return terminalFailure(label, status, info);
}

/**
 * Classifies a fetch or body-read rejection: a caller abort passes through
 * unchanged, our own timeout is retryable `timeout`, anything else is
 * retryable `network`.
 *
 * @param error - What fetch threw.
 * @param caller - The caller's signal, if any.
 * @param timeout - This request's timeout signal.
 * @param label - The Action or path.
 * @returns The value to throw.
 * @example
 * ```ts
 * transportFailure(new Error("x"), undefined, AbortSignal.abort(), "GetAsset"); // => RetryableProviderError, kind "timeout"
 * ```
 */
function transportFailure(
  error: unknown,
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
  label: string
): unknown {
  if (caller?.aborted) return error;
  if (timeout.aborted) {
    return new RetryableProviderError(`[ai] ark request timed out (${label}).`, {
      kind: "timeout"
    });
  }
  return new RetryableProviderError(`[ai] ark request failed (network, ${label}).`, {
    kind: "network"
  });
}

/**
 * Performs one ark HTTP call and reads the whole body. Enforces `timeoutMs`
 * through `AbortSignal.any([caller, AbortSignal.timeout(ms)])`. Error
 * messages start with "[ai] ark" and never contain a key or a URL.
 *
 * @param url - Absolute URL, used verbatim.
 * @param init - Method, headers and body.
 * @param options - Timeout, caller signal, label and the local-image flag.
 * @returns The 2xx response with its body bytes.
 * @throws {RetryableProviderError} On 5xx, 429, a timeout, or a network failure.
 * @throws {FlaggedProviderError} On a 400/422 SensitiveContent refusal.
 * @throws {TerminalProviderError} On any other non-2xx status.
 */
export async function arkFetch(
  url: string,
  init: ArkInit,
  options: ArkFetchOptions
): Promise<ArkResponse> {
  // Our timeout, joined with the caller's abort when there is one.
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const requestInit: RequestInit = { method: init.method, headers: init.headers ?? {}, signal };
  if (init.body !== undefined) requestInit.body = init.body;

  // Fetch and read the whole body; a transport failure is classified here.
  let response: ArkResponse;
  try {
    const raw = await fetch(url, requestInit);
    const body = new Uint8Array(await raw.arrayBuffer());
    response = { status: raw.status, headers: raw.headers, body };
  } catch (error) {
    throw transportFailure(error, options.signal, timeout, options.label);
  }

  // Only a 2xx passes; every other status is classified.
  const isSuccess = response.status >= 200 && response.status < 300;
  if (isSuccess) return response;
  const info = describeArkError(readJson(response));
  throw failureOf(
    options.label,
    response.status,
    response.headers,
    info,
    options.localImage === true
  );
}

/**
 * Calls one asset OpenAPI action: `POST {controlPlane}/?Action=<A>&Version=2024-01-01`
 * with a JSON body, signed with the access key and secret key read through
 * `ctx.env` (MC3). Unwraps the envelope: an `Error` in it is classified like
 * an HTTP 400, a missing `Result` is retryable.
 *
 * @param ctx - Plugin context (config, env).
 * @param action - The OpenAPI action.
 * @param body - The action's request body.
 * @param signal - Caller abort signal.
 * @returns The envelope's `Result`, still untrusted.
 * @throws {Error} The env error when a key is not set, before any call.
 * @throws {RetryableProviderError | TerminalProviderError | FlaggedProviderError} As {@link arkFetch}, plus envelope errors.
 */
export async function openApiCall<A extends OpenApiAction>(
  ctx: ArkContext,
  action: A,
  body: OpenApiBodies[A],
  signal?: AbortSignal
): Promise<unknown> {
  // Keys first: a missing key fails before any call.
  const accessKey = ctx.env.require(ctx.config.accessKeyEnv);
  const secretKey = ctx.env.require(ctx.config.secretKeyEnv);

  // Sign the exact body text that is sent.
  const region = arkRegions[ctx.config.region];
  const url = `${controlPlaneUrl(ctx.config)}/?Action=${action}&Version=${OPENAPI_VERSION}`;
  const text = JSON.stringify(body);
  const headers = signRequest({
    method: "POST",
    url,
    body: text,
    accessKey,
    secretKey,
    region: region.signRegion,
    service: region.signService,
    now: new Date()
  });
  const response = await arkFetch(
    url,
    { method: "POST", headers, body: text },
    { timeoutMs: ctx.config.timeoutMs, signal, label: action }
  );

  // Unwrap the envelope.
  const json = readJson(response);
  const info = describeArkError(json);
  if (info.envelope) {
    throw failureOf(action, ENVELOPE_ERROR_STATUS, response.headers, info, false);
  }
  const result = readField(json, "Result");
  if (typeof result !== "object" || result === null) throw unreadableResponse(action);
  return result;
}
