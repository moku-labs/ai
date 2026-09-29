/**
 * @file apimodels job helpers — the opaque job id the runner journals as
 * `attempts.external_id` (metadata only: task id, alias, asset cost), and the
 * narrowing of apimodels' task and records payloads.
 */
import { readField, readString } from "../client";

/**
 * A submitted apimodels task: everything `poll` needs besides the request,
 * journaled as JSON. Metadata only, never a payload echo.
 *
 * @example
 * ```ts
 * const job: ApimodelsJob = { taskId: "task-1", model: "seedance-2.5", assetUsd: 0.01 };
 * ```
 */
export type ApimodelsJob = {
  /** apimodels task id. */
  taskId: string;
  /** The model alias the task was submitted with. */
  model: string;
  /** USD paid for asset registrations in the submit, added to the done cost. */
  assetUsd: number;
};

/**
 * A task, narrowed from a submit or poll `data`: every field may be absent.
 */
export type TaskStatus = {
  /** Task id. */
  taskId: string | undefined;
  /** `pending`, `processing`, `completed`, `failed`, or anything apimodels adds later. */
  state: string | undefined;
  /** First result URL of a completed task (lives 7 days). */
  resultUrl: string | undefined;
  /** failCode of a failed task. */
  failCode: string | undefined;
  /** failMsg of a failed task. */
  failMsg: string | undefined;
  /** apimodels' own retry verdict, when it gave one. */
  retryable: boolean | undefined;
};

/** Longest slice of a bad job id quoted in an error message. */
const MAX_QUOTED_ID = 80;

/** Currency of a charge this plugin can add to a USD cost. */
const USD = "USD";

/**
 * Encodes a job as the opaque id `submit` returns and the runner journals.
 *
 * @param job - The submitted job.
 * @returns JSON text.
 * @example
 * ```ts
 * encodeJobId({ taskId: "t1", model: "seedance-2.5", assetUsd: 0 }); // => '{"taskId":"t1","model":"seedance-2.5","assetUsd":0}'
 * ```
 */
export function encodeJobId(job: ApimodelsJob): string {
  return JSON.stringify({ taskId: job.taskId, model: job.model, assetUsd: job.assetUsd });
}

/**
 * Reads the three job fields off an untrusted value.
 *
 * @param value - Parsed JSON.
 * @returns The job, or undefined when a field is missing or out of range.
 * @example
 * ```ts
 * jobFrom({ taskId: "t1", model: "m" }); // => undefined
 * ```
 */
function jobFrom(value: unknown): ApimodelsJob | undefined {
  const taskId = readString(value, "taskId");
  const model = readString(value, "model");
  const assetUsd = readField(value, "assetUsd");
  const isValidCost = typeof assetUsd === "number" && Number.isFinite(assetUsd) && assetUsd >= 0;
  const isComplete = taskId !== undefined && taskId !== "" && model !== undefined && isValidCost;
  return isComplete ? { taskId, model, assetUsd } : undefined;
}

/**
 * Decodes the job id `submit` returned. A corrupt id is thrown as a plain
 * `Error` with no `status` or `kind`, like fal's: the runner classifies it
 * `unknown`, so a poll marks the job expired instead of failed.
 *
 * @param jobId - The journaled job id.
 * @returns The job.
 * @throws {Error} A plain error when the id is not an apimodels job id.
 * @example
 * ```ts
 * decodeJobId("nope"); // throws: [ai] apimodels job id "nope" is not valid.
 * ```
 */
export function decodeJobId(jobId: string): ApimodelsJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jobId);
  } catch {
    parsed = undefined;
  }

  const job = jobFrom(parsed);
  if (job === undefined) {
    throw new Error(
      `[ai] apimodels job id "${jobId.slice(0, MAX_QUOTED_ID)}" is not valid.\n  Expected the JSON job id returned by apimodels submit.`
    );
  }
  return job;
}

/**
 * The first string of an untrusted list.
 *
 * @param value - Parsed JSON (anything).
 * @returns The first entry when it is a string, else undefined.
 * @example
 * ```ts
 * firstString(["https://r2/a.mp4"]); // => "https://r2/a.mp4"
 * ```
 */
function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const [first] = value;
  return typeof first === "string" ? first : undefined;
}

/**
 * Narrows a submit or poll `data` to the task fields this plugin reads.
 *
 * @param data - The envelope's `data`.
 * @returns The task status; absent fields are undefined.
 * @example
 * ```ts
 * readTask({ taskId: "t1", state: "completed", resultUrls: ["https://r2/a.mp4"] }).resultUrl; // => "https://r2/a.mp4"
 * ```
 */
export function readTask(data: unknown): TaskStatus {
  const retryable = readField(data, "retryable");
  return {
    taskId: readString(data, "taskId"),
    state: readString(data, "state"),
    resultUrl: firstString(readField(data, "resultUrls")),
    failCode: readString(data, "failCode"),
    failMsg: readString(data, "failMsg"),
    retryable: typeof retryable === "boolean" ? retryable : undefined
  };
}

/**
 * The real charge of a task from `GET /records/<taskId>`: its credits, when
 * the charge is settled, in USD, and a number.
 *
 * @param data - The records envelope's `data`.
 * @returns USD charged, or undefined when the charge cannot be used.
 * @example
 * ```ts
 * readChargeUsd({ settled: true, credits: 2.16, currency: "USD" }); // => 2.16
 * ```
 */
export function readChargeUsd(data: unknown): number | undefined {
  const credits = readField(data, "credits");
  const isSettled = readField(data, "settled") === true;
  const isUsd = readString(data, "currency") === USD;
  const isAmount = typeof credits === "number" && Number.isFinite(credits);
  return isSettled && isUsd && isAmount ? credits : undefined;
}
