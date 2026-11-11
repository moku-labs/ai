/**
 * @file fal call handler — one fal queue endpoint of the caller's choice, as the
 * `("call", "fal")` job handler: `estimate`, `submit` and `poll`. The request is
 * checked and priced before the key is read or anything is uploaded; the queue
 * POST carries no caller signal. The answer is fal's result body as JSON text, so
 * the runner stores (and caches) exactly what fal said. fal gives no cost with an
 * answer: the cost is the endpoint's row times the units of the call.
 */
import { readFile } from "node:fs/promises";
import { readField, readString, resolveApiKey } from "../client/http";
import type { FalJob } from "../client/queue";
import { encodeJobId, fetchJobResult, pollQueueJob, submitJob } from "../client/queue";
import { uploadFiles } from "../client/upload";
import { TerminalProviderError } from "../errors";
import type { RequestLog, RequestLogEntry } from "../log";
import { createRequestLog, withRequestLog } from "../log";
import { resolvePrices } from "../prices";
import type {
  CallHandler,
  CallJobPoll,
  CallRequest,
  CallResult,
  CallUnit,
  FalContext,
  LocalFile
} from "../types";
import { imageSize } from "../video/image-size";
import {
  callCannotPriceError,
  callCostUsd,
  callRate,
  callUnitOf,
  frameBlocksOf,
  megapixelsOf
} from "./prices";

/** The request after the check: a non-empty endpoint and a plain object input. */
type CheckedCall = { endpoint: string; input: Record<string, unknown> };

/**
 * Everything checked before any I/O: the endpoint, the input, the rate and the unit.
 */
export type CallPlan = CheckedCall & {
  /** USD per billed unit of the endpoint. */
  rate: number;
  /** How fal bills the endpoint. */
  unit: CallUnit;
};

/** Log event for a failed call job. */
const FAILED_EVENT = "fal:call:failed";

/** Status of a request refused before any charge. */
const BAD_REQUEST = 400;

/** The one MIME type of a call answer. */
const JSON_MIME = "application/json";

/** The message of a request that is not an endpoint plus a JSON object input. */
const INVALID_REQUEST =
  '[ai] Invalid fal call request.\n  Pass "endpoint" (a fal endpoint id, for example "fal-ai/sam-3/image") and "input" (a JSON object).';

/** The input field `microsoft/moge-2` is billed by. */
const MEGAPIXEL_FIELD = "image_url";

/**
 * Whether a value is a plain object (not null, not an array).
 *
 * @param value - Any value.
 * @returns True for a non-null, non-array object.
 * @example
 * ```ts
 * isPlainObject({ a: 1 }); // => true
 * isPlainObject([1]); // => false
 * ```
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the request: `endpoint` a non-empty string, `input` a plain object. No
 * pattern check on the endpoint: the price table is the allow-list.
 *
 * @param request - The call request, untrusted at runtime.
 * @returns The endpoint and the input.
 * @throws {TerminalProviderError} A 400 for anything else.
 */
function checkCallRequest(request: CallRequest): CheckedCall {
  const endpoint = readString(request, "endpoint");
  const input = readField(request, "input");
  if (endpoint === undefined || endpoint === "" || !isPlainObject(input)) {
    throw new TerminalProviderError(INVALID_REQUEST, BAD_REQUEST);
  }
  return { endpoint, input };
}

/**
 * Plans a request without I/O: the check, the rate and the unit.
 *
 * @param ctx - Plugin context (price table).
 * @param request - The call request.
 * @returns The plan.
 * @throws {TerminalProviderError} A 400 for an invalid request or an endpoint with no price row.
 */
export function planCall(ctx: FalContext, request: CallRequest): CallPlan {
  const checked = checkCallRequest(request);
  const rate = callRate(resolvePrices(ctx), checked.endpoint);
  return { ...checked, rate, unit: callUnitOf(checked.endpoint) };
}

/**
 * Whether a value is a resolved file: an object with exactly the string fields
 * `path`, `mimeType` and `hash` (what the runner puts in place of `$file`). Any other
 * value is data and is posted as it is.
 *
 * @param value - Any part of the input.
 * @returns True for a resolved file.
 * @example
 * ```ts
 * isResolvedFile({ path: "plate.png", mimeType: "image/png", hash: "sha256:ab" }); // => true
 * isResolvedFile("https://cdn.example.test/plate.png"); // => false
 * ```
 */
function isResolvedFile(value: unknown): value is LocalFile {
  if (!isPlainObject(value)) return false;

  const fields = Object.keys(value);
  const hasExactFields = fields.length === 3;
  return (
    hasExactFields &&
    typeof value.path === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.hash === "string"
  );
}

/**
 * Identity of a resolved file, so one file listed twice is uploaded once.
 *
 * @param file - A resolved file.
 * @returns A key unique to the path and content.
 * @example
 * ```ts
 * fileKey({ path: "a.png", mimeType: "image/png", hash: "h" }); // => '["a.png","image/png","h"]'
 * ```
 */
function fileKey(file: LocalFile): string {
  return JSON.stringify([file.path, file.mimeType, file.hash]);
}

/**
 * Adds every resolved file found in a value to `found`, at any depth, arrays too,
 * in walk order.
 *
 * @param value - Any part of the input.
 * @param found - The files so far; appended to.
 * @example
 * ```ts
 * const found: LocalFile[] = [];
 * collectFiles({ masks: [{ path: "m.png", mimeType: "image/png", hash: "h" }] }, found); // found.length => 1
 * ```
 */
function collectFiles(value: unknown, found: LocalFile[]): void {
  if (isResolvedFile(value)) {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, found);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectFiles(item, found);
  }
}

/**
 * The resolved files of a call input, in walk order. The input itself is the
 * body, never a file: only what it holds is walked.
 *
 * @param input - The call input.
 * @returns The files, with repeats when a file is listed twice.
 * @example
 * ```ts
 * filesOf({ image_url: { path: "a.png", mimeType: "image/png", hash: "h" }, prompt: "wall" }).length; // => 1
 * ```
 */
function filesOf(input: Record<string, unknown>): LocalFile[] {
  const found: LocalFile[] = [];
  for (const item of Object.values(input)) collectFiles(item, found);
  return found;
}

/**
 * Copies an object with each value mapped.
 *
 * @param object - The object to copy.
 * @param map - Maps one value.
 * @returns The copy.
 * @example
 * ```ts
 * mapValues({ a: 1, b: 2 }, value => Number(value) * 2); // => { a: 2, b: 4 }
 * ```
 */
function mapValues(
  object: Record<string, unknown>,
  map: (value: unknown) => unknown
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, map(item)]));
}

/**
 * Copies a value with each resolved file replaced by its uploaded URL; everything
 * else is copied as it is.
 *
 * @param value - Any part of the input.
 * @param urls - Uploaded URLs by file key.
 * @returns The part of the body to post.
 * @example
 * ```ts
 * replaceFiles({ path: "a.png", mimeType: "image/png", hash: "h" }, new Map([['["a.png","image/png","h"]', "https://cdn.fal.test/a.png"]])); // => "https://cdn.fal.test/a.png"
 * ```
 */
function replaceFiles(value: unknown, urls: ReadonlyMap<string, string | undefined>): unknown {
  if (isResolvedFile(value)) return urls.get(fileKey(value));
  if (Array.isArray(value)) return value.map(item => replaceFiles(item, urls));
  if (!isPlainObject(value)) return value;
  return mapValues(value, item => replaceFiles(item, urls));
}

/**
 * The pixel size of the input image of a megapixel endpoint: `input.image_url`
 * must be a resolved local file that is still there and whose header `imageSize` reads.
 *
 * @param input - The call input.
 * @returns The size, or undefined when the image is not such a file.
 */
async function inputImageSize(
  input: Record<string, unknown>
): Promise<{ width: number; height: number } | undefined> {
  const image = input[MEGAPIXEL_FIELD];
  if (!isResolvedFile(image)) return undefined;

  // A file that is gone (a later process adopts the job) has no size.
  let bytes: Uint8Array;
  try {
    bytes = await readFile(image.path);
  } catch {
    return;
  }
  return imageSize(bytes);
}

/**
 * Refuses a megapixel call whose image cannot be measured, before the key or any upload.
 *
 * @param plan - The plan.
 * @throws {TerminalProviderError} A 400 when the unit is `megapixel` and `input.image_url` is not a readable local PNG, JPEG or WebP.
 */
async function requirePriceable(plan: CallPlan): Promise<void> {
  if (plan.unit !== "megapixel") return;
  if ((await inputImageSize(plan.input)) === undefined) throw callCannotPriceError(plan.endpoint);
}

/**
 * Reads the key, uploads the files of the input and queues the job, writing the
 * request log line around the queue POST.
 *
 * @param ctx - Plugin context.
 * @param requestLog - The request log, or undefined when off.
 * @param plan - The plan.
 * @param signal - Caller abort signal (uploads only).
 * @returns The opaque job id.
 */
async function submitCall(
  ctx: FalContext,
  requestLog: RequestLog | undefined,
  plan: CallPlan,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Refuse what cannot be priced, then read the key, before any upload.
  await requirePriceable(plan);
  const apiKey = resolveApiKey(ctx);

  // Upload every file once; an abort here stops before anything is billed.
  const { endpoint, input } = plan;
  const files = filesOf(input);
  const unique = [...new Map(files.map(file => [fileKey(file), file])).values()];
  const urls = await uploadFiles(ctx, unique, { apiKey, signal });
  signal?.throwIfAborted();

  // The body is the input with each file's URL where the file was; `params` are not sent.
  const urlByKey = new Map(unique.map((file, index) => [fileKey(file), urls[index]] as const));
  const body = mapValues(input, item => replaceFiles(item, urlByKey));
  const entry: RequestLogEntry = {
    task: "call",
    model: endpoint,
    endpoint,
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    body,
    files
  };

  // Queue the job: once the POST is sent fal may bill it, so it runs to the end without the signal.
  const job = await withRequestLog(
    requestLog,
    entry,
    () => submitJob(ctx, endpoint, body, { apiKey, timeoutMs: ctx.config.timeoutMs }),
    submitted => submitted.requestId
  );
  ctx.log.info("fal:call:submitted", { endpoint, requestId: job.requestId });
  return { jobId: encodeJobId(job) };
}

/**
 * How many units fal billed for an answer, or undefined when this process cannot
 * tell: no `rle` array, or the image file is gone.
 *
 * @param plan - The plan of the request the job was submitted with.
 * @param body - fal's result body.
 * @returns The units, or undefined.
 */
async function billedUnits(plan: CallPlan, body: unknown): Promise<number | undefined> {
  if (plan.unit === "request") return 1;
  if (plan.unit === "16-frames") return frameBlocksOf(body);

  const size = await inputImageSize(plan.input);
  return size === undefined ? undefined : megapixelsOf(size);
}

/**
 * Collects a completed job: the result body, the units and the cost. Unknown
 * units cost one unit and warn once; the item is never failed for it, the answer
 * is paid for.
 *
 * @param ctx - Plugin context.
 * @param job - The job.
 * @param plan - The plan of the request the job was submitted with.
 * @param apiKey - The fal key (result call only).
 * @param signal - Caller abort signal.
 * @returns The call result: fal's body as JSON text.
 * @throws {Error} Any call error of the result read.
 */
async function collectCall(
  ctx: FalContext,
  job: FalJob,
  plan: CallPlan,
  apiKey: string,
  signal: AbortSignal | undefined
): Promise<CallResult> {
  const body = await fetchJobResult(job, { apiKey, timeoutMs: ctx.config.timeoutMs, signal });

  // The units may be unknown after a paid call: one unit, one warning.
  const counted = await billedUnits(plan, body);
  const { endpoint, unit, rate } = plan;
  if (counted === undefined) {
    ctx.log.warn("fal:call:units-unknown", { endpoint, requestId: job.requestId });
  }
  const units = counted ?? 1;
  ctx.log.info("fal:call:done", { requestId: job.requestId, units });

  const meta = { endpoint, requestId: job.requestId, unit, units };
  return {
    text: JSON.stringify(body),
    mimeType: JSON_MIME,
    costUsd: callCostUsd(rate, units),
    meta
  };
}

/**
 * Creates the fal call handler registered under `("call", "fal")`. `estimate`
 * is one unit of the endpoint's rate and touches no network, key or file.
 * `submit` + `poll` is the job form the runner journals, so the fal job id is
 * stored before any wait. There is no `execute`.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, submit and poll.
 */
export function createCallHandler(ctx: FalContext): CallHandler {
  const requestLog = createRequestLog(ctx);

  return {
    estimate: (request: CallRequest): { usd: number } => ({ usd: planCall(ctx, request).rate }),
    // Async arrows: a plan error rejects the promise instead of throwing synchronously.
    submit: async (
      request: CallRequest,
      opts: { signal?: AbortSignal }
    ): Promise<{ jobId: string }> =>
      submitCall(ctx, requestLog, planCall(ctx, request), opts.signal),
    poll: async (
      jobId: string,
      request: CallRequest,
      opts: { signal?: AbortSignal }
    ): Promise<CallJobPoll> => {
      const plan = planCall(ctx, request);
      return pollQueueJob(ctx, jobId, opts.signal, FAILED_EVENT, (job, apiKey) =>
        collectCall(ctx, job, plan, apiKey, opts.signal)
      );
    }
  };
}
