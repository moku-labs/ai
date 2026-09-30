/**
 * @file ark final from a draft — `request.fromDraft` names a draft clip, and
 * the final re-renders that draft task at 1080p. Ark reuses the draft's
 * prompt, frames, duration, ratio, seed and audio, so the body carries only
 * the draft task id: the final never reads `prompt`, `seconds`, `aspect`,
 * `audio` or `negative`. Every check runs before any call and throws a plain
 * two-line error: terminal after one attempt, nothing billed.
 */
import type { VideoFile } from "../../video/contract";
import type { ArkVideoModel } from "../models";
import type { ArkContext, EstimateRequest } from "../types";
import type { ArkContentItem } from "./body";
import { isArkParameter, unknownParameterError } from "./body";
import type { DraftRecord } from "./draft";
import { DRAFT_TTL_MS, FINAL_RESOLUTION, findDraft } from "./draft";

/**
 * A `params` key a final passes through to ark as given.
 *
 * @example
 * ```ts
 * const key: FinalPassthroughKey = "return_last_frame";
 * ```
 */
export type FinalPassthroughKey =
  | "watermark"
  | "return_last_frame"
  | "execution_expires_after"
  | "priority";

/**
 * The passthrough params of a final. Values go to ark as given: ark validates them.
 *
 * @example
 * ```ts
 * const params: FinalPassthrough = { watermark: true, priority: 1 };
 * ```
 */
export type FinalPassthrough = Partial<Record<FinalPassthroughKey, unknown>>;

/**
 * A final request checked, with defaults applied.
 *
 * @example
 * ```ts
 * const checked: CheckedFinalRequest = { resolution: "1080p", params: {} };
 * ```
 */
export type CheckedFinalRequest = {
  /** Always 1080p. */
  resolution: string;
  /** The passthrough params. */
  params: FinalPassthrough;
};

/**
 * The task body of a final from a draft.
 *
 * @example
 * ```ts
 * const body: ArkFinalBody = {
 *   model: "dreamina-seedance-2-5-260628",
 *   content: [{ type: "draft_task", draft_task: { id: "cgt-20260930171041-8mowm" } }],
 *   resolution: "1080p", watermark: false
 * };
 * ```
 */
export type ArkFinalBody = FinalPassthrough & {
  /** Ark model id: the draft's model. */
  model: string;
  /** Only the draft task entry. */
  content: ArkContentItem[];
  /** Always 1080p. */
  resolution: string;
};

/**
 * The parts of a request a final checks: they may still be build-file
 * references at estimate time.
 *
 * @example
 * ```ts
 * const shape: FinalShape = { params: { watermark: true } };
 * ```
 */
export type FinalShape = Pick<
  EstimateRequest,
  "image" | "endImage" | "refs" | "params" | "resolution"
>;

/** The error for a `fromDraft` that is not a video. */
const NOT_A_VIDEO_ERROR =
  "[ai] ark input.fromDraft must be the draft's video.\n  Point $ref at the draft item.";

/** The error for a final whose draft clip has no draft record. */
const NO_DRAFT_ERROR =
  "[ai] ark has no draft task for input.fromDraft.\n  Make the draft with provider ark and params.draft: true, in this project.";

/** The error for a final at a resolution other than 1080p. */
const FINAL_RESOLUTION_ERROR =
  "[ai] ark finals from a draft are 1080p only.\n  Remove input.resolution or set it to 1080p.";

/** The error for a final while the journal is closed. */
const JOURNAL_CLOSED_ERROR =
  "[ai] ark needs the journal to find a draft.\n  Call app.start() first.";

/**
 * The error for a field a final must not carry.
 *
 * @param field - The field, as written in the build file.
 * @returns The plain two-line error.
 * @example
 * ```ts
 * onlyDraftError("input.image").message; // => "[ai] ark final renders take only the draft.\n  Remove input.image."
 * ```
 */
function onlyDraftError(field: string): Error {
  return new Error(`[ai] ark final renders take only the draft.\n  Remove ${field}.`);
}

/**
 * Refuses a `fromDraft` that is not a video file (`video/*`).
 *
 * @param file - `request.fromDraft`, resolved.
 * @throws {Error} A plain two-line error for another file.
 * @example
 * ```ts
 * checkDraftFile({ path: "key.png", mimeType: "image/png", hash: "h" });
 * // throws: "[ai] ark input.fromDraft must be the draft's video.\n  Point $ref at the draft item."
 * ```
 */
export function checkDraftFile(file: VideoFile): void {
  if (!file.mimeType.startsWith("video/")) throw new Error(NOT_A_VIDEO_ERROR);
}

/**
 * Refuses the inputs a final cannot carry: its frames and refs come from the draft.
 *
 * @param request - The request, files resolved or not.
 * @throws {Error} A plain two-line error naming the first such input.
 * @example
 * ```ts
 * checkFinalInputs({ refs: [] }); // passes: an empty list is no refs
 * ```
 */
function checkFinalInputs(request: FinalShape): void {
  if (request.image !== undefined) throw onlyDraftError("input.image");
  if (request.endImage !== undefined) throw onlyDraftError("input.endImage");
  if ((request.refs?.length ?? 0) > 0) throw onlyDraftError("input.refs");
}

/**
 * Checks a final's `params`: the allowlist, no `refUrls`, `seed` or `draft`
 * (they belong to the draft), and `generation` is never sent.
 *
 * @param params - `request.params`.
 * @returns The passthrough params.
 * @throws {Error} A plain two-line error for an unknown or a refused key.
 * @example
 * ```ts
 * checkFinalParameters({ watermark: true, generation: 2 }); // => { watermark: true }
 * ```
 */
function checkFinalParameters(params: Record<string, unknown>): FinalPassthrough {
  const passthrough: FinalPassthrough = {};
  for (const [key, value] of Object.entries(params)) {
    if (!isArkParameter(key)) throw unknownParameterError(key);
    const isDraftOnly = key === "refUrls" || key === "seed" || key === "draft";
    if (isDraftOnly) throw onlyDraftError(`params.${key}`);
    if (key === "generation") continue;
    passthrough[key] = value;
  }
  return passthrough;
}

/**
 * Checks a final with no I/O: no frames, refs, `refUrls`, `seed` or `draft`;
 * known params only; 1080p (the default). Works on an estimate request too.
 *
 * @param request - The request, files resolved or not.
 * @returns The checked final.
 * @throws {Error} The first broken rule, as a plain two-line error.
 * @example
 * ```ts
 * checkFinalRequest({ params: { watermark: true } }); // => { resolution: "1080p", params: { watermark: true } }
 * ```
 */
export function checkFinalRequest(request: FinalShape): CheckedFinalRequest {
  checkFinalInputs(request);
  const params = checkFinalParameters(request.params ?? {});
  const resolution = request.resolution ?? FINAL_RESOLUTION;
  if (resolution !== FINAL_RESOLUTION) throw new Error(FINAL_RESOLUTION_ERROR);
  return { resolution, params };
}

/**
 * Finds the draft task of a final and checks it: the journal is open, the
 * draft clip has a record, it was made with the request's model, and it is
 * less than 7 days old.
 *
 * @param ctx - Plugin context (config, env, journal).
 * @param model - The request's catalog row.
 * @param hash - `fromDraft.hash`: the sha256 of the draft clip.
 * @returns The draft record.
 * @throws {Error} A plain two-line error for each broken rule.
 */
export function resolveDraft(ctx: ArkContext, model: ArkVideoModel, hash: string): DraftRecord {
  if (!ctx.journal.isOpen()) throw new Error(JOURNAL_CLOSED_ERROR);

  const draft = findDraft(ctx, hash);
  if (draft === undefined) throw new Error(NO_DRAFT_ERROR);
  if (draft.model !== model.id) {
    throw new Error(
      `[ai] Draft ${draft.taskId} was made with ${draft.model}.\n  Set input.model to ${draft.model}.`
    );
  }

  const expiresAt = draft.createdAt + DRAFT_TTL_MS;
  if (Date.now() >= expiresAt) {
    const on = new Date(expiresAt).toISOString();
    throw new Error(
      `[ai] ark draft ${draft.taskId} expired on ${on}.\n  Bump params.generation on the draft item to render it again.`
    );
  }
  return draft;
}

/**
 * Assembles the body of a final: the draft task, 1080p, `watermark` false by
 * default, then the passthrough params.
 *
 * @param model - The catalog row.
 * @param taskId - The draft task id.
 * @param checked - The checked final.
 * @returns The body.
 * @example
 * ```ts
 * buildFinalBody(resolveArkModel("dreamina-seedance-2-5-260628", "intl"), "cgt-1", { resolution: "1080p", params: {} });
 * // => { model: "dreamina-seedance-2-5-260628", content: [{ type: "draft_task", draft_task: { id: "cgt-1" } }], resolution: "1080p", watermark: false }
 * ```
 */
export function buildFinalBody(
  model: ArkVideoModel,
  taskId: string,
  checked: CheckedFinalRequest
): ArkFinalBody {
  return {
    model: model.id,
    content: [{ type: "draft_task", draft_task: { id: taskId } }],
    resolution: checked.resolution,
    watermark: false,
    ...checked.params
  };
}
