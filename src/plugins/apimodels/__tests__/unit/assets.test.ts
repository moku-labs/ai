import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { EstimateRequest, VideoFile, VideoRequest } from "../../../video/contract";
import {
  accountOf,
  invalidateStaleAssets,
  isStaleAssetFailure,
  isStaleAssetRejection,
  isStaleGroupRejection,
  listInputs,
  readAssetSelectors,
  resolveAssets,
  selectAssetFiles,
  usedAssetsOf
} from "../../assets";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import { fileNameOf } from "../../upload";
import type { TempFiles } from "./fixtures";
import {
  BASE,
  createFakeJournal,
  createTempFiles,
  createTestCtx,
  envelope,
  jsonBodyOf,
  jsonResponse,
  logCalls,
  publicUrlOf,
  recordKey,
  rejectionOf,
  sleep,
  stubApi,
  TEST_KEY,
  thrownBy
} from "./fixtures";

const OPTIONS = { apiKey: TEST_KEY };
const ACCOUNT = createHash("sha256").update(`moku-ai:${TEST_KEY}`).digest("hex").slice(0, 12);

let temp: TempFiles;
let anna: VideoFile;
let ben: VideoFile;
let voice: VideoFile;
let end: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  anna = temp.file("anna.png", new Uint8Array([1, 1]), "image/png", "a".repeat(64));
  ben = temp.file("ben.png", new Uint8Array([2, 2]), "image/png", "b".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "c".repeat(64));
  end = temp.file("end.png", new Uint8Array([4]), "image/png", "d".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Asserts `work` throws a terminal 400 with exactly `message`. */
function expectTerminal400(work: () => unknown, message: string): void {
  const error = thrownBy(work);
  expect(error).toBeInstanceOf(TerminalProviderError);
  expect((error as TerminalProviderError).status).toBe(400);
  expect((error as Error).message).toBe(message);
}

/** The journal identity of an asset record for `file` under the test account. */
function assetRecordKey(file: VideoFile): string {
  return recordKey({ provider: "apimodels", account: ACCOUNT, kind: "asset", key: file.hash });
}

describe("accountOf", () => {
  it("is sha256('moku-ai:' + key), first 12 hex characters", () => {
    expect(accountOf(TEST_KEY)).toBe(ACCOUNT);
    expect(accountOf(TEST_KEY)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable per key and differs between keys", () => {
    expect(accountOf("key-1")).toBe(accountOf("key-1"));
    expect(accountOf("key-1")).not.toBe(accountOf("key-2"));
  });
});

describe("readAssetSelectors", () => {
  const request: EstimateRequest = {
    model: "seedance-2.5-ref",
    prompt: "p",
    image: { $file: "cast/anna.png" },
    refs: [{ $ref: "ben.sheet" }]
  };

  it("is empty without params.assets", () => {
    expect(readAssetSelectors(request)).toEqual([]);
    expect(readAssetSelectors({ ...request, params: { output_format: "mov" } })).toEqual([]);
  });

  it("returns the named inputs, unresolved inputs included", () => {
    expect(readAssetSelectors({ ...request, params: { assets: ["image", "refs.0"] } })).toEqual([
      "image",
      "refs.0"
    ]);
    expect(
      readAssetSelectors({
        model: "seedance-2.5",
        prompt: "p",
        image: anna,
        endImage: end,
        params: { assets: ["endImage"] }
      })
    ).toEqual(["endImage"]);
  });

  it("refuses a value that is not a list", () => {
    expectTerminal400(
      () => readAssetSelectors({ ...request, params: { assets: "image" } }),
      '[ai] apimodels params.assets must be a list of inputs.\n  Use "image", "endImage" or "refs.<n>", e.g. assets: ["image"].'
    );
  });

  it.each([
    ["face"],
    [3],
    ["refs.01"],
    ["refs.-1"],
    ["refs."],
    ["Image"]
  ])("refuses the unknown entry %j", entry => {
    expectTerminal400(
      () => readAssetSelectors({ ...request, params: { assets: [entry] } }),
      `[ai] apimodels params.assets has an unknown entry ${JSON.stringify(entry)}.\n  Use "image", "endImage" or "refs.<n>".`
    );
  });

  it("refuses an input the request does not have", () => {
    expectTerminal400(
      () => readAssetSelectors({ ...request, params: { assets: ["endImage"] } }),
      '[ai] apimodels params.assets names "endImage", but the request has no such input.\n  Name only inputs the request has: image, refs.0.'
    );
    expectTerminal400(
      () => readAssetSelectors({ ...request, params: { assets: ["refs.1"] } }),
      '[ai] apimodels params.assets names "refs.1", but the request has no such input.\n  Name only inputs the request has: image, refs.0.'
    );
  });

  it("refuses an input named twice", () => {
    expectTerminal400(
      () => readAssetSelectors({ ...request, params: { assets: ["image", "image"] } }),
      '[ai] apimodels params.assets names "image" twice.\n  List each input once.'
    );
  });
});

/** A reference request: anna first, then ben and a voice ref. */
function referenceRequest(): VideoRequest {
  return { model: "seedance-2.5-ref", prompt: "p", image: anna, refs: [ben, voice] };
}

/** A reference request naming anna and ben as assets. */
function staleRequest(): VideoRequest {
  return {
    model: "seedance-2.5-ref",
    prompt: "p",
    image: anna,
    refs: [ben],
    params: { assets: ["image", "refs.0"] }
  };
}

/** What apimodels said about a rejected submit. */
function upstream(
  failCode: string | undefined,
  detail: string
): { failCode: string | undefined; detail: string } {
  return { failCode, detail };
}

describe("listInputs / selectAssetFiles", () => {
  it("lists every input with its selector, in request order", () => {
    expect(listInputs({ ...referenceRequest(), endImage: end })).toEqual([
      { selector: "image", file: anna },
      { selector: "endImage", file: end },
      { selector: "refs.0", file: ben },
      { selector: "refs.1", file: voice }
    ]);
  });

  it("returns the named files", () => {
    expect(selectAssetFiles(referenceRequest(), ["refs.0", "image"])).toEqual([ben, anna]);
  });

  it("refuses a named input that is not an image (submit only)", () => {
    expectTerminal400(
      () => selectAssetFiles(referenceRequest(), ["refs.1"]),
      '[ai] apimodels params.assets names "refs.1", which is audio/mpeg.\n  Only images become assets; remove it from params.assets.'
    );
  });
});

describe("resolveAssets", () => {
  it("registers a new face: upload, group, register, then both tiers and one journal write", async () => {
    const api = stubApi();
    const journal = createFakeJournal();
    const ctx = createTestCtx({ journal });

    const resolved = await resolveAssets(ctx, [anna], OPTIONS);

    expect(resolved).toEqual({ urls: ["asset://asset-1"], assetUsd: 0.01 });
    expect(api.calls().map(call => call.url)).toEqual([
      `${BASE}/files`,
      `${BASE}/assets/groups`,
      `${BASE}/assets`
    ]);
    expect(jsonBodyOf(api.calls("group")[0])).toEqual({ name: "moku-ai" });
    expect(jsonBodyOf(api.calls("register")[0])).toEqual({
      url: publicUrlOf(fileNameOf(anna)),
      asset_type: "Image",
      group_id: "grp-1"
    });
    expect(ctx.state.assets.get(`${ACCOUNT}:${anna.hash}`)).toBe("asset://asset-1");
    expect(ctx.state.groups.get(ACCOUNT)).toBe("grp-1");
    expect(journal.putProviderRecords).toHaveBeenCalledTimes(1);
    expect(journal.putProviderRecords).toHaveBeenCalledWith([
      {
        provider: "apimodels",
        account: ACCOUNT,
        kind: "asset-group",
        key: "moku-ai",
        value: "grp-1"
      },
      {
        provider: "apimodels",
        account: ACCOUNT,
        kind: "asset",
        key: anna.hash,
        value: "asset://asset-1"
      }
    ]);
    expect(logCalls(ctx, "info")).toContainEqual([
      "apimodels:asset:registered",
      { account: ACCOUNT, usd: 0.01 }
    ]);
  });

  it("state first: a cached id needs no journal read and no fetch", async () => {
    const api = stubApi();
    const journal = createFakeJournal();
    const ctx = createTestCtx({ journal });
    ctx.state.assets.set(`${ACCOUNT}:${anna.hash}`, "asset://cached");

    const resolved = await resolveAssets(ctx, [anna], OPTIONS);

    expect(resolved).toEqual({ urls: ["asset://cached"], assetUsd: 0 });
    expect(journal.findProviderRecord).not.toHaveBeenCalled();
    expect(journal.putProviderRecords).not.toHaveBeenCalled();
    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it("journal second: a stored id fills state, with no fetch and no write", async () => {
    const api = stubApi();
    const journal = createFakeJournal();
    journal.records.set(assetRecordKey(anna), "asset://from-journal");
    const ctx = createTestCtx({ journal });

    const resolved = await resolveAssets(ctx, [anna], OPTIONS);

    expect(resolved).toEqual({ urls: ["asset://from-journal"], assetUsd: 0 });
    expect(ctx.state.assets.get(`${ACCOUNT}:${anna.hash}`)).toBe("asset://from-journal");
    expect(journal.findProviderRecord).toHaveBeenCalledWith({
      provider: "apimodels",
      account: ACCOUNT,
      kind: "asset",
      key: anna.hash
    });
    expect(journal.putProviderRecords).not.toHaveBeenCalled();
    expect(api.fetchMock).not.toHaveBeenCalled();
  });

  it("reads the group id from the journal before creating one", async () => {
    const api = stubApi();
    const journal = createFakeJournal();
    journal.records.set(
      recordKey({ provider: "apimodels", account: ACCOUNT, kind: "asset-group", key: "moku-ai" }),
      "grp-9"
    );

    await resolveAssets(createTestCtx({ journal }), [anna], OPTIONS);

    expect(api.count("group")).toBe(0);
    expect(jsonBodyOf(api.calls("register")[0]).group_id).toBe("grp-9");
    expect(journal.putProviderRecords).toHaveBeenCalledWith([
      {
        provider: "apimodels",
        account: ACCOUNT,
        kind: "asset",
        key: anna.hash,
        value: "asset://asset-1"
      }
    ]);
  });

  it("creates the group once per account, across submits", async () => {
    const api = stubApi();
    const journal = createFakeJournal();
    const ctx = createTestCtx({ journal });

    await resolveAssets(ctx, [anna], OPTIONS);
    await resolveAssets(ctx, [ben], OPTIONS);

    expect(api.count("group")).toBe(1);
    expect(api.count("register")).toBe(2);
    expect(journal.putProviderRecords).toHaveBeenCalledTimes(2);
  });

  it("writes every record of one submit in one journal call", async () => {
    stubApi();
    const journal = createFakeJournal();

    const resolved = await resolveAssets(createTestCtx({ journal }), [anna, ben], OPTIONS);

    expect(resolved.assetUsd).toBe(0.02);
    expect(journal.putProviderRecords).toHaveBeenCalledTimes(1);
    expect(journal.putProviderRecords.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("registers the same face named twice once", async () => {
    const api = stubApi();
    const resolved = await resolveAssets(createTestCtx(), [anna, anna], OPTIONS);
    expect(api.count("register")).toBe(1);
    expect(resolved).toEqual({ urls: ["asset://asset-1", "asset://asset-1"], assetUsd: 0.01 });
  });

  it("runs at most 4 registrations at once", async () => {
    let active = 0;
    let peak = 0;
    stubApi({
      register: async n => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(15);
        active -= 1;
        return envelope({ id: `asset-${n}`, asset_url: `asset://asset-${n}` });
      }
    });
    const faces = Array.from({ length: 7 }, (_, index) =>
      temp.file(`face${index}.png`, new Uint8Array([index]), "image/png", `f${index}`.repeat(32))
    );

    const resolved = await resolveAssets(createTestCtx(), faces, OPTIONS);

    expect(peak).toBe(4);
    expect(resolved.assetUsd).toBe(0.07);
  });

  it("journal not open: state only, and one warning per process", async () => {
    const api = stubApi();
    const journal = createFakeJournal(false);
    const ctx = createTestCtx({ journal });

    await resolveAssets(ctx, [anna], OPTIONS);
    await resolveAssets(ctx, [ben], OPTIONS);

    expect(journal.findProviderRecord).not.toHaveBeenCalled();
    expect(journal.putProviderRecords).not.toHaveBeenCalled();
    expect(ctx.state.assets.size).toBe(2);
    expect(api.count("group")).toBe(1);
    expect(
      logCalls(ctx, "warn").filter(([event]) => event === "apimodels:journal:closed")
    ).toHaveLength(1);
    expect(ctx.state.journalSkipLogged).toBe(true);
  });

  it("a 422 on register is flagged; the group id is still kept", async () => {
    const api = stubApi({ register: () => jsonResponse(422, { code: 422, msg: "moderation" }) });
    const journal = createFakeJournal();

    const error = await rejectionOf(() =>
      resolveAssets(createTestCtx({ journal }), [anna], OPTIONS)
    );

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect(api.count("submit")).toBe(0);
    expect(journal.putProviderRecords).toHaveBeenCalledWith([
      {
        provider: "apimodels",
        account: ACCOUNT,
        kind: "asset-group",
        key: "moku-ai",
        value: "grp-1"
      }
    ]);
  });

  it("a 402 on register is terminal", async () => {
    stubApi({ register: () => jsonResponse(402, { code: 402 }) });
    const error = await rejectionOf(() => resolveAssets(createTestCtx(), [anna], OPTIONS));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 402 });
  });

  it("a 429 on register waits Retry-After once, then succeeds", async () => {
    const api = stubApi({
      register: n =>
        n === 1
          ? jsonResponse(429, { code: 429 }, { "retry-after": "0" })
          : envelope({ id: "a", asset_url: "asset://a" })
    });
    const resolved = await resolveAssets(createTestCtx(), [anna], OPTIONS);
    expect(resolved.urls).toEqual(["asset://a"]);
    expect(api.count("register")).toBe(2);
  });

  it("a register response without asset_url is terminal", async () => {
    stubApi({ register: () => envelope({ id: "a" }) });
    const error = await rejectionOf(() => resolveAssets(createTestCtx(), [anna], OPTIONS));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] apimodels returned an incomplete asset response.\n  Expected data.asset_url; check the apimodels API for a change."
    );
  });

  it("never journals or logs the key", async () => {
    stubApi();
    const journal = createFakeJournal();
    const ctx = createTestCtx({ journal });
    await resolveAssets(ctx, [anna], OPTIONS);
    expect(JSON.stringify([...journal.records])).not.toContain(TEST_KEY);
    expect(JSON.stringify(logCalls(ctx, "info"))).not.toContain(TEST_KEY);
  });
});

describe("resolveAssets in flight", () => {
  it("two concurrent calls with the same face share one upload, one group and one registration", async () => {
    const api = stubApi();
    const journal = createFakeJournal();
    const ctx = createTestCtx({ journal });

    const [first, second] = await Promise.all([
      resolveAssets(ctx, [anna], OPTIONS),
      resolveAssets(ctx, [anna], OPTIONS)
    ]);

    expect(api.count("upload")).toBe(1);
    expect(api.count("group")).toBe(1);
    expect(api.count("register")).toBe(1);
    expect(first.urls).toEqual(["asset://asset-1"]);
    expect(second.urls).toEqual(["asset://asset-1"]);
    expect(first.assetUsd + second.assetUsd).toBe(0.01);
    expect(journal.putProviderRecords).toHaveBeenCalledTimes(1);
    expect(ctx.state.groupsInFlight.size).toBe(0);
    expect(ctx.state.assetsInFlight.size).toBe(0);
    expect(ctx.state.uploadsInFlight.size).toBe(0);
  });

  it("a shared registration that failed is dropped, so the next call registers again", async () => {
    const api = stubApi({
      register: n =>
        n === 1
          ? jsonResponse(500, { code: 500 })
          : envelope({ id: "a", asset_url: "asset://again" })
    });
    const ctx = createTestCtx();

    const failures = await Promise.allSettled([
      resolveAssets(ctx, [anna], OPTIONS),
      resolveAssets(ctx, [anna], OPTIONS)
    ]);
    const retried = await resolveAssets(ctx, [anna], OPTIONS);

    expect(failures.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(retried.urls).toEqual(["asset://again"]);
    expect(api.count("register")).toBe(2);
    expect(ctx.state.assetsInFlight.size).toBe(0);
  });
});

/** A register answer saying the group is gone. */
function groupGone(): Response {
  return jsonResponse(404, { code: 404, msg: "asset group grp-old does not exist" });
}

describe("stale asset group", () => {
  /** The journal identity of the test account's group record. */
  const groupKey = recordKey({
    provider: "apimodels",
    account: ACCOUNT,
    kind: "asset-group",
    key: "moku-ai"
  });

  it("isStaleGroupRejection: a terminal 4xx whose text names the group", () => {
    expect(
      isStaleGroupRejection(new TerminalProviderError("x", 404, upstream(undefined, "group gone")))
    ).toBe(true);
    expect(
      isStaleGroupRejection(new TerminalProviderError("x", 400, upstream(undefined, "bad url")))
    ).toBe(false);
    expect(
      isStaleGroupRejection(new TerminalProviderError("x", 500, upstream(undefined, "group")))
    ).toBe(false);
    expect(isStaleGroupRejection(new RetryableProviderError("group", { status: 503 }))).toBe(false);
    expect(isStaleGroupRejection(new FlaggedProviderError("group"))).toBe(false);
  });

  it("a register 4xx naming the group: forgets it in both tiers, creates it once more, registers again", async () => {
    const api = stubApi({
      register: n => (n === 1 ? groupGone() : envelope({ id: "a2", asset_url: "asset://a2" })),
      group: () => envelope({ id: "grp-new" })
    });
    const journal = createFakeJournal();
    journal.records.set(groupKey, "grp-old");
    const ctx = createTestCtx({ journal });

    const resolved = await resolveAssets(ctx, [anna], OPTIONS);

    expect(resolved).toEqual({ urls: ["asset://a2"], assetUsd: 0.01 });
    expect(api.count("group")).toBe(1);
    expect(api.calls("register").map(call => jsonBodyOf(call).group_id)).toEqual([
      "grp-old",
      "grp-new"
    ]);
    expect(journal.deleteProviderRecord).toHaveBeenCalledWith({
      provider: "apimodels",
      account: ACCOUNT,
      kind: "asset-group",
      key: "moku-ai"
    });
    expect(journal.records.get(groupKey)).toBe("grp-new");
    expect(ctx.state.groups.get(ACCOUNT)).toBe("grp-new");
    expect(journal.records.get(assetRecordKey(anna))).toBe("asset://a2");
  });

  it("journal not open: forgets the state tier only, then creates the group once more", async () => {
    const api = stubApi({
      register: n => (n === 1 ? groupGone() : envelope({ id: "a2", asset_url: "asset://a2" })),
      group: () => envelope({ id: "grp-new" })
    });
    const journal = createFakeJournal(false);
    const ctx = createTestCtx({ journal });
    ctx.state.groups.set(ACCOUNT, "grp-old");

    const resolved = await resolveAssets(ctx, [anna], OPTIONS);

    expect(resolved.urls).toEqual(["asset://a2"]);
    expect(api.count("group")).toBe(1);
    expect(ctx.state.groups.get(ACCOUNT)).toBe("grp-new");
    expect(journal.deleteProviderRecord).not.toHaveBeenCalled();
  });

  it("a second group failure is thrown as is", async () => {
    const api = stubApi({ register: groupGone });
    const ctx = createTestCtx();
    ctx.state.groups.set(ACCOUNT, "grp-old");

    const error = await rejectionOf(() => resolveAssets(ctx, [anna], OPTIONS));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 404 });
    expect((error as Error).message).toContain("asset group grp-old does not exist");
    expect(api.count("register")).toBe(2);
    expect(api.count("group")).toBe(1);
  });

  it("a register 4xx that does not name the group is thrown at once", async () => {
    const api = stubApi({ register: () => jsonResponse(400, { code: 400, msg: "bad url" }) });

    const error = await rejectionOf(() => resolveAssets(createTestCtx(), [anna], OPTIONS));

    expect(error).toMatchObject({ status: 400 });
    expect(api.count("register")).toBe(1);
    expect(api.count("group")).toBe(1);
  });

  it("two faces of one submit that hit the stale group create one new group", async () => {
    const api = stubApi({
      register: (_n, body) =>
        body.group_id === "grp-old"
          ? groupGone()
          : envelope({ id: String(body.url), asset_url: `asset://${String(body.url).length}` }),
      group: () => envelope({ id: "grp-new" })
    });
    const ctx = createTestCtx();
    ctx.state.groups.set(ACCOUNT, "grp-old");

    const resolved = await resolveAssets(ctx, [anna, ben], OPTIONS);

    expect(resolved.urls).toHaveLength(2);
    expect(api.count("group")).toBe(1);
    expect(api.count("register")).toBe(4);
  });
});

describe("stale assets", () => {
  it("isStaleAssetFailure: INVALID_INPUT whose text mentions an asset", () => {
    expect(isStaleAssetFailure("INVALID_INPUT", "Asset asset://a1 not found")).toBe(true);
    expect(isStaleAssetFailure("INVALID_INPUT", "bad duration")).toBe(false);
    expect(isStaleAssetFailure("OTHER", "asset missing")).toBe(false);
    expect(isStaleAssetFailure("INVALID_INPUT", undefined)).toBe(false);
  });

  it("isStaleAssetRejection: a terminal 400 or INVALID_INPUT naming an asset", () => {
    expect(
      isStaleAssetRejection(
        new TerminalProviderError("x", 400, upstream("INVALID_INPUT", "asset gone"))
      )
    ).toBe(true);
    expect(
      isStaleAssetRejection(
        new TerminalProviderError("x", 400, upstream(undefined, "unknown asset"))
      )
    ).toBe(true);
    expect(
      isStaleAssetRejection(new TerminalProviderError("x", 422, upstream(undefined, "asset")))
    ).toBe(false);
    expect(
      isStaleAssetRejection(
        new TerminalProviderError("x", 400, upstream(undefined, "bad duration"))
      )
    ).toBe(false);
    expect(isStaleAssetRejection(new RetryableProviderError("asset", { status: 503 }))).toBe(false);
  });

  it("usedAssetsOf: the account, the named hashes, and one key for the model, prompt, seconds and inputs", () => {
    const used = usedAssetsOf(staleRequest(), TEST_KEY);
    const requestHash = createHash("sha256")
      .update(["seedance-2.5-ref", "p", "", anna.hash, "", ben.hash].join(":"))
      .digest("hex");
    expect(used).toEqual({
      account: ACCOUNT,
      hashes: [anna.hash, ben.hash],
      requestKey: `${ACCOUNT}:${requestHash}`
    });
    expect(
      usedAssetsOf({ ...staleRequest(), refs: [voice], params: { assets: ["image"] } }, TEST_KEY)
        .requestKey
    ).not.toBe(used.requestKey);
    expect(usedAssetsOf({ ...staleRequest(), params: {} }, TEST_KEY).hashes).toEqual([]);
  });

  it("usedAssetsOf: a re-submit of the same item keeps its key; another item with the same face does not", () => {
    const used = usedAssetsOf(staleRequest(), TEST_KEY);

    expect(usedAssetsOf(staleRequest(), TEST_KEY).requestKey).toBe(used.requestKey);
    expect(usedAssetsOf({ ...staleRequest(), prompt: "other" }, TEST_KEY).requestKey).not.toBe(
      used.requestKey
    );
    expect(usedAssetsOf({ ...staleRequest(), seconds: 8 }, TEST_KEY).requestKey).not.toBe(
      used.requestKey
    );
    expect(
      usedAssetsOf({ ...staleRequest(), model: "seedance-2.0-ref" }, TEST_KEY).requestKey
    ).not.toBe(used.requestKey);
  });

  it("first time: drops both tiers and returns a retryable 503, kind resubmit; second time: terminal 400", () => {
    const journal = createFakeJournal();
    journal.records.set(assetRecordKey(anna), "asset://a1");
    journal.records.set(assetRecordKey(ben), "asset://b1");
    const ctx = createTestCtx({ journal });
    ctx.state.assets.set(`${ACCOUNT}:${anna.hash}`, "asset://a1");
    const seen = new Set<string>();
    const used = usedAssetsOf(staleRequest(), TEST_KEY);

    const first = invalidateStaleAssets(ctx, seen, used);

    expect(first).toBeInstanceOf(RetryableProviderError);
    expect(first).toMatchObject({ status: 503, kind: "resubmit" });
    expect(first.message).toBe(
      "[ai] apimodels no longer knows an asset id this request used.\n  Its records were dropped; the next attempt registers the inputs again."
    );
    expect(ctx.state.assets.size).toBe(0);
    expect(journal.records.size).toBe(0);
    expect(journal.deleteProviderRecord).toHaveBeenCalledTimes(2);
    expect(logCalls(ctx, "warn")).toContainEqual([
      "apimodels:asset:stale",
      { account: ACCOUNT, count: 2 }
    ]);

    const second = invalidateStaleAssets(ctx, seen, used);

    expect(second).toBeInstanceOf(TerminalProviderError);
    expect(second).toMatchObject({ status: 400 });
    expect(second.message).toBe(
      "[ai] apimodels refused the asset ids of this request again, after they were registered anew.\n  Remove the inputs from params.assets, or check the apimodels asset library."
    );
  });

  it("journal not open: drops the state tier only", () => {
    const journal = createFakeJournal(false);
    const ctx = createTestCtx({ journal });
    ctx.state.assets.set(`${ACCOUNT}:${anna.hash}`, "asset://a1");

    invalidateStaleAssets(ctx, new Set(), usedAssetsOf(staleRequest(), TEST_KEY));

    expect(ctx.state.assets.size).toBe(0);
    expect(journal.deleteProviderRecord).not.toHaveBeenCalled();
  });
});

describe("types", () => {
  it("the context's journal refuses a provider record without value", () => {
    const { journal } = createTestCtx();
    const record = { provider: "apimodels", account: ACCOUNT, kind: "asset", key: anna.hash };

    // @ts-expect-error -- ProviderRecord.value is required: a record keeps an id
    expectTypeOf(journal.putProviderRecords).toBeCallableWith([record]);
    expectTypeOf(journal.putProviderRecords).toBeCallableWith([{ ...record, value: "asset://a1" }]);
    expect(journal.putProviderRecords).not.toHaveBeenCalled();
  });
});
