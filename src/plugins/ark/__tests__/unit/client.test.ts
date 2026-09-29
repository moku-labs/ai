import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArkFetchOptions, ArkInit } from "../../client";
import {
  arkFetch,
  flaggedError,
  openApiCall,
  readJson,
  readNumber,
  readString,
  unreadableResponse
} from "../../client";
import { FlaggedProviderError, RetryableProviderError, TerminalProviderError } from "../../types";
import {
  CREATE_ASSET_GROUP_REQUEST,
  CREATE_ASSET_GROUP_RESPONSE,
  callsOf,
  createFakeEnv,
  createTestCtx,
  ERROR_INTERNAL,
  ERROR_INVALID_PARAMETER,
  ERROR_RATE_LIMIT,
  ERROR_SENSITIVE_IMAGE,
  ERROR_SENSITIVE_TEXT,
  GET_ASSET_REQUEST,
  GROUP_ID,
  INTL_TASKS_URL,
  intlActionUrl,
  jsonBodyOf,
  jsonResponse,
  OPENAPI_ERROR_ACCESS_DENIED,
  OPENAPI_ERROR_INVALID,
  OPENAPI_ERROR_QUOTA,
  OPENAPI_ERROR_THROTTLING,
  stubFetch,
  TEST_ACCESS_KEY,
  TEST_API_KEY
} from "../fixtures";

const LABEL = "/contents/generations/tasks";
const INIT: ArkInit = {
  method: "POST",
  headers: { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" },
  body: '{"model":"m"}'
};
const OPTIONS: ArkFetchOptions = { timeoutMs: 5000, label: LABEL };
const FACE_MESSAGE =
  "[ai] ark refused an image with a face: InputImageSensitiveContentDetected.PrivacyInformation.\n  Make it an asset item and $ref it.";
const ENTITLEMENT_HINT =
  "\n  Check the Seedance Advanced Creation Rights and the AIGC authorization letter in the Ark console.";

/** Runs `arkFetch` and returns what it threw. */
async function rejectionOf(options: ArkFetchOptions = OPTIONS): Promise<unknown> {
  try {
    await arkFetch(INTL_TASKS_URL, INIT, options);
  } catch (error) {
    return error;
  }
  throw new Error("expected arkFetch to reject");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("arkFetch request shape", () => {
  it("sends the method, headers and body and returns status + body bytes", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { id: "cgt-1" }));

    const response = await arkFetch(INTL_TASKS_URL, INIT, OPTIONS);

    expect(response.status).toBe(200);
    expect(readJson(response)).toEqual({ id: "cgt-1" });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(INTL_TASKS_URL);
    expect(call?.method).toBe("POST");
    expect(call?.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(call?.body).toBe('{"model":"m"}');
  });

  it("sends a GET without a body", async () => {
    const fetchMock = stubFetch(new Response(new Uint8Array([7, 8]), { status: 200 }));

    const response = await arkFetch("https://cdn.example/v.mp4", { method: "GET" }, OPTIONS);

    expect(response.body).toEqual(new Uint8Array([7, 8]));
    expect(callsOf(fetchMock)[0]?.body).toBeUndefined();
  });
});

describe("arkFetch error mapping", () => {
  it("429 is retryable with Retry-After seconds in ms", async () => {
    stubFetch(jsonResponse(429, ERROR_RATE_LIMIT, { "retry-after": "3" }));

    const error = await rejectionOf();

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 3000 });
    expect((error as Error).message).toBe(`[ai] ark rate-limited ${LABEL} (HTTP 429).`);
  });

  it("429 reads an HTTP-date Retry-After as the ms until that date", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-29T12:00:00Z"));
    stubFetch(
      jsonResponse(429, ERROR_RATE_LIMIT, { "retry-after": "Tue, 29 Sep 2026 12:00:05 GMT" })
    );

    expect(await rejectionOf()).toMatchObject({ status: 429, retryAfterMs: 5000 });
  });

  it("429 without Retry-After has no delay hint", async () => {
    stubFetch(jsonResponse(429, ERROR_RATE_LIMIT));
    const error = await rejectionOf();
    expect(error).toMatchObject({ status: 429 });
    expect((error as RetryableProviderError).retryAfterMs).toBeUndefined();
  });

  it("429 ignores an unreadable Retry-After", async () => {
    stubFetch(jsonResponse(429, ERROR_RATE_LIMIT, { "retry-after": "soon" }));
    expect((await rejectionOf()) as RetryableProviderError).toMatchObject({
      retryAfterMs: undefined
    });
  });

  it("5xx is retryable with its status", async () => {
    stubFetch(jsonResponse(500, ERROR_INTERNAL));

    const error = await rejectionOf();

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 500 });
    expect((error as Error).message).toBe(`[ai] ark returned HTTP 500 for ${LABEL}.`);
  });

  it("a timeout is retryable with kind timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await rejectionOf({ ...OPTIONS, timeoutMs: 5 });

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as Error).message).toBe(`[ai] ark request timed out (${LABEL}).`);
  });

  it("a network failure is retryable with kind network", async () => {
    stubFetch(new TypeError("fetch failed"));

    const error = await rejectionOf();

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ kind: "network" });
  });

  it("rethrows the caller's abort unchanged", async () => {
    const controller = new AbortController();
    const reason = new Error("paused");
    controller.abort(reason);
    stubFetch(reason);

    expect(await rejectionOf({ ...OPTIONS, signal: controller.signal })).toBe(reason);
  });

  it("a 400 SensitiveContent refusal with a local image is flagged with the asset hint", async () => {
    stubFetch(jsonResponse(400, ERROR_SENSITIVE_IMAGE));

    const error = await rejectionOf({ ...OPTIONS, localImage: true });

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect(error).toMatchObject({ kind: "content-policy" });
    expect((error as Error).message).toBe(FACE_MESSAGE);
  });

  it("a 422 SensitiveContent refusal without a local image is flagged with the prompt hint", async () => {
    stubFetch(jsonResponse(422, ERROR_SENSITIVE_TEXT));

    const error = await rejectionOf();

    expect(error).toBeInstanceOf(FlaggedProviderError);
    expect((error as Error).message).toBe(
      "[ai] ark flagged the request: InputTextSensitiveContentDetected.\n  Change the prompt or the inputs."
    );
  });

  it("another 4xx is terminal with the status, the code and ark's message", async () => {
    stubFetch(jsonResponse(400, ERROR_INVALID_PARAMETER));

    const error = await rejectionOf();

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400, code: "InvalidParameter" });
    expect((error as Error).message).toBe(
      `[ai] ark ${LABEL} failed (400 InvalidParameter): The parameter \`ratio\` specified in the request is not valid.`
    );
  });

  it("cuts a long ark message and drops an empty one", async () => {
    stubFetch(
      jsonResponse(400, { error: { code: "InvalidParameter", message: `${"x".repeat(400)}.` } })
    );
    const long = (await rejectionOf()) as Error;
    expect(long.message).toBe(
      `[ai] ark ${LABEL} failed (400 InvalidParameter): ${"x".repeat(300)}....`
    );

    stubFetch(jsonResponse(400, { error: { code: "InvalidParameter", message: "  " } }));
    expect(((await rejectionOf()) as Error).message).toBe(
      `[ai] ark ${LABEL} failed (400 InvalidParameter).`
    );
  });

  it("a 4xx without a readable body is terminal with the status only", async () => {
    stubFetch(new Response("not json", { status: 404 }));

    const error = await rejectionOf();

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(`[ai] ark ${LABEL} failed (404).`);
  });
});

describe("arkFetch OpenAPI envelope errors", () => {
  it("Throttling* is retryable as 429", async () => {
    stubFetch(jsonResponse(400, OPENAPI_ERROR_THROTTLING, { "retry-after": "2" }));

    const error = await rejectionOf({ ...OPTIONS, label: "GetAsset" });

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 2000 });
    expect((error as Error).message).toBe(
      "[ai] ark GetAsset was throttled (Throttling.User).\n  The runner retries it."
    );
  });

  it.each([
    "Throttling",
    "RequestLimitExceeded",
    "FlowLimitExceeded",
    "TooManyRequests"
  ])("a %s* code is retryable as 429", async prefix => {
    const code = `${prefix}.Account`;
    stubFetch(
      jsonResponse(400, { ResponseMetadata: { Error: { Code: code, Message: "slow down" } } })
    );

    const error = await rejectionOf({ ...OPTIONS, label: "GetAsset" });

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 429 });
    expect((error as Error).message).toContain(`(${code})`);
  });

  it("AccessDenied is terminal with the entitlement hint", async () => {
    stubFetch(jsonResponse(403, OPENAPI_ERROR_ACCESS_DENIED));

    const error = await rejectionOf({ ...OPTIONS, label: "CreateAssetGroup" });

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 403, code: "AccessDenied" });
    expect((error as Error).message).toBe(
      `[ai] ark CreateAssetGroup failed (403 AccessDenied): User is not authorized to perform: ark:CreateAssetGroup.${ENTITLEMENT_HINT}`
    );
  });

  it("QuotaExceeded and InvalidAuthorization* are terminal with the entitlement hint", async () => {
    stubFetch(jsonResponse(400, OPENAPI_ERROR_QUOTA));
    const quota = await rejectionOf({ ...OPTIONS, label: "CreateAssetGroup" });
    expect((quota as Error).message).toContain(ENTITLEMENT_HINT);

    stubFetch(
      jsonResponse(401, {
        ResponseMetadata: { Error: { Code: "InvalidAuthorization", Message: "bad signature" } }
      })
    );
    const authorization = await rejectionOf({ ...OPTIONS, label: "GetAsset" });
    expect(authorization).toMatchObject({ status: 401, code: "InvalidAuthorization" });
    expect((authorization as Error).message).toContain(ENTITLEMENT_HINT);
  });

  it("any other code is terminal with the status", async () => {
    stubFetch(jsonResponse(400, OPENAPI_ERROR_INVALID));

    const error = await rejectionOf({ ...OPTIONS, label: "CreateAsset" });

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] ark CreateAsset failed (400 InvalidParameter): The specified parameter URL is invalid."
    );
  });
});

describe("openApiCall", () => {
  it("POSTs the signed JSON body to the action URL and returns Result", async () => {
    const fetchMock = stubFetch(jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE));

    const result = await openApiCall(
      createTestCtx(),
      "CreateAssetGroup",
      CREATE_ASSET_GROUP_REQUEST
    );

    expect(result).toEqual({ Id: GROUP_ID });
    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe(intlActionUrl("CreateAssetGroup"));
    expect(call?.method).toBe("POST");
    expect(jsonBodyOf(call)).toEqual(CREATE_ASSET_GROUP_REQUEST);
    expect(call?.headers["Content-Type"]).toBe("application/json");
    expect(call?.headers.Host).toBe("ark.ap-southeast-1.byteplusapi.com");
    expect(call?.headers["X-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(call?.headers["X-Content-Sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.headers.Authorization).toMatch(
      new RegExp(
        String.raw`^HMAC-SHA256 Credential=${TEST_ACCESS_KEY}/\d{8}/ap-southeast-1/ark/request, `
      )
    );
  });

  it("signs for cn-beijing on the Volcengine control plane", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: { Id: "asset-1" } }));

    await openApiCall(createTestCtx({ config: { region: "cn" } }), "GetAsset", GET_ASSET_REQUEST);

    const [call] = callsOf(fetchMock);
    expect(call?.url).toBe("https://open.volcengineapi.com/?Action=GetAsset&Version=2024-01-01");
    expect(call?.headers.Authorization).toContain("/cn-beijing/ark/request, ");
  });

  it("uses the controlUrl override", async () => {
    const fetchMock = stubFetch(jsonResponse(200, { Result: {} }));

    await openApiCall(
      createTestCtx({ config: { controlUrl: "https://proxy.example/ark/" } }),
      "GetAsset",
      GET_ASSET_REQUEST
    );

    expect(callsOf(fetchMock)[0]?.url).toBe(
      "https://proxy.example/ark/?Action=GetAsset&Version=2024-01-01"
    );
  });

  it("maps an Error in a 2xx envelope like an HTTP 400", async () => {
    stubFetch(jsonResponse(200, OPENAPI_ERROR_INVALID));

    const error = await openApiCall(createTestCtx(), "CreateAsset", {
      GroupId: GROUP_ID,
      URL: "u",
      AssetType: "Image",
      Name: "n"
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400, code: "InvalidParameter" });
  });

  it("throws retryable 502 when the envelope has no Result", async () => {
    stubFetch(jsonResponse(200, { ResponseMetadata: {} }));

    const error = await openApiCall(createTestCtx(), "GetAsset", GET_ASSET_REQUEST).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error).toMatchObject({ status: 502 });
    expect((error as Error).message).toBe(
      "[ai] ark GetAsset returned an unreadable response.\n  The runner asks again."
    );
  });

  it("throws before any fetch when the secret key is not set", async () => {
    const fetchMock = stubFetch();
    const ctx = createTestCtx({ env: createFakeEnv({ ARK_ACCESS_KEY: TEST_ACCESS_KEY }) });

    await expect(openApiCall(ctx, "GetAsset", GET_ASSET_REQUEST)).rejects.toThrow(
      'required variable "ARK_SECRET_KEY"'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("flaggedError picks the message by the local-image rule", () => {
    const code = "InputImageSensitiveContentDetected.PrivacyInformation";
    expect(flaggedError(code, true).message).toBe(FACE_MESSAGE);
    expect(flaggedError(code, false).message).toBe(
      `[ai] ark flagged the request: ${code}.\n  Change the prompt or the inputs.`
    );
  });

  it("unreadableResponse is retryable 502", () => {
    expect(unreadableResponse("x")).toMatchObject({ status: 502 });
  });

  it("readJson returns undefined for a body that is not JSON", () => {
    const body = new TextEncoder().encode("<html>");
    expect(readJson({ status: 200, headers: new Headers(), body })).toBeUndefined();
  });

  it("readString and readNumber narrow untrusted values", () => {
    expect(readString({ id: "a" }, "id")).toBe("a");
    expect(readString({ id: 1 }, "id")).toBeUndefined();
    expect(readString(JSON.parse("null"), "id")).toBeUndefined();
    expect(readNumber({ n: 2 }, "n")).toBe(2);
    expect(readNumber({ n: "2" }, "n")).toBeUndefined();
    expect(readNumber(undefined, "n")).toBeUndefined();
  });
});
