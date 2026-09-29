/**
 * @file apimodels explicit asset registration. A request names the inputs
 * that become `asset://` ids in `params.assets` (`"image"`, `"endImage"`,
 * `"refs.<n>"`); everything else goes as an https upload. Lookup per named
 * input: `state.assets` → journal provider record → register (upload →
 * group id → `POST /assets`). New ids go to both tiers, the journal in one
 * write per submit. Keys use the `VideoFile.hash` the runner delivered and a
 * non-reversible account fingerprint, never the key. A stale id
 * (`INVALID_INPUT` naming an asset) drops the records so the next attempt
 * registers again, once per request.
 */
import { createHash } from "node:crypto";
import type { ProviderRecord } from "../journal/types";
import type { VideoFile, VideoRequest } from "../video/contract";
import { apiData, readField, withRateLimitWait } from "./client";
import { assetPriceUsd, roundUsd } from "./prices";
import type { ApimodelsContext, EstimateRequest } from "./types";
import { RetryableProviderError, TerminalProviderError } from "./types";
import type { UploadOptions } from "./upload";
import { mapInSlots, SLOTS, uploadFiles } from "./upload";

/**
 * One request input with the selector that names it in `params.assets`.
 *
 * @example
 * ```ts
 * const input: NamedInput = { selector: "refs.0", file: { path: "/s/ben.png", mimeType: "image/png", hash: "b1" } };
 * ```
 */
export type NamedInput = {
  /** `"image"`, `"endImage"` or `"refs.<n>"`. */
  selector: string;
  /** The resolved input. */
  file: VideoFile;
};

/**
 * The `asset://` ids of the named inputs of one submit, and what their new
 * registrations cost.
 *
 * @example
 * ```ts
 * const resolved: ResolvedAssets = { urls: ["asset://asset-1"], assetUsd: 0.01 };
 * ```
 */
export type ResolvedAssets = {
  /** One `asset://` id per named input, in order. */
  urls: string[];
  /** USD of the registrations this submit made (cache hits are free). */
  assetUsd: number;
};

/**
 * The asset ids a request used, rebuilt from the request alone: its account,
 * the hashes of its named inputs, and one key for its whole input set.
 *
 * @example
 * ```ts
 * const used: UsedAssets = { account: "3f9a0c1b2d4e", hashes: ["a1"], requestKey: "3f9a0c1b2d4e:9b74…" };
 * ```
 */
export type UsedAssets = {
  /** Account fingerprint. */
  account: string;
  /** Hashes of the inputs named in `params.assets`. */
  hashes: string[];
  /** `account + ":" + sha256(image, endImage, refs hashes)`: the same in submit and poll. */
  requestKey: string;
};

/**
 * Per-submit registration bookkeeping.
 */
type Registration = {
  /** Account fingerprint. */
  account: string;
  /** Whether the journal is open. */
  durable: boolean;
  /** Key and caller signal. */
  options: UploadOptions;
  /** Asset ids by input hash. */
  found: Map<string, string>;
  /** New records, written to the journal in one call. */
  records: ProviderRecord[];
};

/** Plugin name that owns the journal records. */
const PROVIDER = "apimodels";

/** Journal record kind of an asset id, keyed by input hash. */
const ASSET_KIND = "asset";

/** Journal record kind of an asset group id, keyed by group name. */
const GROUP_KIND = "asset-group";

/** Reserved `params` key naming the inputs to register. */
const ASSETS_PARAM = "assets";

/** A valid selector: `image`, `endImage`, or `refs.<n>` without leading zeros. */
const SELECTOR = /^(?:image|endImage|refs\.(?:0|[1-9]\d*))$/;

/** Prefix of a ref selector. */
const REF_PREFIX = "refs.";

/** Salt of the account fingerprint. */
const ACCOUNT_SALT = "moku-ai:";

/** Hex characters kept of the account fingerprint. */
const ACCOUNT_LENGTH = 12;

/** failCode apimodels uses for a bad request, a stale asset among them. */
const INVALID_INPUT = "INVALID_INPUT";

/** How apimodels' text names an asset. */
const NAMES_ASSET = /asset/i;

/** Status of a validation refusal or a final stale answer. */
const BAD_REQUEST = 400;

/** Status of a first stale answer, so the runner classifies it retryable (5xx). */
const RETRY_STATUS = 503;

/**
 * The account fingerprint: first 12 hex characters of
 * `sha256("moku-ai:" + apiKey)`. Non-reversible, so a key change never
 * reuses another account's ids and the journal never holds the key.
 *
 * @param apiKey - The API key.
 * @returns The fingerprint.
 * @example
 * ```ts
 * accountOf("key").length; // => 12
 * ```
 */
export function accountOf(apiKey: string): string {
  return createHash("sha256")
    .update(`${ACCOUNT_SALT}${apiKey}`)
    .digest("hex")
    .slice(0, ACCOUNT_LENGTH);
}

/**
 * A terminal 400 refusal of `params.assets`.
 *
 * @param message - The two-line message.
 * @returns The error to throw.
 * @example
 * ```ts
 * refusal("[ai] x.\n  y.").status; // => 400
 * ```
 */
function refusal(message: string): TerminalProviderError {
  return new TerminalProviderError(message, BAD_REQUEST);
}

/**
 * The input a selector names.
 *
 * @param request - The request (resolved or not).
 * @param request.image - First frame.
 * @param request.endImage - End frame.
 * @param request.refs - Refs.
 * @param selector - A valid selector.
 * @returns The input, or undefined when the request has none there.
 * @example
 * ```ts
 * inputOf({ refs: [{ $ref: "k" }] }, "refs.0"); // => { $ref: "k" }
 * ```
 */
function inputOf<Input>(
  request: { image?: Input; endImage?: Input; refs?: Input[] },
  selector: string
): Input | undefined {
  if (selector === "image") return request.image;
  if (selector === "endImage") return request.endImage;
  return request.refs?.[Number(selector.slice(REF_PREFIX.length))];
}

/**
 * The selectors of the inputs a request has, in request order.
 *
 * @param request - The request (resolved or not).
 * @returns Selectors, e.g. `["image", "refs.0"]`.
 * @example
 * ```ts
 * selectorsOf({ model: "m", prompt: "p", image: { $ref: "k" }, refs: [{ $ref: "r" }] }); // => ["image", "refs.0"]
 * ```
 */
function selectorsOf(request: EstimateRequest): string[] {
  const selectors: string[] = [];
  if (request.image !== undefined) selectors.push("image");
  if (request.endImage !== undefined) selectors.push("endImage");
  for (const index of (request.refs ?? []).keys()) selectors.push(`${REF_PREFIX}${index}`);
  return selectors;
}

/**
 * Every input of a resolved request with its selector, in request order.
 *
 * @param request - The resolved request.
 * @returns The inputs.
 * @example
 * ```ts
 * listInputs({ model: "m", prompt: "p", image: { path: "/a.png", mimeType: "image/png", hash: "a" } }); // => [{ selector: "image", file: { path: "/a.png", mimeType: "image/png", hash: "a" } }]
 * ```
 */
export function listInputs(request: VideoRequest): NamedInput[] {
  return selectorsOf(request).flatMap(selector => {
    const file = inputOf(request, selector);
    return file === undefined ? [] : [{ selector, file }];
  });
}

/**
 * Validates `params.assets` at estimate and submit: a list of valid
 * selectors, each naming an input the request has, each once. Works on
 * unresolved inputs; the `image/*` check is {@link selectAssetFiles}'s.
 *
 * @param request - The request (resolved or not).
 * @returns The selectors, or `[]` without `params.assets`.
 * @throws {TerminalProviderError} A 400 naming the bad entry and the fix.
 * @example
 * ```ts
 * readAssetSelectors({ model: "m", prompt: "p", image: { $ref: "k" }, params: { assets: ["image"] } }); // => ["image"]
 * ```
 */
export function readAssetSelectors(request: EstimateRequest): string[] {
  // No list: every input goes as an https upload.
  const value = request.params?.[ASSETS_PARAM];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw refusal(
      '[ai] apimodels params.assets must be a list of inputs.\n  Use "image", "endImage" or "refs.<n>", e.g. assets: ["image"].'
    );
  }

  // Each entry: a valid selector, naming an input the request has, listed once.
  const entries: readonly unknown[] = value;
  const available = selectorsOf(request);
  const selectors = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string" || !SELECTOR.test(entry)) {
      throw refusal(
        `[ai] apimodels params.assets has an unknown entry ${JSON.stringify(entry)}.\n  Use "image", "endImage" or "refs.<n>".`
      );
    }
    if (!available.includes(entry)) {
      throw refusal(
        `[ai] apimodels params.assets names "${entry}", but the request has no such input.\n  Name only inputs the request has: ${available.join(", ")}.`
      );
    }
    if (selectors.has(entry)) {
      throw refusal(
        `[ai] apimodels params.assets names "${entry}" twice.\n  List each input once.`
      );
    }
    selectors.add(entry);
  }
  return [...selectors];
}

/**
 * The resolved files the selectors name, each checked to be an image
 * (submit only: estimate cannot see MIME types of unresolved inputs).
 *
 * @param request - The resolved request.
 * @param selectors - Selectors from {@link readAssetSelectors}.
 * @returns The named files, in selector order.
 * @throws {TerminalProviderError} A 400 when a named input is not `image/*`.
 * @example
 * ```ts
 * selectAssetFiles({ model: "m", prompt: "p", image: { path: "/a.png", mimeType: "image/png", hash: "a" } }, ["image"]); // => [{ path: "/a.png", mimeType: "image/png", hash: "a" }]
 * ```
 */
export function selectAssetFiles(request: VideoRequest, selectors: readonly string[]): VideoFile[] {
  return selectors.map(selector => {
    const file = inputOf(request, selector);
    if (file === undefined) {
      throw refusal(
        `[ai] apimodels params.assets names "${selector}", but the request has no such input.\n  Name only inputs the request has.`
      );
    }
    if (!file.mimeType.startsWith("image/")) {
      throw refusal(
        `[ai] apimodels params.assets names "${selector}", which is ${file.mimeType}.\n  Only images become assets; remove it from params.assets.`
      );
    }
    return file;
  });
}

/**
 * Whether the journal can be used now. When it is not open (a facade call
 * before `app.start()`), logs `apimodels:journal:closed` once per process.
 *
 * @param ctx - Plugin context (`journal`, `state.journalSkipLogged`, `log`).
 * @returns True when the journal is open.
 */
function isJournalUsable(ctx: ApimodelsContext): boolean {
  if (ctx.journal.isOpen()) return true;
  if (!ctx.state.journalSkipLogged) {
    ctx.log.warn("apimodels:journal:closed", { tier: "state" });
    ctx.state.journalSkipLogged = true;
  }
  return false;
}

/**
 * Finds a face's asset id: `state.assets` first, then the journal (which
 * fills the state tier).
 *
 * @param ctx - Plugin context.
 * @param registration - Account and journal availability.
 * @param hash - The input's delivered hash.
 * @returns The `asset://` id, or undefined when it must be registered.
 */
function lookupAsset(
  ctx: ApimodelsContext,
  registration: Registration,
  hash: string
): string | undefined {
  const stateKey = `${registration.account}:${hash}`;
  const cached = ctx.state.assets.get(stateKey);
  if (cached !== undefined) return cached;
  if (!registration.durable) return undefined;

  const stored = ctx.journal.findProviderRecord({
    provider: PROVIDER,
    account: registration.account,
    kind: ASSET_KIND,
    key: hash
  });
  if (stored !== undefined) ctx.state.assets.set(stateKey, stored);
  return stored;
}

/**
 * Reads an id field that apimodels may send as a string or a number.
 *
 * @param data - The envelope's `data`.
 * @param key - The field name.
 * @returns The id as text, or undefined.
 * @example
 * ```ts
 * readId({ id: 42 }, "id"); // => "42"
 * ```
 */
function readId(data: unknown, key: string): string | undefined {
  const value = readField(data, key);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The terminal error for a 2xx response that lacks the field this plugin needs.
 *
 * @param what - What the response is.
 * @param field - The missing field.
 * @returns A terminal 400.
 * @example
 * ```ts
 * incomplete("asset response", "data.asset_url").message; // => "[ai] apimodels returned an incomplete asset response.\n  Expected data.asset_url; check the apimodels API for a change."
 * ```
 */
function incomplete(what: string, field: string): TerminalProviderError {
  return new TerminalProviderError(
    `[ai] apimodels returned an incomplete ${what}.\n  Expected ${field}; check the apimodels API for a change.`,
    BAD_REQUEST
  );
}

/**
 * The asset group id of the account: `state.groups`, then the journal
 * record (`asset-group`, key `config.assetGroup`), else `POST /assets/groups`
 * once, recorded for the journal write of this submit.
 *
 * @param ctx - Plugin context.
 * @param registration - Account, journal availability, options and pending records.
 * @returns The group id.
 * @throws {TerminalProviderError} When the response has no id.
 */
async function resolveGroup(ctx: ApimodelsContext, registration: Registration): Promise<string> {
  // The group of this account, from either tier.
  const { account, durable, options } = registration;
  const cached = ctx.state.groups.get(account);
  if (cached !== undefined) return cached;
  const query = { provider: PROVIDER, account, kind: GROUP_KIND, key: ctx.config.assetGroup };
  const stored = durable ? ctx.journal.findProviderRecord(query) : undefined;
  if (stored !== undefined) {
    ctx.state.groups.set(account, stored);
    return stored;
  }

  // None yet: create it once for this account.
  const create = (): Promise<unknown> =>
    apiData(
      {
        url: `${ctx.config.baseUrl}/assets/groups`,
        method: "POST",
        apiKey: options.apiKey,
        json: { name: ctx.config.assetGroup },
        timeoutMs: ctx.config.timeoutMs,
        signal: options.signal
      },
      "asset group response"
    );
  const groupId = readId(
    await withRateLimitWait(create, ctx.config.timeoutMs, options.signal),
    "id"
  );
  if (groupId === undefined) throw incomplete("asset group response", "data.id");

  // Keep it in both tiers.
  ctx.state.groups.set(account, groupId);
  registration.records.push({ ...query, value: groupId });
  return groupId;
}

/**
 * Registers one uploaded image with `POST /assets`. A 422 (moderation or an
 * unfetchable URL, not charged) is flagged by the client.
 *
 * @param ctx - Plugin context.
 * @param publicUrl - The image's upload URL.
 * @param groupId - The account's asset group.
 * @param options - Key and caller signal.
 * @returns The `asset://` id.
 * @throws {TerminalProviderError} When the response has no `asset_url`.
 */
async function registerImage(
  ctx: ApimodelsContext,
  publicUrl: string,
  groupId: string,
  options: UploadOptions
): Promise<string> {
  const register = (): Promise<unknown> =>
    apiData(
      {
        url: `${ctx.config.baseUrl}/assets`,
        method: "POST",
        apiKey: options.apiKey,
        json: { url: publicUrl, asset_type: "Image", group_id: groupId },
        timeoutMs: ctx.config.timeoutMs,
        signal: options.signal,
        moderated: true
      },
      "asset response"
    );
  const data = await withRateLimitWait(register, ctx.config.timeoutMs, options.signal);

  const assetUrl = readId(data, "asset_url");
  if (assetUrl === undefined) throw incomplete("asset response", "data.asset_url");
  return assetUrl;
}

/**
 * Registers the faces no tier knows: uploads them, resolves the group, then
 * registers each, {@link SLOTS} at a time. Each new id goes to the state
 * tier and the pending records at once, and is logged with its price, so a
 * submit that fails later still leaves an audit line.
 *
 * @param ctx - Plugin context.
 * @param registration - Account, journal availability, options, found ids and pending records.
 * @param missing - Distinct faces to register.
 */
async function registerMissing(
  ctx: ApimodelsContext,
  registration: Registration,
  missing: readonly VideoFile[]
): Promise<void> {
  if (missing.length === 0) return;

  // Upload the faces, then find or create the group.
  const { account, options } = registration;
  const publicUrls = await uploadFiles(ctx, missing, options);
  const groupId = await resolveGroup(ctx, registration);
  const usd = assetPriceUsd(ctx);

  // Register each face and keep its id in the state tier and the pending records.
  await mapInSlots([...missing.entries()], SLOTS, async ([index, file]) => {
    const assetUrl = await registerImage(ctx, publicUrls[index] ?? "", groupId, options);
    registration.found.set(file.hash, assetUrl);
    ctx.state.assets.set(`${account}:${file.hash}`, assetUrl);
    registration.records.push({
      provider: PROVIDER,
      account,
      kind: ASSET_KIND,
      key: file.hash,
      value: assetUrl
    });
    ctx.log.info("apimodels:asset:registered", { account, usd });
  });
}

/**
 * Resolves the named inputs of one submit to `asset://` ids: state, then
 * journal, then registration. New records are written to the journal in one
 * call, also when a registration failed after others succeeded. A closed
 * journal (before `app.start()`) is skipped: the state tier alone is used.
 *
 * @param ctx - Plugin context (config, state, journal, log).
 * @param files - The named, image-checked inputs (duplicates allowed).
 * @param options - Key and caller signal.
 * @returns One id per input, in order, and the USD of the new registrations.
 * @throws {FlaggedProviderError} When apimodels refuses an image (422).
 * @throws {TerminalProviderError} On 402 or an incomplete response.
 * @throws {RetryableProviderError} On 429 (after one wait), 5xx, timeout or network.
 */
export async function resolveAssets(
  ctx: ApimodelsContext,
  files: readonly VideoFile[],
  options: UploadOptions
): Promise<ResolvedAssets> {
  if (files.length === 0) return { urls: [], assetUsd: 0 };

  // Look each distinct face up in the state tier, then the journal.
  const registration: Registration = {
    account: accountOf(options.apiKey),
    durable: isJournalUsable(ctx),
    options,
    found: new Map(),
    records: []
  };
  const distinct = [...new Map(files.map(file => [file.hash, file])).values()];
  for (const file of distinct) {
    const assetUrl = lookupAsset(ctx, registration, file.hash);
    if (assetUrl !== undefined) registration.found.set(file.hash, assetUrl);
  }

  // Register the rest; whatever was registered is written once, even after a failure.
  const missing = distinct.filter(file => !registration.found.has(file.hash));
  let failure: { error: unknown } | undefined;
  try {
    await registerMissing(ctx, registration, missing);
  } catch (error) {
    failure = { error };
  }
  if (registration.durable && registration.records.length > 0) {
    ctx.journal.putProviderRecords(registration.records);
  }
  if (failure !== undefined) throw failure.error;

  return {
    urls: files.map(file => registration.found.get(file.hash) ?? ""),
    assetUsd: roundUsd(missing.length * assetPriceUsd(ctx))
  };
}

/**
 * The asset ids a request used, rebuilt from the request alone (so `poll`
 * after a restart finds the same records and the same once-per-request key).
 *
 * @param request - The resolved request.
 * @param apiKey - The API key (only its fingerprint is kept).
 * @returns Account, named hashes and the request key.
 * @throws {TerminalProviderError} When `params.assets` is invalid.
 * @example
 * ```ts
 * usedAssetsOf({ model: "m", prompt: "p", image: { path: "/a.png", mimeType: "image/png", hash: "a1" }, params: { assets: ["image"] } }, "key").hashes; // => ["a1"]
 * ```
 */
export function usedAssetsOf(request: VideoRequest, apiKey: string): UsedAssets {
  const account = accountOf(apiKey);
  const hashes = readAssetSelectors(request).flatMap(selector => {
    const file = inputOf(request, selector);
    return file === undefined ? [] : [file.hash];
  });
  const inputHashes = [
    request.image?.hash ?? "",
    request.endImage?.hash ?? "",
    ...(request.refs ?? []).map(ref => ref.hash)
  ];
  const inputsDigest = createHash("sha256").update(inputHashes.join(":")).digest("hex");
  return { account, hashes, requestKey: `${account}:${inputsDigest}` };
}

/**
 * Whether a failed task's code and text name a stale asset:
 * `INVALID_INPUT` with a text that mentions an asset.
 *
 * @param failCode - The task's failCode.
 * @param text - The task's failMsg.
 * @returns True for a stale asset.
 * @example
 * ```ts
 * isStaleAssetFailure("INVALID_INPUT", "asset not found"); // => true
 * ```
 */
export function isStaleAssetFailure(
  failCode: string | undefined,
  text: string | undefined
): boolean {
  return failCode === INVALID_INPUT && NAMES_ASSET.test(text ?? "");
}

/**
 * Whether a rejected submit names a stale asset: a terminal error with
 * failCode `INVALID_INPUT` (or none, on an HTTP 400) whose text mentions an asset.
 *
 * @param error - What the submit POST threw.
 * @returns True for a stale asset.
 * @example
 * ```ts
 * isStaleAssetRejection(new TerminalProviderError("x", 400, { detail: "unknown asset" })); // => true
 * ```
 */
export function isStaleAssetRejection(error: unknown): boolean {
  if (!(error instanceof TerminalProviderError)) return false;
  const isInvalidInput =
    error.failCode === INVALID_INPUT ||
    (error.failCode === undefined && error.status === BAD_REQUEST);
  return isInvalidInput && NAMES_ASSET.test(error.detail ?? "");
}

/**
 * Handles a stale asset answer: drops every asset record the request used
 * from both tiers, then returns a retryable 503 (the next attempt registers
 * again) the first time for this request key, a terminal 400 the second.
 *
 * @param ctx - Plugin context (state, journal, log).
 * @param seen - Request keys already answered stale in this process.
 * @param used - The request's account, hashes and key.
 * @returns The error `submit` throws or `poll` returns.
 */
export function invalidateStaleAssets(
  ctx: ApimodelsContext,
  seen: Set<string>,
  used: UsedAssets
): RetryableProviderError | TerminalProviderError {
  // Drop both tiers of every asset id this request used.
  const isOpen = ctx.journal.isOpen();
  for (const hash of used.hashes) {
    ctx.state.assets.delete(`${used.account}:${hash}`);
    if (isOpen) {
      ctx.journal.deleteProviderRecord({
        provider: PROVIDER,
        account: used.account,
        kind: ASSET_KIND,
        key: hash
      });
    }
  }
  ctx.log.warn("apimodels:asset:stale", { account: used.account, count: used.hashes.length });

  // Once per request: a second stale answer after registering anew is final.
  if (seen.has(used.requestKey)) {
    return new TerminalProviderError(
      "[ai] apimodels refused the asset ids of this request again, after they were registered anew.\n  Remove the inputs from params.assets, or check the apimodels asset library.",
      BAD_REQUEST
    );
  }
  seen.add(used.requestKey);
  return new RetryableProviderError(
    "[ai] apimodels no longer knows an asset id this request used.\n  Its records were dropped; the next attempt registers the inputs again.",
    { status: RETRY_STATUS }
  );
}
