import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssetJobPoll, AssetRequest } from "../../../asset/contract";
import { ASSET_MIME, encodeAssetRecord, parseAssetRecord } from "../../../asset/contract";
import { createAssetHandler } from "../../asset/handler";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import type { TempFiles } from "../fixtures";
import {
  ASSET_ID,
  CREATE_ASSET_GROUP_REQUEST,
  CREATE_ASSET_GROUP_RESPONSE,
  CREATE_ASSET_REQUEST,
  CREATE_ASSET_RESPONSE,
  callsOf,
  createTempFiles,
  createTestCtx,
  GET_ASSET_ACTIVE,
  GET_ASSET_FAILED,
  GET_ASSET_PROCESSING,
  GET_ASSET_REQUEST,
  GROUP_ID,
  INTL_ACCOUNT,
  intlActionUrl,
  jsonBodyOf,
  jsonResponse,
  loggedText,
  OPENAPI_ERROR_ACCESS_DENIED,
  OPENAPI_ERROR_INVALID,
  OPENAPI_ERROR_THROTTLING,
  pngHeader,
  stubFetch,
  TEST_ACCESS_KEY,
  TEST_SECRET_KEY
} from "../fixtures";

const PORTRAIT_URL = "https://cdn.example/faces/mira.png";
const JOB_ID = `${GROUP_ID}/${ASSET_ID}`;
const NOW = 1_790_683_214_000;

let temp: TempFiles;
let portrait: AssetRequest["image"];

beforeAll(() => {
  temp = createTempFiles();
  portrait = temp.file("mira.png", pngHeader(1024, 1024), "image/png");
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A registration request for the test portrait. */
function request(overrides: Partial<AssetRequest> = {}): AssetRequest {
  return { image: portrait, url: PORTRAIT_URL, ...overrides };
}

/** What a promise rejected with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** Asserts a poll result is `failed` and returns its error. */
function failedError(result: AssetJobPoll): unknown {
  if (result.state !== "failed") throw new Error(`expected failed, got ${result.state}`);
  return result.error;
}

describe("estimate", () => {
  it("is 0: the asset fee is part of the entitlement", () => {
    const fetchMock = stubFetch();
    expect(createAssetHandler(createTestCtx()).estimate(request())).toEqual({ usd: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("submit checks before any call", () => {
  it("rejects a missing or non-https url", async () => {
    const fetchMock = stubFetch();
    const handler = createAssetHandler(createTestCtx());
    const message =
      "[ai] ark CreateAsset needs a public https url.\n  Pass input.url with the same bytes as input.image.";

    const withoutUrl: AssetRequest = { image: portrait };
    await expect(handler.submit(withoutUrl, {})).rejects.toThrow(message);
    await expect(handler.submit(request({ url: "http://cdn.example/m.png" }), {})).rejects.toThrow(
      message
    );
    await expect(handler.submit(request({ url: "not a url" }), {})).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a group other than aigc", async () => {
    const fetchMock = stubFetch();
    const liveness = request({ group: "liveness" as unknown as "aigc" });

    await expect(createAssetHandler(createTestCtx()).submit(liveness, {})).rejects.toThrow(
      '[ai] ark asset group "liveness" is not supported.\n  Use group "aigc" or leave it out.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an image outside the local limits as a plain error", async () => {
    const fetchMock = stubFetch();
    const handler = createAssetHandler(createTestCtx());
    const small = temp.file("small.png", pngHeader(200, 200), "image/png");
    const gif = temp.file("face.gif", pngHeader(1024, 1024), "image/gif");
    const junk = temp.file("junk.png", new Uint8Array([1, 2, 3]), "image/png");

    const error = await rejectionOf(handler.submit(request({ image: small }), {}));
    expect(error).not.toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      '[ai] ark asset image "small.png" is 200x200 px; each side must be 300 to 6000 px.\n  Resize the image.'
    );
    await expect(handler.submit(request({ image: gif }), {})).rejects.toThrow("is image/gif.");
    await expect(handler.submit(request({ image: junk, name: "Mira" }), {})).rejects.toThrow(
      '[ai] ark cannot read the image size of "Mira".\n  Use a PNG, JPEG or WebP file.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("submit", () => {
  it("creates the asset in config.groupId with a signed call and returns groupId/assetId", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_ASSET_RESPONSE));
    const handler = createAssetHandler(createTestCtx({ config: { groupId: GROUP_ID } }));

    expect(await handler.submit(request(), {})).toEqual({ jobId: JOB_ID });

    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(intlActionUrl("CreateAsset"));
    expect(jsonBodyOf(call)).toEqual(CREATE_ASSET_REQUEST);
    expect(call?.headers.Authorization).toContain(`Credential=${TEST_ACCESS_KEY}/`);
  });

  it("sends request.name when given, cut to 64 characters", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, CREATE_ASSET_RESPONSE),
      jsonResponse(200, CREATE_ASSET_RESPONSE)
    );
    const handler = createAssetHandler(createTestCtx({ config: { groupId: GROUP_ID } }));

    await handler.submit(request({ name: "Mira" }), {});
    await handler.submit(request({ name: "x".repeat(70) }), {});

    const [first, second] = callsOf(fetchMock);
    expect(jsonBodyOf(first)).toEqual({ ...CREATE_ASSET_REQUEST, Name: "Mira" });
    expect(jsonBodyOf(second)).toEqual({ ...CREATE_ASSET_REQUEST, Name: "x".repeat(64) });
  });

  it("creates the group once with CreateAssetGroup when groupId is null, and logs its id", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE),
      jsonResponse(200, CREATE_ASSET_RESPONSE),
      jsonResponse(200, CREATE_ASSET_RESPONSE)
    );
    const ctx = createTestCtx();
    const handler = createAssetHandler(ctx);

    await handler.submit(request(), {});
    await handler.submit(request(), {});

    const calls = callsOf(fetchMock);
    expect(calls.map(call => call.url)).toEqual([
      intlActionUrl("CreateAssetGroup"),
      intlActionUrl("CreateAsset"),
      intlActionUrl("CreateAsset")
    ]);
    expect(jsonBodyOf(calls[0])).toEqual(CREATE_ASSET_GROUP_REQUEST);
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:asset:group-created", {
      groupId: GROUP_ID,
      hint: "set ark config groupId to reuse it"
    });
  });

  it("uses the configured group name", async () => {
    const fetchMock = stubFetch(
      jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE),
      jsonResponse(200, CREATE_ASSET_RESPONSE)
    );

    await createAssetHandler(createTestCtx({ config: { groupName: "cliffhanger" } })).submit(
      request(),
      {}
    );

    expect(jsonBodyOf(callsOf(fetchMock)[0])).toEqual({ GroupType: "AIGC", Name: "cliffhanger" });
  });

  it("creates the group only once for concurrent submits", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("CreateAssetGroup")
        ? jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE)
        : jsonResponse(200, CREATE_ASSET_RESPONSE)
    );
    vi.stubGlobal("fetch", fetchMock);
    const handler = createAssetHandler(createTestCtx());

    const results = await Promise.all([
      handler.submit(request(), {}),
      handler.submit(request(), {}),
      handler.submit(request(), {})
    ]);

    expect(results).toEqual([{ jobId: JOB_ID }, { jobId: JOB_ID }, { jobId: JOB_ID }]);
    const groupCalls = fetchMock.mock.calls.filter(([url]) => url.includes("CreateAssetGroup"));
    expect(groupCalls).toHaveLength(1);
  });

  it("forgets a failed group creation, so the next submit tries again", async () => {
    stubFetch(
      jsonResponse(403, OPENAPI_ERROR_ACCESS_DENIED),
      jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE),
      jsonResponse(200, CREATE_ASSET_RESPONSE)
    );
    const ctx = createTestCtx();
    const handler = createAssetHandler(ctx);

    const error = await rejectionOf(handler.submit(request(), {}));
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 403, code: "AccessDenied" });
    expect(ctx.state.group).toBeNull();

    expect(await handler.submit(request(), {})).toEqual({ jobId: JOB_ID });
  });

  it("maps the OpenAPI error envelope of CreateAsset", async () => {
    stubFetch(jsonResponse(400, OPENAPI_ERROR_INVALID));
    const handler = createAssetHandler(createTestCtx({ config: { groupId: GROUP_ID } }));

    const error = await rejectionOf(handler.submit(request(), {}));

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400, code: "InvalidParameter" });
  });

  it("throws retryable 502 when CreateAsset returns no Id", async () => {
    stubFetch(jsonResponse(200, { Result: {} }));
    const handler = createAssetHandler(createTestCtx({ config: { groupId: GROUP_ID } }));

    expect(await rejectionOf(handler.submit(request(), {}))).toMatchObject({ status: 502 });
  });

  it("throws retryable 502 when CreateAssetGroup returns no Id", async () => {
    stubFetch(jsonResponse(200, { Result: {} }));

    const error = await rejectionOf(createAssetHandler(createTestCtx()).submit(request(), {}));

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as Error).message).toContain("CreateAssetGroup");
  });
});

describe("poll", () => {
  it("is pending while the asset is Processing, via a signed GetAsset", async () => {
    const fetchMock = stubFetch(jsonResponse(200, GET_ASSET_PROCESSING));

    const result = await createAssetHandler(createTestCtx()).poll(JOB_ID, request(), {});

    expect(result).toEqual({ state: "pending" });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(intlActionUrl("GetAsset"));
    expect(jsonBodyOf(call)).toEqual(GET_ASSET_REQUEST);
  });

  it("is done with the encoded record under ASSET_MIME once Active", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    stubFetch(jsonResponse(200, GET_ASSET_ACTIVE));
    const ctx = createTestCtx();

    const result = await createAssetHandler(ctx).poll(JOB_ID, request(), {});

    const record = {
      assetId: ASSET_ID,
      provider: "ark",
      account: INTL_ACCOUNT,
      groupId: GROUP_ID,
      registeredAt: NOW
    };
    expect(result).toEqual({
      state: "done",
      body: encodeAssetRecord(record),
      mimeType: ASSET_MIME,
      costUsd: 0,
      meta: { assetId: ASSET_ID, account: INTL_ACCOUNT }
    });
    expect(result.state === "done" && parseAssetRecord(result.body)).toEqual(record);
    expect(ctx.log.info).toHaveBeenCalledWith("ark:asset:registered", {
      assetId: ASSET_ID,
      account: INTL_ACCOUNT
    });
  });

  it("is failed with a flagged error naming the reason when Failed", async () => {
    stubFetch(jsonResponse(200, GET_ASSET_FAILED));
    const ctx = createTestCtx();

    const error = failedError(await createAssetHandler(ctx).poll(JOB_ID, request(), {}));

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect(error).toMatchObject({ kind: "content-policy" });
    expect((error as Error).message).toBe(
      '[ai] ark refused asset "mira.png": No human face detected in the image.\n  Items that use it will not run.'
    );
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:asset:refused", {
      name: "mira.png",
      reason: "No human face detected in the image"
    });
  });

  it("names the refusal with request.name and a missing reason", async () => {
    const failed = {
      Result: { Id: ASSET_ID, Status: "Failed" }
    };
    stubFetch(jsonResponse(200, failed));

    const error = failedError(
      await createAssetHandler(createTestCtx()).poll(JOB_ID, request({ name: "Mira" }), {})
    );

    expect((error as Error).message).toBe(
      '[ai] ark refused asset "Mira": no reason given.\n  Items that use it will not run.'
    );
  });

  it("says no reason given when FailedReason is empty", async () => {
    stubFetch(jsonResponse(200, { Result: { Id: ASSET_ID, Status: "Failed", FailedReason: "" } }));

    const error = failedError(
      await createAssetHandler(createTestCtx()).poll(JOB_ID, request(), {})
    );

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(
      '[ai] ark refused asset "mira.png": no reason given.\n  Items that use it will not run.'
    );
  });

  it("stays pending on an unknown status, with a warning", async () => {
    stubFetch(jsonResponse(200, { Result: { Id: ASSET_ID, Status: "Queued" } }));
    const ctx = createTestCtx();

    expect(await createAssetHandler(ctx).poll(JOB_ID, request(), {})).toEqual({ state: "pending" });
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:asset:unknown-status", {
      assetId: ASSET_ID,
      status: "Queued"
    });
  });

  it("throws retryable 429 on an OpenAPI Throttling error", async () => {
    stubFetch(jsonResponse(400, OPENAPI_ERROR_THROTTLING));

    const error = await rejectionOf(
      createAssetHandler(createTestCtx()).poll(JOB_ID, request(), {})
    );

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429 });
  });

  it("throws a plain error for a job id that is not groupId/assetId", async () => {
    const fetchMock = stubFetch();

    await expect(
      createAssetHandler(createTestCtx()).poll("asset-only", request(), {})
    ).rejects.toThrow(
      '[ai] ark asset job id "asset-only" is not valid.\n  Expected "<groupId>/<assetId>" from ark submit.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never logs a key or a URL", async () => {
    stubFetch(
      jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE),
      jsonResponse(200, CREATE_ASSET_RESPONSE),
      jsonResponse(200, GET_ASSET_ACTIVE)
    );
    const ctx = createTestCtx();
    const handler = createAssetHandler(ctx);

    const { jobId } = await handler.submit(request(), {});
    await handler.poll(jobId, request(), {});

    const logged = loggedText(ctx);
    expect(logged).not.toContain(TEST_ACCESS_KEY);
    expect(logged).not.toContain(TEST_SECRET_KEY);
    expect(logged).not.toContain("https://");
  });
});
