import { afterEach, describe, expect, it, vi } from "vitest";
import { createArkApi } from "../../api";
import {
  ASSET_ID,
  callsOf,
  createTestCtx,
  GROUP_ID,
  intlActionUrl,
  jsonBodyOf,
  jsonResponse,
  OPENAPI_ERROR_ACCESS_DENIED,
  stubFetch
} from "../fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ark asset library mapping", () => {
  it("rejects an empty group filter before any call", async () => {
    const fetchMock = stubFetch();

    await expect(createArkApi(createTestCtx()).listAssets({ groupId: "" })).rejects.toThrow(
      "[ai] ark asset groupId must not be empty.\n  Pass a valid groupId."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps group fields, preserves time strings and skips non-string ids", async () => {
    stubFetch(
      jsonResponse(200, {
        Result: {
          Items: [
            { Id: GROUP_ID, Name: "portraits", CreateTime: "unparsed time" },
            { Id: "bare" },
            { Id: "", Name: "", CreateTime: "" },
            { Name: "missing id" },
            { Id: 7 },
            false
          ]
        }
      })
    );

    expect(await createArkApi(createTestCtx()).listAssetGroups()).toStrictEqual([
      { groupId: GROUP_ID, name: "portraits", createTime: "unparsed time" },
      { groupId: "bare", name: "" },
      { groupId: "", name: "", createTime: "" }
    ]);
  });

  it("maps asset fields, omits absent times and defaults missing display fields", async () => {
    stubFetch(
      jsonResponse(200, {
        Result: {
          Items: [
            {
              Id: ASSET_ID,
              Name: "mira",
              GroupId: GROUP_ID,
              Status: "Active",
              CreateTime: "created verbatim",
              UpdateTime: "updated verbatim",
              LastInferenceTime: "inferred verbatim"
            },
            { Id: "bare" },
            { Id: "", Name: "", GroupId: "", Status: "", UpdateTime: "" },
            { Name: "missing id" },
            { Id: 7 },
            false
          ]
        }
      })
    );

    expect(await createArkApi(createTestCtx()).listAssets()).toStrictEqual([
      {
        assetId: ASSET_ID,
        name: "mira",
        groupId: GROUP_ID,
        status: "Active",
        createTime: "created verbatim",
        updateTime: "updated verbatim",
        lastInferenceTime: "inferred verbatim"
      },
      { assetId: "bare", name: "", groupId: "", status: "unknown" },
      { assetId: "", name: "", groupId: "", status: "", updateTime: "" }
    ]);
  });

  it("sends only the requested group filter on every asset page", async () => {
    const items = Array.from({ length: 100 }, () => ({ Id: ASSET_ID }));
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: items } }),
      jsonResponse(200, { Result: { Items: [] } })
    );

    expect(await createArkApi(createTestCtx()).listAssets({ groupId: GROUP_ID })).toHaveLength(100);
    expect(callsOf(fetchMock).map(call => [call.url, jsonBodyOf(call)])).toEqual([
      [
        intlActionUrl("ListAssets"),
        { Filter: { GroupType: "AIGC", GroupIds: [GROUP_ID] }, PageNumber: 1, PageSize: 100 }
      ],
      [
        intlActionUrl("ListAssets"),
        { Filter: { GroupType: "AIGC", GroupIds: [GROUP_ID] }, PageNumber: 2, PageSize: 100 }
      ]
    ]);
  });
});

describe.each([
  ["listAssetGroups", "ListAssetGroups"],
  ["listAssets", "ListAssets"]
] as const)("ark %s pagination", (method, action) => {
  it.each([undefined, 101, 500])("reads until a short page (TotalCount: %s)", async totalCount => {
    const items = Array.from({ length: 100 }, (_, index) => ({ Id: `id-${index}` }));
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: items, TotalCount: totalCount } }),
      jsonResponse(200, { Result: { Items: [{ Id: "last" }], TotalCount: totalCount } })
    );

    const listed = await createArkApi(createTestCtx())[method]();

    expect(listed).toHaveLength(101);
    expect(listed.at(-1)).toMatchObject(
      method === "listAssets" ? { assetId: "last" } : { groupId: "last" }
    );
    expect(callsOf(fetchMock).map(call => [call.url, call.method, jsonBodyOf(call)])).toEqual([
      [
        intlActionUrl(action),
        "POST",
        { Filter: { GroupType: "AIGC" }, PageNumber: 1, PageSize: 100 }
      ],
      [
        intlActionUrl(action),
        "POST",
        { Filter: { GroupType: "AIGC" }, PageNumber: 2, PageSize: 100 }
      ]
    ]);
    expect(callsOf(fetchMock)[0]?.headers.Authorization).toMatch(/^HMAC-SHA256 /);
  });

  it.each([
    100, 200
  ])("counts skipped items toward TotalCount %s across full pages", async totalCount => {
    const items = [{ Id: "kept" }, ...Array.from({ length: 99 }, () => ({ Id: 7 }))];
    const fetchMock = stubFetch(
      ...Array.from({ length: totalCount / 100 }, () =>
        jsonResponse(200, { Result: { Items: items, TotalCount: totalCount } })
      )
    );

    expect(await createArkApi(createTestCtx())[method]()).toHaveLength(totalCount / 100);
    expect(fetchMock).toHaveBeenCalledTimes(totalCount / 100);
  });

  it("returns an empty list for an empty page", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: { Items: [] } }));

    expect(await createArkApi(createTestCtx())[method]()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes the caller signal to later pages and propagates its abort unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("paused on page two");
    const items = Array.from({ length: 100 }, () => ({ Id: ASSET_ID }));
    const fetchMock = stubFetch(jsonResponse(200, { Result: { Items: items } }));
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      controller.abort(reason);
      expect(init.signal?.reason).toBe(reason);
      throw reason;
    });
    const api = createArkApi(createTestCtx());
    const opts = { signal: controller.signal };
    const pending =
      method === "listAssets" ? api.listAssets(undefined, opts) : api.listAssetGroups(opts);

    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ark asset library deletion", () => {
  it("deletes one asset and forgets only its Active cache entry after success", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: {} }));
    const ctx = createTestCtx();
    const group = Promise.resolve(GROUP_ID);
    ctx.state.group.set("portraits", group);
    ctx.state.activeAssets.add(ASSET_ID).add("other");

    expect(await createArkApi(ctx).deleteAsset(ASSET_ID)).toBeUndefined();
    expect(callsOf(fetchMock).map(call => [call.url, call.method, jsonBodyOf(call)])).toEqual([
      [intlActionUrl("DeleteAsset"), "POST", { Id: ASSET_ID }]
    ]);
    expect(ctx.state.activeAssets).toEqual(new Set(["other"]));
    expect(ctx.state.group.get("portraits")).toBe(group);
  });

  it("deletes a group, forgets every matching name and clears all Active assets", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: {} }));
    const ctx = createTestCtx();
    const other = Promise.resolve("other-id");
    const rejected = Promise.reject(new Error("failed lookup"));
    await expect(rejected).rejects.toThrow("failed lookup");
    ctx.state.group.set("portraits", Promise.resolve(GROUP_ID));
    ctx.state.group.set("alias", Promise.resolve(GROUP_ID));
    ctx.state.group.set("other", other);
    ctx.state.group.set("rejected", rejected);
    ctx.state.activeAssets.add(ASSET_ID).add("other-asset");

    expect(await createArkApi(ctx).deleteAssetGroup(GROUP_ID)).toBeUndefined();
    expect(callsOf(fetchMock).map(call => [call.url, call.method, jsonBodyOf(call)])).toEqual([
      [intlActionUrl("DeleteAssetGroup"), "POST", { Id: GROUP_ID }]
    ]);
    expect(ctx.state.group).toEqual(
      new Map([
        ["other", other],
        ["rejected", rejected]
      ])
    );
    expect(ctx.state.activeAssets.size).toBe(0);
  });

  it("awaits pending cached group promises before finishing the deletion", async () => {
    stubFetch(jsonResponse(200, { Result: {} }));
    const ctx = createTestCtx();
    const pending = Promise.withResolvers<string>();
    ctx.state.group.set("pending", pending.promise);
    const api = createArkApi(ctx);
    let finished = false;
    const deleting = api.deleteAssetGroup(GROUP_ID).then(() => {
      finished = true;
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    pending.resolve(GROUP_ID);
    await deleting;
    expect(ctx.state.group.has("pending")).toBe(false);
    expect(finished).toBe(true);
  });

  it.each([
    "deleteAsset",
    "deleteAssetGroup"
  ] as const)("%s preserves both caches when the provider rejects", async method => {
    const fetchMock = stubFetch(jsonResponse(403, OPENAPI_ERROR_ACCESS_DENIED));
    const ctx = createTestCtx();
    const group = Promise.resolve(GROUP_ID);
    ctx.state.group.set("portraits", group);
    ctx.state.activeAssets.add(ASSET_ID);

    await expect(
      createArkApi(ctx)[method](method === "deleteAsset" ? ASSET_ID : GROUP_ID)
    ).rejects.toMatchObject({ status: 403, code: "AccessDenied" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.state.group.get("portraits")).toBe(group);
    expect(ctx.state.activeAssets).toEqual(new Set([ASSET_ID]));
  });

  it.each([
    ["deleteAsset", "assetId"],
    ["deleteAssetGroup", "groupId"]
  ] as const)("%s rejects an empty id before any call", async (method, field) => {
    const fetchMock = stubFetch();
    const ctx = createTestCtx();
    ctx.state.activeAssets.add(ASSET_ID);

    await expect(createArkApi(ctx)[method]("")).rejects.toThrow(
      `[ai] ark asset ${field} must not be empty.\n  Pass a valid ${field}.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.state.activeAssets).toEqual(new Set([ASSET_ID]));
  });
});

describe("ark asset library cancellation", () => {
  it.each([
    "listAssetGroups",
    "listAssets",
    "deleteAsset",
    "deleteAssetGroup"
  ] as const)("%s propagates caller aborts without changing caches", async method => {
    const controller = new AbortController();
    const reason = new Error("paused");
    controller.abort(reason);
    const fetchMock = stubFetch(reason);
    const ctx = createTestCtx();
    const group = Promise.resolve(GROUP_ID);
    ctx.state.group.set("portraits", group);
    ctx.state.activeAssets.add(ASSET_ID);
    const api = createArkApi(ctx);
    const opts = { signal: controller.signal };
    const calls = {
      listAssetGroups: () => api.listAssetGroups(opts),
      listAssets: () => api.listAssets(undefined, opts),
      deleteAsset: () => api.deleteAsset(ASSET_ID, opts),
      deleteAssetGroup: () => api.deleteAssetGroup(GROUP_ID, opts)
    };

    await expect(calls[method]()).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.state.group.get("portraits")).toBe(group);
    expect(ctx.state.activeAssets).toEqual(new Set([ASSET_ID]));
  });
});
