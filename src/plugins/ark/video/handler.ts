/**
 * @file ark video handler — implements the task-owned contract
 * (`../../video/contract.ts`) over the Ark video task API. `submit` checks the
 * request, checks every asset ref (the asset preflight), then POSTs the task;
 * `poll` reads the task once and, on success, downloads the clip right away:
 * its URL expires 24 h after success. There is no `execute`: the runner and
 * the `video` facade both drive `submit` + `poll`, so a task id is journaled
 * and never submitted twice. Estimate and actual cost share `../prices.ts`.
 */
import type { AssetRecord } from "../../asset/contract";
import type { VideoHandler, VideoJobPoll, VideoRequest } from "../../video/contract";
import { ownAccount } from "../account";
import { getAsset } from "../asset/handler";
import {
  arkFetch,
  flaggedError,
  readField,
  readJson,
  readNumber,
  readString,
  shorten,
  unreadableResponse
} from "../client";
import { FlaggedProviderError, TerminalProviderError } from "../errors";
import { DEFAULT_RESOLUTION, DEFAULT_SECONDS, resolveArkModel } from "../models";
import { costUsd, estimateTokens, estimateUsd } from "../prices";
import { dataPlaneUrl } from "../regions";
import type { ArkContext } from "../types";
import {
  assetRecordsOf,
  buildArkBody,
  checkVideoRequest,
  hasLocalImage,
  hasVideoReferenceUrl,
  readInputs,
  warnNegativeOnce
} from "./body";

/** The ark video handler: the async form of the contract (no `execute`). */
export type ArkVideoHandler = Required<Pick<VideoHandler, "estimate" | "submit" | "poll">>;

/** Data-plane path of the video task API. */
const TASKS_PATH = "/contents/generations/tasks";

/** Task statuses while ark is still working. */
const PENDING_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

/** Task status of a task whose clip is ready. */
const SUCCEEDED_STATUS = "succeeded";

/** Task status of a task that ended with an error. */
const FAILED_STATUS = "failed";

/** Task statuses of a task ark stopped without a result. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(["expired", "cancelled"]);

/** MIME type of every Seedance clip. */
const VIDEO_MIME = "video/mp4";

/** The one pending poll value. */
const PENDING: VideoJobPoll = { state: "pending" };

/** Log event for a task that ended with an error. */
const FAILED_EVENT = "ark:video:failed";

/** Status of an asset ref from another provider or account: the request is wrong. */
const FOREIGN_ASSET_STATUS = 400;

/** Status of an asset ref that is not Active: its state conflicts with use. */
const INACTIVE_ASSET_STATUS = 409;

/** Status of a task that failed with a non-refusal error. */
const FAILED_TASK_STATUS = 400;

/** Status of an expired or cancelled task. */
const ENDED_TASK_STATUS = 410;

/**
 * The data-plane headers: Bearer API key and a JSON body.
 *
 * @param apiKey - The Ark API key.
 * @returns Header record.
 * @example
 * ```ts
 * bearerHeaders("k").Authorization; // => "Bearer k"
 * ```
 */
function bearerHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/**
 * Refuses an asset ref registered by another provider or another account.
 * A local check: it costs no call.
 *
 * @param record - The asset record a `$ref` resolved to.
 * @param account - This instance's account fingerprint.
 * @throws {TerminalProviderError} With status 400.
 * @example
 * ```ts
 * checkAssetOwner({ assetId: "a1", provider: "apimodels", account: "x", groupId: "g", registeredAt: 1 }, "x");
 * // throws: '[ai] Asset "a1" was registered by "apimodels", not ark.\n  Register the portrait with provider ark.'
 * ```
 */
function checkAssetOwner(record: AssetRecord, account: string): void {
  if (record.provider !== "ark") {
    throw new TerminalProviderError(
      `[ai] Asset "${record.assetId}" was registered by "${record.provider}", not ark.\n  Register the portrait with provider ark.`,
      FOREIGN_ASSET_STATUS
    );
  }
  if (record.account !== account) {
    throw new TerminalProviderError(
      `[ai] Asset "${record.assetId}" belongs to another ark account.\n  Register the portrait again with this account's keys.`,
      FOREIGN_ASSET_STATUS
    );
  }
}

/**
 * The asset preflight: every asset ref must be ark's, of this account, and
 * Active. Owner checks run first and cost nothing; then one `GetAsset` per
 * asset not yet seen Active in this process. Nothing is POSTed unless every
 * check passes, so no money is spent on a bad asset.
 *
 * @param ctx - Plugin context (config, state, env).
 * @param records - The asset records of the request.
 * @param signal - Caller abort signal.
 * @throws {TerminalProviderError} For a foreign or non-Active asset.
 */
async function preflightAssets(
  ctx: ArkContext,
  records: readonly AssetRecord[],
  signal: AbortSignal | undefined
): Promise<void> {
  if (records.length === 0) return;

  // Owner checks first: a foreign asset costs no call.
  const account = ownAccount(ctx);
  for (const record of records) checkAssetOwner(record, account);

  // One GetAsset per asset, cached for the process once Active.
  for (const record of records) {
    if (ctx.state.activeAssets.has(record.assetId)) continue;
    const { status } = await getAsset(ctx, record.assetId, signal);
    if (status !== "Active") {
      throw new TerminalProviderError(
        `[ai] ark asset "${record.assetId}" is ${status ?? "unknown"}.\n  Bump params.generation on its asset item to register again.`,
        INACTIVE_ASSET_STATUS
      );
    }
    ctx.state.activeAssets.add(record.assetId);
  }
}

/**
 * Checks the request, reads its inputs, runs the asset preflight, then POSTs
 * the task. The API key is read through `ctx.env` (MC3).
 *
 * @param ctx - Plugin context.
 * @param request - The video request.
 * @param signal - Caller abort signal.
 * @returns The task id as the job id.
 */
async function submitTask(
  ctx: ArkContext,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<{ jobId: string }> {
  // Refuse what the model cannot take, before any read or call.
  const model = resolveArkModel(request.model, ctx.config.region);
  const checked = checkVideoRequest(model, request);
  const apiKey = ctx.env.require(ctx.config.apiKeyEnv);

  // Read the inputs, then check every asset before the paid call.
  const inputs = await readInputs(request);
  await preflightAssets(ctx, assetRecordsOf(inputs), signal);
  warnNegativeOnce(ctx, request);

  // Once the POST is sent ark may bill it: an abort now would lose the task id, so it runs to the end.
  signal?.throwIfAborted();
  const response = await arkFetch(
    `${dataPlaneUrl(ctx.config)}${TASKS_PATH}`,
    {
      method: "POST",
      headers: bearerHeaders(apiKey),
      body: JSON.stringify(buildArkBody(model, request.prompt, checked, inputs))
    },
    { timeoutMs: ctx.config.timeoutMs, label: TASKS_PATH, localImage: hasLocalImage(request) }
  );

  // No id means the task may exist: fail without a retry, so it is never paid for twice.
  const taskId = readString(readJson(response), "id");
  if (taskId === undefined) {
    throw new Error(
      "[ai] ark returned no task id.\n  Check the task list in the console before running again."
    );
  }
  ctx.log.info("ark:video:submitted", { model: model.id, taskId });
  return { jobId: taskId };
}

/**
 * The failed poll of a task, logged with redacted fields only.
 *
 * @param ctx - Plugin context (log).
 * @param taskId - The task id.
 * @param error - The classified error.
 * @param code - ark's error code, if any.
 * @returns The failed poll.
 */
function failedPoll(
  ctx: ArkContext,
  taskId: string,
  error: FlaggedProviderError | TerminalProviderError,
  code?: string
): VideoJobPoll {
  const errorType = error instanceof FlaggedProviderError ? "flagged" : "terminal";
  const fields = { taskId, errorType, code };
  ctx.log.warn(
    FAILED_EVENT,
    error instanceof TerminalProviderError ? { ...fields, status: error.status } : fields
  );
  return { state: "failed", error };
}

/**
 * Classifies a `failed` task: a SensitiveContent code is flagged (with the
 * face hint when the request has a plain local image), anything else is
 * terminal and carries ark's code and message.
 *
 * @param ctx - Plugin context (log).
 * @param taskId - The task id.
 * @param task - The task body.
 * @param request - The request the task was submitted with.
 * @returns The failed poll.
 */
function taskFailed(
  ctx: ArkContext,
  taskId: string,
  task: unknown,
  request: VideoRequest
): VideoJobPoll {
  const error = readField(task, "error");
  const code = readString(error, "code");
  if (code?.includes("SensitiveContent")) {
    return failedPoll(ctx, taskId, flaggedError(code, hasLocalImage(request)), code);
  }

  const message = shorten(readString(error, "message"));
  const suffix = message === undefined ? "" : `: ${message}`;
  const terminal = new TerminalProviderError(
    `[ai] ark task ${taskId} failed (${code ?? "error"})${suffix}.`,
    FAILED_TASK_STATUS,
    code
  );
  return failedPoll(ctx, taskId, terminal, code);
}

/**
 * Fails an expired or cancelled task as terminal 410: only a new task can
 * produce the clip.
 *
 * @param ctx - Plugin context (log).
 * @param taskId - The task id.
 * @param status - The ended status (`expired` or `cancelled`).
 * @returns The failed poll.
 */
function endedPoll(ctx: ArkContext, taskId: string, status: string): VideoJobPoll {
  const ended = new TerminalProviderError(
    `[ai] ark task ${taskId} is ${status}.\n  Run the item again to submit a new task.`,
    ENDED_TASK_STATUS
  );
  return failedPoll(ctx, taskId, ended);
}

/**
 * Downloads a succeeded task's clip (without the key) and prices it from the
 * completion tokens; the request's values fill in what the task body lacks.
 *
 * @param ctx - Plugin context.
 * @param taskId - The task id.
 * @param task - The task body.
 * @param request - The request the task was submitted with.
 * @param signal - Caller abort signal.
 * @returns The done poll.
 * @throws {RetryableProviderError} 502 when the body has no `content.video_url`.
 */
async function downloadClip(
  ctx: ArkContext,
  taskId: string,
  task: unknown,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<VideoJobPoll> {
  const content = readField(task, "content");
  const videoUrl = readString(content, "video_url");
  if (videoUrl === undefined) throw unreadableResponse(`${TASKS_PATH}/${taskId}`);

  // The clip URL expires 24 h after success: fetch it now, without the key.
  const download = await arkFetch(
    videoUrl,
    { method: "GET" },
    { timeoutMs: ctx.config.timeoutMs, signal, label: "video download" }
  );

  // Price the completion tokens; fall back to the estimate when ark sent none.
  const model = resolveArkModel(request.model, ctx.config.region);
  const seconds = readNumber(task, "duration") ?? request.seconds ?? DEFAULT_SECONDS;
  const resolution = readString(task, "resolution") ?? request.resolution ?? DEFAULT_RESOLUTION;
  const completionTokens =
    readNumber(readField(task, "usage"), "completion_tokens") ??
    estimateTokens(resolution, seconds);
  const lastFrameUrl = readString(content, "last_frame_url");

  ctx.log.info("ark:video:done", { taskId, bytes: download.body.length });
  return {
    state: "done",
    video: download.body,
    mimeType: VIDEO_MIME,
    costUsd: costUsd(ctx.config, model, completionTokens, hasVideoReferenceUrl(request)),
    meta: {
      taskId,
      model: model.id,
      seconds,
      resolution,
      completionTokens,
      ...(lastFrameUrl === undefined ? {} : { lastFrameUrl })
    }
  };
}

/**
 * Polls a task once: pending while queued or running, done with the clip,
 * failed (flagged or terminal), or failed 410 when expired or cancelled.
 * Every error it throws carries a status or a kind.
 *
 * @param ctx - Plugin context.
 * @param taskId - The id `submit` returned.
 * @param request - The request the task was submitted with.
 * @param signal - Caller abort signal.
 * @returns The poll result.
 */
async function pollTask(
  ctx: ArkContext,
  taskId: string,
  request: VideoRequest,
  signal: AbortSignal | undefined
): Promise<VideoJobPoll> {
  // Read the task once.
  const apiKey = ctx.env.require(ctx.config.apiKeyEnv);
  const taskPath = `${TASKS_PATH}/${encodeURIComponent(taskId)}`;
  const response = await arkFetch(
    `${dataPlaneUrl(ctx.config)}${taskPath}`,
    { method: "GET", headers: bearerHeaders(apiKey) },
    { timeoutMs: ctx.config.timeoutMs, signal, label: taskPath }
  );
  const task = readJson(response);
  const status = readString(task, "status");
  if (status === undefined) throw unreadableResponse(taskPath);

  // Map the status.
  if (PENDING_STATUSES.has(status)) return PENDING;
  if (status === SUCCEEDED_STATUS) return downloadClip(ctx, taskId, task, request, signal);
  if (status === FAILED_STATUS) return taskFailed(ctx, taskId, task, request);
  if (ENDED_STATUSES.has(status)) return endedPoll(ctx, taskId, status);
  ctx.log.warn("ark:poll:unknown-status", { taskId, status });
  return PENDING;
}

/**
 * Creates the ark video handler registered under `("video", "ark")`.
 * `estimate` touches no network and never reads a file: it checks model,
 * region, seconds and resolution with the submit errors, then prices the
 * estimated tokens at the base price. `submit` refuses a bad request or a bad
 * asset before the POST; once the POST is sent it runs to the end, so a
 * billed task always returns its id.
 *
 * @param ctx - Plugin context (config, state, env, log).
 * @returns The handler: estimate, submit and poll.
 */
export function createVideoHandler(ctx: ArkContext): ArkVideoHandler {
  return {
    estimate: (request: VideoRequest): { usd: number } => {
      const model = resolveArkModel(request.model, ctx.config.region);
      return { usd: estimateUsd(ctx.config, model, request) };
    },
    submit: (request: VideoRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }> =>
      submitTask(ctx, request, opts.signal),
    poll: (
      jobId: string,
      request: VideoRequest,
      opts: { signal?: AbortSignal }
    ): Promise<VideoJobPoll> => pollTask(ctx, jobId, request, opts.signal)
  };
}
