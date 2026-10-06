import { afterEach, describe, expect, it, vi } from "vitest";
import { findOrCreateGroup } from "../../asset/group";
import {
  callsOf,
  createTestCtx,
  GROUP_ID,
  intlActionUrl,
  jsonBodyOf,
  jsonResponse,
  OPENAPI_ERROR_ACCESS_DENIED,
  stubFetch
} from "../fixtures";

const NAME = "portraits";
const GROUP = { Id: GROUP_ID, Name: NAME, CreateTime: "2026-10-01" };
const LIST_BODY = { Filter: { GroupType: "AIGC", Name: NAME }, PageNumber: 1, PageSize: 100 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findOrCreateGroup", () => {
  it("uses config.groupId without a call only for config.groupName", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: { Items: [GROUP] } }));
    const ctx = createTestCtx({ config: { groupId: "configured" } });

    expect(await findOrCreateGroup(ctx, ctx.config.groupName)).toBe("configured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await findOrCreateGroup(ctx, NAME)).toBe(GROUP_ID);
    expect(callsOf(fetchMock).map(call => call.url)).toEqual([intlActionUrl("ListAssetGroups")]);
  });

  it("finds and caches a named group without creating or logging one", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: { Items: [GROUP] } }));
    const ctx = createTestCtx();

    expect(await findOrCreateGroup(ctx, NAME)).toBe(GROUP_ID);
    expect(await findOrCreateGroup(ctx, NAME)).toBe(GROUP_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jsonBodyOf(callsOf(fetchMock)[0])).toEqual(LIST_BODY);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("filters names exactly even when the server returns partial or case-insensitive matches", async () => {
    stubFetch(
      jsonResponse(200, {
        Result: {
          Items: [
            { ...GROUP, Id: "partial", Name: `${NAME}-extra`, CreateTime: "2000" },
            { ...GROUP, Id: "case", Name: "Portraits", CreateTime: "2000" },
            GROUP
          ]
        }
      })
    );

    expect(await findOrCreateGroup(createTestCtx(), NAME)).toBe(GROUP_ID);
  });

  it("chooses the oldest of two exact names by plain CreateTime string comparison", async () => {
    stubFetch(
      jsonResponse(200, {
        Result: {
          Items: [
            { ...GROUP, Id: "later", CreateTime: "a" },
            { ...GROUP, CreateTime: "B" }
          ]
        }
      })
    );

    expect(await findOrCreateGroup(createTestCtx(), NAME)).toBe(GROUP_ID);
  });

  it.each([
    false,
    true
  ])("sorts a missing CreateTime last (missing first: %s)", async missingFirst => {
    const missing = { Id: "undated", Name: NAME };
    const items = missingFirst ? [missing, GROUP] : [GROUP, missing];
    stubFetch(jsonResponse(200, { Result: { Items: items } }));

    expect(await findOrCreateGroup(createTestCtx(), NAME)).toBe(GROUP_ID);
  });

  it("skips entries without a string Id", async () => {
    stubFetch(
      jsonResponse(200, {
        Result: {
          Items: [
            { Name: NAME, CreateTime: "2000" },
            { Id: 7, Name: NAME, CreateTime: "2000" },
            GROUP
          ]
        }
      })
    );

    expect(await findOrCreateGroup(createTestCtx(), NAME)).toBe(GROUP_ID);
  });

  it("creates the requested name after an empty lookup and preserves the creation log", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: [] } }),
      jsonResponse(200, { Result: { Id: GROUP_ID } })
    );
    const ctx = createTestCtx();

    expect(await findOrCreateGroup(ctx, NAME)).toBe(GROUP_ID);
    expect(callsOf(fetchMock).map(call => [call.url, jsonBodyOf(call)])).toEqual([
      [intlActionUrl("ListAssetGroups"), LIST_BODY],
      [intlActionUrl("CreateAssetGroup"), { GroupType: "AIGC", Name: NAME }]
    ]);
    expect(ctx.log.warn).toHaveBeenCalledExactlyOnceWith("ark:asset:group-created", {
      groupId: GROUP_ID,
      hint: "set ark config groupId to reuse it"
    });
  });

  it("shares one lookup and creation among concurrent callers of the same name", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: [] } }),
      jsonResponse(200, { Result: { Id: GROUP_ID } })
    );
    const ctx = createTestCtx();

    expect(
      await Promise.all([
        findOrCreateGroup(ctx, NAME),
        findOrCreateGroup(ctx, NAME),
        findOrCreateGroup(ctx, NAME)
      ])
    ).toEqual([GROUP_ID, GROUP_ID, GROUP_ID]);
    expect(callsOf(fetchMock).map(call => call.url)).toEqual([
      intlActionUrl("ListAssetGroups"),
      intlActionUrl("CreateAssetGroup")
    ]);
  });

  it.each([
    "lookup",
    "creation"
  ])("forgets a failed %s without forgetting another name", async failure => {
    const failedResponses =
      failure === "creation" ? [jsonResponse(200, { Result: { Items: [] } })] : [];
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: [{ ...GROUP, Name: "other", Id: "other-id" }] } }),
      ...failedResponses,
      jsonResponse(403, OPENAPI_ERROR_ACCESS_DENIED),
      jsonResponse(200, { Result: { Items: [GROUP] } })
    );
    const ctx = createTestCtx();
    expect(await findOrCreateGroup(ctx, "other")).toBe("other-id");

    const outcomes = await Promise.allSettled([
      findOrCreateGroup(ctx, NAME),
      findOrCreateGroup(ctx, NAME)
    ]);
    expect(outcomes).toMatchObject([
      { status: "rejected", reason: { status: 403, code: "AccessDenied" } },
      { status: "rejected", reason: { status: 403, code: "AccessDenied" } }
    ]);
    expect(await findOrCreateGroup(ctx, NAME)).toBe(GROUP_ID);
    expect(await findOrCreateGroup(ctx, "other")).toBe("other-id");
    expect(fetchMock).toHaveBeenCalledTimes(failure === "creation" ? 4 : 3);
  });

  it("creates two groups for two concurrent names and reuses each separately", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: [] } }),
      jsonResponse(200, { Result: { Items: [] } }),
      jsonResponse(200, { Result: { Id: "first-id" } }),
      jsonResponse(200, { Result: { Id: "second-id" } })
    );
    const ctx = createTestCtx();

    expect(
      await Promise.all([findOrCreateGroup(ctx, "first"), findOrCreateGroup(ctx, "second")])
    ).toEqual(["first-id", "second-id"]);
    expect(await findOrCreateGroup(ctx, "second")).toBe("second-id");
    expect(await findOrCreateGroup(ctx, "first")).toBe("first-id");
    expect(callsOf(fetchMock).map(call => jsonBodyOf(call))).toEqual([
      { ...LIST_BODY, Filter: { GroupType: "AIGC", Name: "first" } },
      { ...LIST_BODY, Filter: { GroupType: "AIGC", Name: "second" } },
      { GroupType: "AIGC", Name: "first" },
      { GroupType: "AIGC", Name: "second" }
    ]);
  });

  it.each([
    undefined,
    101,
    500
  ])("reads all pages before choosing the oldest (TotalCount: %s)", async totalCount => {
    const items = Array.from({ length: 100 }, (_, index) => ({ ...GROUP, Id: `new-${index}` }));
    const fetchMock = stubFetch(
      jsonResponse(200, { Result: { Items: items, TotalCount: totalCount } }),
      jsonResponse(200, {
        Result: { Items: [{ ...GROUP, CreateTime: "2000" }], TotalCount: totalCount }
      })
    );

    expect(await findOrCreateGroup(createTestCtx(), NAME)).toBe(GROUP_ID);
    expect(callsOf(fetchMock).map(call => jsonBodyOf(call))).toEqual([
      LIST_BODY,
      { ...LIST_BODY, PageNumber: 2 }
    ]);
  });

  it("stops on a full page when TotalCount is reached, counting skipped entries too", async () => {
    const items = [GROUP, ...Array.from({ length: 99 }, () => ({ Name: NAME }))];
    const fetchMock = stubFetch(jsonResponse(200, { Result: { Items: items, TotalCount: 100 } }));

    expect(await findOrCreateGroup(createTestCtx(), NAME)).toBe(GROUP_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
