/**
 * @file asset capability contract — task-owned; providers implement this.
 *
 * Self-contained by design (spec/07 — "small structural duplication across
 * task contracts is the ratified price of true task ownership"): it imports
 * nothing, not even `VideoFile`, and never imports `./index`, so a provider
 * importing it gets no value edge to the plugin instance. Provider plugins
 * type-import `AssetHandler` and value-import `ASSET_MIME`,
 * `encodeAssetRecord` and `parseAssetRecord` from `"../asset/contract"`.
 */

/**
 * MIME of a stored `AssetRecord` artifact. A `$ref` resolved with this MIME
 * is a registered asset, not an image: its bytes are the record's JSON.
 *
 * @example
 * ```ts
 * // A video provider tells an asset ref from an image ref by MIME.
 * const assets = (request.refs ?? []).filter(file => file.mimeType === ASSET_MIME);
 * ```
 */
export const ASSET_MIME = "application/vnd.moku.asset+json";

/**
 * A resolved input file: store or source path, MIME type and content sha256.
 * Same shape as the runner's `ResolvedFile`.
 *
 * @example
 * ```ts
 * const image: AssetFile = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
 * ```
 */
export type AssetFile = {
  /** Absolute or project-relative path to the file bytes. */
  path: string;
  /** MIME type of the file (e.g. "image/png"). */
  mimeType: string;
  /** Content sha256 of the file bytes. */
  hash: string;
};

/**
 * Asset group kind. v1 has only `"aigc"` (virtual portraits); `"liveness"`
 * is a non-goal.
 *
 * @example
 * ```ts
 * const group: AssetGroupKind = "aigc";
 * ```
 */
export type AssetGroupKind = "aigc";

/**
 * One portrait to register with a provider, in the provider's own account.
 *
 * @example
 * ```ts
 * const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };
 * const request: AssetRequest = { image, url: "https://cdn.example/mira.png", name: "mira" };
 * ```
 */
export type AssetRequest = {
  /** The portrait file. Its sha256 `hash` is part of the artifact key, so the same bytes register once. */
  image: AssetFile;
  /**
   * Public https URL of the same bytes, for providers whose register API only
   * fetches URLs (Ark CreateAsset). A provider that needs it and gets none
   * fails terminally before any call.
   */
  url?: string;
  /** Group kind. Default "aigc". */
  group?: AssetGroupKind;
  /** Display name sent to the provider (max 64 chars). Default: the file's base name. */
  name?: string;
  /** Asset group name (1–64 characters). Default: the provider's configured group name. */
  groupName?: string;
  /**
   * Free provider params. `generation` (number) is the documented re-register
   * knob: bumping it changes the artifact key.
   */
  params?: Record<string, unknown>;
};

/**
 * The opaque result of a registration, stored as the asset item's artifact
 * (MIME `ASSET_MIME`). The asset id is valid only in `account`.
 *
 * @example
 * ```ts
 * const record: AssetRecord = {
 *   assetId: "asset-20260929-a1", provider: "ark", account: "3f9a0c1b2d4e",
 *   groupId: "group-7", registeredAt: 1790000000000
 * };
 * ```
 */
export type AssetRecord = {
  /** Provider asset id; the video provider sends it as `asset://<assetId>`. */
  assetId: string;
  /** Provider that registered it, e.g. "ark". */
  provider: string;
  /** Provider-computed, non-reversible account fingerprint. The id is valid only in this account. */
  account: string;
  /** Provider group id the asset lives in. */
  groupId: string;
  /** Epoch ms when the provider reported the asset Active. */
  registeredAt: number;
};

/**
 * Result of one registration, in the runner's handler-result shape so the
 * runner stores it as is: `body` is `encodeAssetRecord(record)`. The facade
 * reads the record back with `parseAssetRecord(body)`.
 *
 * @example
 * ```ts
 * const result: AssetResult = { body: encodeAssetRecord(record), mimeType: ASSET_MIME, costUsd: 0 };
 * ```
 */
export type AssetResult = {
  /** The encoded `AssetRecord` bytes. */
  body: Uint8Array;
  /** Always `ASSET_MIME`. */
  mimeType: typeof ASSET_MIME;
  /** Actual cost of the registration, in US dollars. */
  costUsd: number;
  /** Metadata only: the asset id and account fingerprint. */
  meta?: { assetId: string; account: string };
};

/**
 * One poll of an async registration: still running, done with the record,
 * or failed. A refusal (moderation, face mismatch) is `failed` with an error
 * carrying `kind: "content-policy"`, so the runner flags the item.
 *
 * @example
 * ```ts
 * const pending: AssetJobPoll = { state: "pending" };
 * const refused: AssetJobPoll = { state: "failed", error: Object.assign(new Error("refused"), { kind: "content-policy" }) };
 * ```
 */
export type AssetJobPoll =
  | { state: "pending" }
  | ({ state: "done" } & AssetResult)
  | { state: "failed"; error: unknown };

/**
 * The capability contract an asset provider registers under task `"asset"`.
 * Registration is async upstream, so a handler has `estimate` plus the job
 * pair `submit` + `poll`; there is no `execute`.
 *
 * @example
 * ```ts
 * const handler: AssetHandler = {
 *   estimate: () => ({ usd: 0 }),
 *   submit: async request => ({ jobId: await createAsset(request) }),
 *   poll: async jobId => ((await getAsset(jobId)).active ? done(jobId) : { state: "pending" })
 * };
 * ```
 */
export type AssetHandler = {
  /**
   * Estimates the cost of `request` without registering it.
   *
   * @param request - The request to estimate.
   * @returns The estimated cost in US dollars.
   */
  estimate(request: AssetRequest): { usd: number };
  /**
   * Starts the registration upstream.
   *
   * @param request - The portrait to register.
   * @param opts - Submission options.
   * @param opts.signal - Abort signal for cancelling the submission call.
   * @returns The provider job id.
   */
  submit(request: AssetRequest, opts: { signal?: AbortSignal }): Promise<{ jobId: string }>;
  /**
   * Polls a submitted registration once.
   *
   * @param jobId - The id returned by `submit`.
   * @param request - The request the job was submitted with.
   * @param opts - Poll options.
   * @param opts.signal - Abort signal for cancelling the poll call.
   * @returns The job state: pending, done with the record, or failed.
   */
  poll(jobId: string, request: AssetRequest, opts: { signal?: AbortSignal }): Promise<AssetJobPoll>;
};

/**
 * Serialises a record into the artifact bytes: UTF-8 JSON with a stable key
 * order (assetId, provider, account, groupId, registeredAt), extra keys dropped.
 *
 * @param record - The record to store.
 * @returns The artifact bytes.
 * @example
 * ```ts
 * encodeAssetRecord({ assetId: "a1", provider: "ark", account: "3f9a", groupId: "g7", registeredAt: 1 }); // => UTF-8 of {"assetId":"a1",...}
 * ```
 */
export function encodeAssetRecord(record: AssetRecord): Uint8Array {
  const ordered: AssetRecord = {
    assetId: record.assetId,
    provider: record.provider,
    account: record.account,
    groupId: record.groupId,
    registeredAt: record.registeredAt
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Builds the pinned two-line "not an asset record" error.
 *
 * @param reason - What is wrong with the bytes.
 * @returns The error.
 * @example
 * ```ts
 * notARecordError("invalid JSON").message; // => "[ai] Not an asset record: invalid JSON.\n  Expected JSON with ..."
 * ```
 */
function notARecordError(reason: string): Error {
  return new Error(
    `[ai] Not an asset record: ${reason}.\n  Expected JSON with assetId, provider, account, groupId, registeredAt.`
  );
}

/**
 * Parses artifact bytes as JSON, or throws the pinned error.
 *
 * @param bytes - The artifact bytes.
 * @returns The parsed JSON value.
 * @throws {Error} `[ai] Not an asset record: invalid JSON.` when the bytes are not JSON.
 * @example
 * ```ts
 * parseJson(new TextEncoder().encode("{}")); // => {}
 * ```
 */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw notARecordError("invalid JSON");
  }
}

/**
 * Checks that a parsed JSON value is a plain object (not an array, not null).
 *
 * @param value - The parsed JSON value.
 * @returns True when `value` is a JSON object.
 * @example
 * ```ts
 * isJsonObject([1, 2]); // => false
 * ```
 */
function isJsonObject(value: unknown): value is Partial<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one required non-empty string field.
 *
 * @param json - The parsed object.
 * @param key - The field name.
 * @returns The field value.
 * @throws {Error} The pinned error when the field is missing or not a non-empty string.
 * @example
 * ```ts
 * readString({ assetId: "a1" }, "assetId"); // => "a1"
 * ```
 */
function readString(json: Partial<Record<string, unknown>>, key: string): string {
  const value = json[key];
  if (value === undefined) throw notARecordError(`missing "${key}"`);
  if (typeof value !== "string" || value === "") {
    throw notARecordError(`"${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Reads the required `registeredAt` epoch-ms field.
 *
 * @param json - The parsed object.
 * @returns The timestamp.
 * @throws {Error} The pinned error when it is missing or not a finite number.
 * @example
 * ```ts
 * readRegisteredAt({ registeredAt: 1790000000000 }); // => 1790000000000
 * ```
 */
function readRegisteredAt(json: Partial<Record<string, unknown>>): number {
  const value = json.registeredAt;
  if (value === undefined) throw notARecordError('missing "registeredAt"');
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw notARecordError('"registeredAt" must be a finite number');
  }
  return value;
}

/**
 * Parses artifact bytes back into a record. Extra keys are dropped.
 *
 * @param bytes - The stored artifact bytes (e.g. a `$ref` file with MIME `ASSET_MIME`).
 * @returns The record.
 * @throws {Error} `[ai] Not an asset record: <reason>.\n  Expected JSON with assetId, provider, account, groupId, registeredAt.`
 * @example
 * ```ts
 * // A video provider reads the asset a $ref resolved to.
 * const { assetId } = parseAssetRecord(await readFile(ref.path)); // => "asset-20260929-a1"
 * ```
 */
export function parseAssetRecord(bytes: Uint8Array): AssetRecord {
  const json = parseJson(bytes);
  if (!isJsonObject(json)) throw notARecordError("not a JSON object");

  // Fields are read in record order, so the first missing one is the one reported.
  return {
    assetId: readString(json, "assetId"),
    provider: readString(json, "provider"),
    account: readString(json, "account"),
    groupId: readString(json, "groupId"),
    registeredAt: readRegisteredAt(json)
  };
}
