/**
 * @file fal generic queue — the job id codec, submit, status, result and
 * download calls, and the in-process wait. Shared by the image and music
 * handlers; the video handler keeps its own poll and imports the codec through
 * `../video/job.ts`. fal's status and result URLs are used verbatim.
 */
import type { FalContext, FalProviderError } from "../types";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../types";
import {
  falFetch,
  jobFailure,
  parseJson,
  readApiKey,
  readField,
  readString,
  redacted,
  resolveApiKey
} from "./http";

/**
 * A submitted fal queue job: everything `poll` needs, journaled as JSON.
 */
export type FalJob = {
  /** fal endpoint id the job was submitted to. */
  endpoint: string;
  /** fal request id. */
  requestId: string;
  /** Status URL returned by fal, used verbatim. */
  statusUrl: string;
  /** Result URL returned by fal, used verbatim. */
  responseUrl: string;
};

/** Longest slice of a bad job id quoted in an error message. */
const MAX_QUOTED_ID = 80;

/**
 * Encodes a job as the opaque id `submit` returns and the runner journals.
 *
 * @param job - The submitted job.
 * @returns JSON text.
 * @example
 * ```ts
 * encodeJobId({ endpoint: "e", requestId: "r1", statusUrl: "s", responseUrl: "r" }); // => '{"endpoint":"e","requestId":"r1","statusUrl":"s","responseUrl":"r"}'
 * ```
 */
export function encodeJobId(job: FalJob): string {
  return JSON.stringify({
    endpoint: job.endpoint,
    requestId: job.requestId,
    statusUrl: job.statusUrl,
    responseUrl: job.responseUrl
  });
}

/**
 * Reads the four job fields off an untrusted value.
 *
 * @param value - Parsed JSON.
 * @returns The job, or undefined when a field is missing.
 * @example
 * ```ts
 * jobFrom({ endpoint: "e", requestId: "r1" }); // => undefined
 * ```
 */
function jobFrom(value: unknown): FalJob | undefined {
  const endpoint = readString(value, "endpoint");
  const requestId = readString(value, "requestId");
  const statusUrl = readString(value, "statusUrl");
  const responseUrl = readString(value, "responseUrl");
  const isComplete =
    endpoint !== undefined &&
    requestId !== undefined &&
    statusUrl !== undefined &&
    responseUrl !== undefined;
  return isComplete ? { endpoint, requestId, statusUrl, responseUrl } : undefined;
}

/**
 * Decodes the job id `submit` returned.
 *
 * @param jobId - The journaled job id.
 * @returns The job.
 * @throws {Error} A plain (terminal) error when the id is not a fal job id.
 * @example
 * ```ts
 * decodeJobId("nope"); // throws: [ai] fal job id "nope" is not valid.
 * ```
 */
export function decodeJobId(jobId: string): FalJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jobId);
  } catch {
    parsed = undefined;
  }
  const job = jobFrom(parsed);
  if (job === undefined) {
    throw new Error(
      `[ai] fal job id "${jobId.slice(0, MAX_QUOTED_ID)}" is not valid.\n  Expected the JSON job id returned by fal submit.`
    );
  }
  return job;
}

/**
 * Narrows fal's submit response into a job.
 *
 * @param body - Parsed submit response.
 * @param endpoint - The endpoint the job was submitted to.
 * @returns The job.
 * @throws {Error} A plain (terminal) error when a queue field is missing.
 * @example
 * ```ts
 * parseSubmitResponse({ request_id: "r1", status_url: "s", response_url: "r" }, "e"); // => { endpoint: "e", requestId: "r1", statusUrl: "s", responseUrl: "r" }
 * ```
 */
export function parseSubmitResponse(body: unknown, endpoint: string): FalJob {
  const job = jobFrom({
    endpoint,
    requestId: readString(body, "request_id"),
    statusUrl: readString(body, "status_url"),
    responseUrl: readString(body, "response_url")
  });
  if (job === undefined) {
    throw new Error(
      "[ai] fal returned an incomplete submit response.\n  Expected request_id, status_url and response_url."
    );
  }
  return job;
}

/**
 * Whether a COMPLETED status body carries a job error.
 *
 * @param body - Parsed status response.
 * @returns True when `error` is present and not null.
 * @example
 * ```ts
 * hasJobError({ status: "COMPLETED", error: "timeout" }); // => true
 * ```
 */
export function hasJobError(body: unknown): boolean {
  const error = readField(body, "error");
  return error !== undefined && error !== null;
}

/**
 * Per-call transport options: key, timeout and caller signal.
 *
 * @example
 * ```ts
 * const call: FalCall = { apiKey: "fal-key", timeoutMs: 60_000 };
 * ```
 */
export type FalCall = {
  /** fal key, sent as `Authorization: Key <key>`. */
  apiKey: string;
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Caller abort signal. */
  signal?: AbortSignal | undefined;
};

/**
 * One status read of a queue job.
 *
 * @example
 * ```ts
 * const status: FalJobStatus = { state: "completed" };
 * ```
 */
export type FalJobStatus =
  | { state: "pending" }
  | { state: "completed" }
  | { state: "failed"; error: FalProviderError };

/**
 * Turns a completed job into the task's result: fetch the result body,
 * download the file, build the result.
 *
 * @example
 * ```ts
 * const collect: CollectJob<{ requestId: string }> = async job => ({ requestId: job.requestId });
 * ```
 */
export type CollectJob<T> = (job: FalJob, apiKey: string) => Promise<T>;

/** Status values while fal is still working on a job. */
const PENDING_STATUSES: ReadonlySet<string> = new Set(["IN_QUEUE", "IN_PROGRESS"]);

/** Status of a job fal has finished. */
const COMPLETED_STATUS = "COMPLETED";

/** The one pending status value. */
const PENDING: FalJobStatus = { state: "pending" };

/** Result statuses that are fal's verdict on the job, not a failure to read it. */
const JOB_VERDICT_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/** Status carried by a result that could not be read, so the runner classifies it retryable (5xx). */
const RETRY_STATUS = 503;

/** Milliseconds per second, for the timeout message. */
const MS_PER_SECOND = 1000;

/**
 * POSTs `body` to `${queueUrl}/${endpoint}`. No caller signal: once sent, fal
 * may bill the job, so the call always runs to the end and returns its id.
 *
 * @param ctx - Plugin context (`config.queueUrl`).
 * @param endpoint - fal endpoint id.
 * @param body - Request body.
 * @param call - Key and timeout.
 * @returns The submitted job.
 * @throws {Error} A classified provider error, or a plain error for an incomplete answer.
 */
export async function submitJob(
  ctx: FalContext,
  endpoint: string,
  body: Record<string, unknown>,
  call: Omit<FalCall, "signal">
): Promise<FalJob> {
  const response = await falFetch({
    url: `${ctx.config.queueUrl}/${endpoint}`,
    method: "POST",
    apiKey: call.apiKey,
    json: body,
    timeoutMs: call.timeoutMs
  });
  return parseSubmitResponse(parseJson(response, "submit response"), endpoint);
}

/**
 * Reads the job status once. `IN_QUEUE` / `IN_PROGRESS` are pending; a
 * `COMPLETED` job with an `error` is failed (classified by `jobFailure`);
 * an unknown status warns `fal:poll:unknown-status` and is pending.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param call - Transport options.
 * @returns The job status.
 * @throws {Error} A classified provider error of the status call.
 */
export async function checkJob(ctx: FalContext, job: FalJob, call: FalCall): Promise<FalJobStatus> {
  const response = await falFetch({
    url: job.statusUrl,
    method: "GET",
    apiKey: call.apiKey,
    timeoutMs: call.timeoutMs,
    signal: call.signal
  });

  // Still working, or a status we do not know: stay pending.
  const body = parseJson(response, "status response");
  const status = readString(body, "status");
  const isPending = status !== undefined && PENDING_STATUSES.has(status);
  if (isPending) return PENDING;
  if (status !== COMPLETED_STATUS) {
    ctx.log.warn("fal:poll:unknown-status", { requestId: job.requestId, status });
    return PENDING;
  }

  // Done: a finished job may still carry fal's error.
  if (hasJobError(body)) return { state: "failed", error: jobFailure(body) };
  return { state: "completed" };
}

/**
 * GETs the job's result body with the key.
 *
 * @param job - The job.
 * @param call - Transport options.
 * @returns The parsed, still untrusted result body.
 * @throws {Error} A classified provider error, or a plain error for a non-JSON body.
 */
export async function fetchJobResult(job: FalJob, call: FalCall): Promise<unknown> {
  const response = await falFetch({
    url: job.responseUrl,
    method: "GET",
    apiKey: call.apiKey,
    timeoutMs: call.timeoutMs,
    signal: call.signal
  });
  return parseJson(response, "result");
}

/**
 * Downloads a result file from the fal CDN, without the key.
 *
 * @param url - CDN URL from the result body.
 * @param call - Timeout and signal.
 * @returns The bytes and the `content-type` header, if any.
 * @throws {Error} A classified provider error.
 */
export async function downloadFile(
  url: string,
  call: Omit<FalCall, "apiKey">
): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
  const response = await falFetch({
    url,
    method: "GET",
    timeoutMs: call.timeoutMs,
    signal: call.signal
  });
  return { bytes: response.body, contentType: response.headers.get("content-type") ?? undefined };
}

/**
 * Waits `ms` milliseconds; an abort ends the wait and rejects with the
 * signal's reason.
 *
 * @param ms - How long to wait.
 * @param signal - Caller abort signal.
 * @returns Resolves after `ms`.
 * @example
 * ```ts
 * await sleep(1000, undefined); // resolves after one second
 * ```
 */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    // Whichever comes first, the timer or the abort, cleans up the other.
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
 * One status read that tolerates a transient failure: a retryable error
 * (not an abort) logs `fal:poll:retry` and counts as pending.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param call - Transport options.
 * @returns The job status.
 * @throws {Error} Any non-retryable error, or the abort.
 */
async function checkTolerant(ctx: FalContext, job: FalJob, call: FalCall): Promise<FalJobStatus> {
  try {
    return await checkJob(ctx, job, call);
  } catch (error) {
    const isTransient = error instanceof RetryableProviderError && !call.signal?.aborted;
    if (!isTransient) throw error;

    ctx.log.warn("fal:poll:retry", { requestId: job.requestId, ...redacted(error) });
    return PENDING;
  }
}

/**
 * Waits in-process until the job completes: one status read every
 * `config.pollMs`, at most `config.jobTimeoutMs`. The job keeps running on
 * fal after a timeout (and stays adoptable through `poll`); only this wait
 * gives up.
 *
 * @param ctx - Plugin context (`config.pollMs`, `config.jobTimeoutMs`, log).
 * @param job - The job.
 * @param call - Transport options.
 * @returns Resolves once the job is `COMPLETED` without an error.
 * @throws {Error} The job's classified error, a retryable `timeout`, a non-retryable status error, or the abort reason.
 */
export async function waitForJob(ctx: FalContext, job: FalJob, call: FalCall): Promise<void> {
  const { pollMs, jobTimeoutMs } = ctx.config;
  const deadline = Date.now() + jobTimeoutMs;

  for (;;) {
    call.signal?.throwIfAborted();

    // Done, failed, or still working.
    const status = await checkTolerant(ctx, job, call);
    if (status.state === "completed") return;
    if (status.state === "failed") throw status.error;

    // Past the cap this wait gives up; the job itself keeps running on fal.
    if (Date.now() >= deadline) {
      const seconds = Math.round(jobTimeoutMs / MS_PER_SECOND);
      throw new RetryableProviderError(
        `[ai] fal job ${job.requestId} did not finish within ${seconds} s.\n  Raise fal.jobTimeoutMs, or run the item through app.runner.`,
        { kind: "timeout" }
      );
    }
    await sleep(pollMs, call.signal);
  }
}

/**
 * Whether a result or download failure is fal's verdict on the job: a
 * content-policy flag, or a terminal 400 / 422.
 *
 * @param error - What the collect step threw.
 * @returns True when the job should end as `failed`.
 * @example
 * ```ts
 * isJobVerdict(new TerminalProviderError("[ai] fal rejected the request (HTTP 422).", 422)); // => true
 * ```
 */
function isJobVerdict(error: unknown): error is FlaggedProviderError | TerminalProviderError {
  if (error instanceof FlaggedProviderError) return true;
  return error instanceof TerminalProviderError && JOB_VERDICT_STATUSES.has(error.status);
}

/**
 * Turns a terminal failure to read a finished job's result into a retryable
 * 503 (logged as `fal:result:unreadable`): the output exists and is paid for,
 * so polling goes on. Every other error is returned as is.
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param error - What the collect step threw.
 * @returns The error to throw.
 */
function asRetryable(ctx: FalContext, job: FalJob, error: unknown): unknown {
  if (!(error instanceof TerminalProviderError)) return error;

  ctx.log.warn("fal:result:unreadable", { requestId: job.requestId, status: error.status });
  return new RetryableProviderError(
    `[ai] fal finished the job but its result could not be read (HTTP ${error.status}).\n  Poll the job again; the runner does this on its own.`,
    { status: RETRY_STATUS }
  );
}

/**
 * Collects a completed job: done with the result, `failed` on fal's verdict,
 * else rethrown (a terminal read failure as a retryable 503).
 *
 * @param ctx - Plugin context (log).
 * @param job - The job.
 * @param failedEvent - Log event for a failed job, e.g. "fal:music:failed".
 * @param work - Builds the result.
 * @returns A done or failed poll.
 * @throws {Error} Anything but fal's verdict.
 */
async function settle<T extends object>(
  ctx: FalContext,
  job: FalJob,
  failedEvent: string,
  work: () => Promise<T>
): Promise<({ state: "done" } & T) | { state: "failed"; error: unknown }> {
  try {
    const result = await work();
    return { state: "done", ...result };
  } catch (error) {
    if (!isJobVerdict(error)) throw asRetryable(ctx, job, error);

    ctx.log.warn(failedEvent, { requestId: job.requestId, ...redacted(error) });
    return { state: "failed", error };
  }
}

/** Statuses fal answers for a bad or missing key. */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * The error of a poll without a valid key: a plain `Error` with no `status`
 * and no `kind`. The runner classifies it `unknown` and marks the job
 * expired, so the next run adopts the same job instead of paying again.
 *
 * @param keyVariable - The variable that holds the fal key (`config.apiKeyEnv`).
 * @returns The error to throw.
 * @example
 * ```ts
 * pollKeyError("FAL_KEY").message; // => "[ai] fal cannot poll without a valid API key.\n  Fix FAL_KEY; the next run adopts the same job."
 * ```
 */
export function pollKeyError(keyVariable: string): Error {
  return new Error(
    `[ai] fal cannot poll without a valid API key.\n  Fix ${keyVariable}; the next run adopts the same job.`
  );
}

/**
 * Whether a status call failure says fal refused the key.
 *
 * @param error - What the status call threw.
 * @returns True for a terminal 401 or 403.
 * @example
 * ```ts
 * isKeyRejection(new TerminalProviderError("[ai] fal rejected the request (HTTP 403).", 403)); // => true
 * ```
 */
export function isKeyRejection(error: unknown): boolean {
  return error instanceof TerminalProviderError && AUTH_STATUSES.has(error.status);
}

/**
 * One runner poll of a queue job: decode the id, read the key, check the
 * status once; a completed job is collected through `collect`. A key missing
 * or refused (401/403) on the status call is thrown as a plain error, so the
 * runner marks the job expired and a later run adopts the same job (the
 * video rule).
 *
 * @param ctx - Plugin context.
 * @param jobId - Opaque job id from `submit`.
 * @param signal - Caller abort signal.
 * @param failedEvent - Log event for a failed job, e.g. "fal:music:failed".
 * @param collect - Builds the result of a completed job.
 * @returns Pending, done with the result, or failed with fal's error.
 * @throws {Error} A bad job id, a missing or refused key (plain, adoptable), a status error, or a collect error that is not fal's verdict.
 */
export async function pollQueueJob<T extends object>(
  ctx: FalContext,
  jobId: string,
  signal: AbortSignal | undefined,
  failedEvent: string,
  collect: CollectJob<T>
): Promise<{ state: "pending" } | ({ state: "done" } & T) | { state: "failed"; error: unknown }> {
  // Without a valid key the job stays adoptable: the poll must not read as failed.
  const job = decodeJobId(jobId);
  const apiKey = readApiKey(ctx);
  if (apiKey === undefined) throw pollKeyError(ctx.config.apiKeyEnv);
  const call: FalCall = { apiKey, timeoutMs: ctx.config.timeoutMs, signal };

  // Pending or failed as fal reports it; a refused key keeps the job adoptable too.
  const status = await checkJob(ctx, job, call).catch((error: unknown) => {
    if (isKeyRejection(error)) throw pollKeyError(ctx.config.apiKeyEnv);
    throw error;
  });
  if (status.state === "pending") return { state: "pending" };
  if (status.state === "failed") {
    ctx.log.warn(failedEvent, { requestId: job.requestId, ...redacted(status.error) });
    return { state: "failed", error: status.error };
  }
  return settle(ctx, job, failedEvent, () => collect(job, apiKey));
}

/**
 * The `execute` path of a queue job: decode the id, read the key, wait for
 * the job in process, collect the result.
 *
 * @param ctx - Plugin context.
 * @param jobId - Opaque job id from `submit`.
 * @param signal - Caller abort signal.
 * @param collect - Builds the result of a completed job.
 * @returns The task's result.
 * @throws {Error} A bad job id, a missing key, any wait error, or any collect error.
 */
export async function runQueueJob<T>(
  ctx: FalContext,
  jobId: string,
  signal: AbortSignal | undefined,
  collect: CollectJob<T>
): Promise<T> {
  const job = decodeJobId(jobId);
  const apiKey = resolveApiKey(ctx);

  await waitForJob(ctx, job, { apiKey, timeoutMs: ctx.config.timeoutMs, signal });
  return collect(job, apiKey);
}

/**
 * MIME type from a URL's file extension (query and hash ignored), or undefined.
 *
 * @param url - File URL.
 * @param byExtension - MIME types by lower-case extension.
 * @returns The MIME type, or undefined for an unknown extension or an unparsable URL.
 * @example
 * ```ts
 * mimeFromUrl("https://v3.fal.media/files/o.WEBP?x=1", { webp: "image/webp" }); // => "image/webp"
 * ```
 */
export function mimeFromUrl(
  url: string,
  byExtension: Readonly<Record<string, string>>
): string | undefined {
  if (!URL.canParse(url)) return undefined;

  const { pathname } = new URL(url);
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return undefined;

  const extension = pathname.slice(dot + 1).toLowerCase();
  return Object.hasOwn(byExtension, extension) ? byExtension[extension] : undefined;
}

/**
 * Copies caller params minus the keys a handler maps itself. Never mutates the input.
 *
 * @param params - Caller params.
 * @param consumed - Keys the handler already mapped.
 * @returns A new object with the remaining params.
 * @example
 * ```ts
 * passthroughParameters({ resolution: "2K", seed: 7 }, ["resolution", "quality"]); // => { seed: 7 }
 * ```
 */
export function passthroughParameters(
  params: Record<string, unknown> | undefined,
  consumed: readonly string[]
): Record<string, unknown> {
  const skipped = new Set(consumed);
  const entries = Object.entries(params ?? {}).filter(([key]) => !skipped.has(key));
  return Object.fromEntries(entries);
}
