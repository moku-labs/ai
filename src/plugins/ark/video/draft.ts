/**
 * @file ark draft mode — a Seedance 2.5 draft is a cheap 480p render
 * (`params.draft: true`); a final re-renders it at 1080p from the draft task
 * alone. This module checks the draft flag (pure) and keeps the draft record:
 * when a draft task succeeds, its task id, model, seed, creation time and
 * whether its request had a reference video go into the journal's
 * `provider_records`, keyed by the sha256 of the clip bytes. That is the hash
 * the store gives the artifact, so a final that `$ref`s the draft item
 * (`fromDraft.hash`) finds its task. Ark bills a final by the draft's video
 * input, so the final's price reads it from this record.
 */
import { createHash } from "node:crypto";
import { apiAccountOf, isSet } from "../account";
import { readField, readNumber, readString } from "../client";
import type { ArkVideoModel } from "../models";
import { arkModels } from "../models";
import type { ArkContext, ArkDraftRecord, ArkRegion, EstimateRequest } from "../types";

/**
 * The only resolution of a draft render.
 *
 * @example
 * ```ts
 * DRAFT_RESOLUTION; // => "480p"
 * ```
 */
export const DRAFT_RESOLUTION = "480p";

/**
 * The only resolution of a final rendered from a draft.
 *
 * @example
 * ```ts
 * FINAL_RESOLUTION; // => "1080p"
 * ```
 */
export const FINAL_RESOLUTION = "1080p";

/**
 * How long ark keeps a draft task id valid, from its creation: 7 days, ms.
 *
 * @example
 * ```ts
 * DRAFT_TTL_MS; // => 604800000
 * ```
 */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Provider of the draft records in the journal. */
const PROVIDER = "ark";

/** Kind of the draft records in the journal. */
const DRAFT_KIND = "draft";

/** Milliseconds in a second: ark sends `created_at` in seconds. */
const MS_PER_SECOND = 1000;

/** The error for a `params.draft` other than `true`. */
const DRAFT_VALUE_ERROR =
  "[ai] ark params.draft takes only true.\n  Remove params.draft for a full render.";

/** The error for a draft at a resolution other than 480p. */
const DRAFT_RESOLUTION_ERROR =
  "[ai] ark drafts are 480p only.\n  Remove input.resolution or set it to 480p.";

/**
 * The first model of a region with a draft mode, for the hint.
 *
 * @param region - The Ark region.
 * @returns A model id, or a plain description when the region has none.
 * @example
 * ```ts
 * draftModelOf("intl"); // => "dreamina-seedance-2-5-260628"
 * ```
 */
export function draftModelOf(region: ArkRegion): string {
  const model = arkModels.find(row => row.region === region && row.supportsDraft);
  return model?.id ?? "a Seedance 2.5 model";
}

/**
 * Checks `params.draft`: absent is a normal render; `true` is a draft, on a
 * model with a draft mode, at 480p (the default when `resolution` is absent).
 *
 * @param model - The catalog row.
 * @param request - The request, files resolved or not.
 * @returns True for a draft render.
 * @throws {Error} A plain two-line error for another value, a model without drafts or another resolution.
 * @example
 * ```ts
 * checkDraftMode(resolveArkModel("dreamina-seedance-2-5-260628", "intl"), { params: { draft: true } }); // => true
 * ```
 */
export function checkDraftMode(
  model: ArkVideoModel,
  request: Pick<EstimateRequest, "params" | "resolution">
): boolean {
  const value = request.params?.draft;
  if (value === undefined) return false;
  if (value !== true) throw new Error(DRAFT_VALUE_ERROR);

  if (!model.supportsDraft) {
    throw new Error(
      `[ai] Model ${model.id} has no draft mode.\n  Use ${draftModelOf(model.region)} for drafts.`
    );
  }
  const isDraftResolution =
    request.resolution === undefined || request.resolution === DRAFT_RESOLUTION;
  if (!isDraftResolution) throw new Error(DRAFT_RESOLUTION_ERROR);
  return true;
}

/**
 * The resolution a request renders at when it names none: 1080p for a final,
 * 480p for a draft, else `fallback` (the catalog default).
 *
 * @param request - The request.
 * @param fallback - The normal default.
 * @returns The default resolution.
 * @example
 * ```ts
 * defaultResolutionOf({ params: { draft: true } }, "720p"); // => "480p"
 * ```
 */
export function defaultResolutionOf(
  request: Pick<EstimateRequest, "params" | "fromDraft">,
  fallback: string
): string {
  if (request.fromDraft !== undefined) return FINAL_RESOLUTION;
  return request.params?.draft === true ? DRAFT_RESOLUTION : fallback;
}

/**
 * The sha256 hex of some bytes: the store's content hash, so the draft
 * record's key equals the draft artifact's hash.
 *
 * @param bytes - The clip bytes.
 * @returns 64 lowercase hex characters.
 * @example
 * ```ts
 * sha256Hex(new Uint8Array()); // => "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
 * ```
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The fingerprint that scopes this instance's draft records: its region and
 * API key, read through `ctx.env` (MC3).
 *
 * @param ctx - Plugin context (config, env).
 * @returns 12 hex characters.
 */
function draftAccount(ctx: ArkContext): string {
  return apiAccountOf(ctx.config.region, ctx.env.require(ctx.config.apiKeyEnv));
}

/**
 * Whether the journal can keep a draft record now. When it is not open (a
 * facade call before `app.start()`), logs `ark:journal:closed` once per process.
 *
 * @param ctx - Plugin context (journal, state, log).
 * @param taskId - The draft task id, for the log.
 * @returns True when the journal is open.
 */
function isJournalUsable(ctx: ArkContext, taskId: string): boolean {
  if (ctx.journal.isOpen()) return true;
  if (!ctx.state.journalSkipLogged) {
    ctx.state.journalSkipLogged = true;
    ctx.log.warn("ark:journal:closed", { taskId });
  }
  return false;
}

/**
 * Keeps a succeeded draft task in the journal, keyed by the sha256 of its
 * clip. Writing the same record again (a re-poll after a crash) is a no-op
 * change. Skipped, with one warning, when the journal is closed: the clip is
 * still returned.
 *
 * @param ctx - Plugin context (config, env, journal, state, log).
 * @param taskId - The draft task id.
 * @param task - The succeeded task body.
 * @param model - The model id the draft was made with.
 * @param clip - The downloaded clip bytes.
 * @param withVideoInput - Whether the draft's request had a reference video.
 */
export function recordDraft(
  ctx: ArkContext,
  taskId: string,
  task: unknown,
  model: string,
  clip: Uint8Array,
  withVideoInput: boolean
): void {
  if (!isJournalUsable(ctx, taskId)) return;

  const createdAtSeconds = readNumber(task, "created_at");
  const record: ArkDraftRecord = {
    taskId,
    model,
    seed: readNumber(task, "seed"),
    createdAt: createdAtSeconds === undefined ? Date.now() : createdAtSeconds * MS_PER_SECOND,
    withVideoInput
  };
  ctx.journal.putProviderRecords([
    {
      provider: PROVIDER,
      account: draftAccount(ctx),
      kind: DRAFT_KIND,
      key: sha256Hex(clip),
      value: JSON.stringify(record)
    }
  ]);
  ctx.log.info("ark:draft:recorded", { taskId });
}

/**
 * Reads a stored draft record, tolerating a damaged one.
 *
 * @param value - The stored JSON text.
 * @returns The record, or undefined when it is not one.
 * @example
 * ```ts
 * parseDraftRecord('{"taskId":"cgt-1","model":"m","createdAt":1}');
 * // => { taskId: "cgt-1", model: "m", seed: undefined, createdAt: 1, withVideoInput: undefined }
 * ```
 */
export function parseDraftRecord(value: string): ArkDraftRecord | undefined {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    return undefined;
  }

  // The required fields: a record without them is damaged.
  const taskId = readString(json, "taskId");
  const model = readString(json, "model");
  const createdAt = readNumber(json, "createdAt");
  if (taskId === undefined || model === undefined || createdAt === undefined) return undefined;

  // A record written before 0.15.3 has no withVideoInput.
  const videoInput = readField(json, "withVideoInput");
  const withVideoInput = typeof videoInput === "boolean" ? videoInput : undefined;
  return { taskId, model, seed: readNumber(json, "seed"), createdAt, withVideoInput };
}

/**
 * Finds the draft task of a draft clip, by the clip's content hash, among
 * this instance's (region and API key) records.
 *
 * @param ctx - Plugin context (config, env, journal).
 * @param hash - `fromDraft.hash`: the sha256 of the draft clip.
 * @returns The record, or undefined when there is none.
 */
export function findDraft(ctx: ArkContext, hash: string): ArkDraftRecord | undefined {
  const value = ctx.journal.findProviderRecord({
    provider: PROVIDER,
    account: draftAccount(ctx),
    kind: DRAFT_KIND,
    key: hash
  });
  return value === undefined ? undefined : parseDraftRecord(value);
}

/**
 * The draft record of a draft clip, for a caller that must not fail:
 * `app.ark.draftRecord(hash)` and the price of a final. Never throws, makes
 * no call and logs nothing. The journal is read only when the API key is set
 * and the journal is open. The age and the model are not checked.
 *
 * @param ctx - Plugin context (config, env, journal).
 * @param hash - `fromDraft.hash`: the sha256 of the draft clip.
 * @returns The record, or undefined: no API key, a closed journal, no record, or a damaged record.
 */
export function draftRecordOf(ctx: ArkContext, hash: string): ArkDraftRecord | undefined {
  if (!isSet(ctx, ctx.config.apiKeyEnv)) return undefined;
  if (!ctx.journal.isOpen()) return undefined;

  return findDraft(ctx, hash);
}

/**
 * Whether the draft of a final had a reference video: the price row ark bills
 * the final at. Never throws and makes no call, so the estimate can use it.
 *
 * @param ctx - Plugin context (config, env, journal).
 * @param hash - `fromDraft.hash`: the sha256 of the draft clip.
 * @returns The draft's `withVideoInput`, or undefined when it is not known: no API key, a closed journal, no record, or a record written before 0.15.3.
 */
export function draftVideoInputOf(ctx: ArkContext, hash: string): boolean | undefined {
  return draftRecordOf(ctx, hash)?.withVideoInput;
}

/**
 * Whether a succeeded task is a draft (`draft: true` in the task body).
 *
 * @param task - The task body.
 * @returns True for a draft task.
 * @example
 * ```ts
 * isDraftTask({ status: "succeeded", draft: true }); // => true
 * ```
 */
export function isDraftTask(task: unknown): boolean {
  return readField(task, "draft") === true;
}
