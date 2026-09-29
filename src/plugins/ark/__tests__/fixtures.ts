/**
 * @file ark test fixtures. Two parts:
 * 1. Documented examples: request bodies and responses of the Ark video task
 *    API and the Ark asset OpenAPI, each with a `// source:` URL. What no
 *    source confirms carries an `// unverified:` note. A doc field the
 *    handler does not use stays in the fixture, so the fixture stays a copy
 *    of the doc. Outgoing bodies are asserted with `toEqual` against
 *    these; incoming ones are fed through the handlers.
 * 2. Test helpers: fake `ArkContext`, fake `registry`/`env`/`log`, a scripted
 *    `fetch`, temp files and image headers.
 * NOT a test file itself (no `.test.ts` suffix), so vitest does not collect it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvApi, LogApi } from "@moku-labs/common";
import { vi } from "vitest";
import type { AssetRecord } from "../../asset/contract";
import { ASSET_MIME, encodeAssetRecord } from "../../asset/contract";
import type { VideoFile } from "../../video/contract";
import type { OpenApiBodies } from "../client";
import type { ArkContext, Config, RegistryApi, State } from "../types";

// ─── Documented examples: Ark video generation task API (data plane) ────────

// source: https://github.com/Comfy-Org/ComfyUI/issues/13883 (real failed-task body, task id format)
/** Task id used across the documented task examples (real format: `cgt-<yyyyMMddHHmmss>-<5 chars>`). */
export const TASK_ID = "cgt-20260929120000-a1b2c";

/** Clip URL of the documented succeeded task (expires 24 h after success). */
export const VIDEO_URL =
  "https://ark-content-generation-ap-southeast-1.tos-ap-southeast-1.volces.com/dreamina-seedance-2-0/cgt-20260929120000-a1b2c.mp4?X-Tos-Expires=86400";

/** Last-frame URL of the documented succeeded task (`return_last_frame: true`). */
export const LAST_FRAME_URL =
  "https://ark-content-generation-ap-southeast-1.tos-ap-southeast-1.volces.com/dreamina-seedance-2-0/cgt-20260929120000-a1b2c-last.png?X-Tos-Expires=86400";

/** Bytes of the local test image. Base64 "AQID". */
export const LOCAL_IMAGE_BYTES = new Uint8Array([1, 2, 3]);

/** The data URI Ark takes for {@link LOCAL_IMAGE_BYTES} as a PNG. */
export const LOCAL_IMAGE_DATA_URI = "data:image/png;base64,AQID";

/** Asset id used across the documented asset examples. */
export const ASSET_ID = "asset-20260929120001-fghij";

/** AIGC group id used across the documented asset examples. */
export const GROUP_ID = "group-20260929120000-abcde";

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/src/ark_mcp/providers/modelark/seedance.py (create-task body: image to video, first frame)
export const CREATE_TASK_REQUEST_FIRST_FRAME = {
  model: "dreamina-seedance-2-0-260128",
  content: [
    { type: "text", text: "A girl walks into the rain, the camera follows her" },
    { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "first_frame" }
  ],
  ratio: "9:16",
  duration: 5,
  resolution: "720p",
  generate_audio: false,
  watermark: false
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/src/ark_mcp/providers/modelark/seedance.py (create-task body: first and last frame)
export const CREATE_TASK_REQUEST_FIRST_LAST_FRAME = {
  model: "dreamina-seedance-2-0-260128",
  content: [
    { type: "text", text: "The girl turns around and smiles" },
    { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "first_frame" },
    { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "last_frame" }
  ],
  ratio: "adaptive",
  duration: 5,
  resolution: "720p",
  generate_audio: false,
  watermark: false
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/src/ark_mcp/providers/modelark/seedance.py (create-task body: a registered asset as the first frame)
// unverified: sources show asset:// only as reference_image; an upstream 400 surfaces as terminal
export const CREATE_TASK_REQUEST_ASSET_FIRST_FRAME = {
  model: "dreamina-seedance-2-0-260128",
  content: [
    { type: "text", text: "image 1 walks into the rain" },
    { type: "image_url", image_url: { url: `asset://${ASSET_ID}` }, role: "first_frame" }
  ],
  ratio: "9:16",
  duration: 5,
  resolution: "720p",
  generate_audio: false,
  watermark: false
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/src/ark_mcp/providers/modelark/seedance.py (create-task body: multimodal reference to video)
// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (asset://<id> as a reference_image)
export const CREATE_TASK_REQUEST_REFERENCES = {
  model: "dreamina-seedance-2-0-260128",
  content: [
    { type: "text", text: "image 1 walks down the street of image 2 to the beat of audio 1" },
    { type: "image_url", image_url: { url: `asset://${ASSET_ID}` }, role: "reference_image" },
    { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "reference_image" },
    {
      type: "video_url",
      video_url: { url: "https://cdn.example/motion/walk.mp4" },
      role: "reference_video"
    },
    {
      type: "audio_url",
      audio_url: { url: "https://cdn.example/audio/rain.mp3" },
      role: "reference_audio"
    }
  ],
  ratio: "9:16",
  duration: 10,
  resolution: "720p",
  generate_audio: true,
  watermark: false
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/src/ark_mcp/providers/modelark/seedance.py (create-task body: text to video with optional parameters)
export const CREATE_TASK_REQUEST_TEXT_PARAMS = {
  model: "dreamina-seedance-2-0-260128",
  content: [{ type: "text", text: "A city skyline at dusk, slow aerial push-in" }],
  ratio: "16:9",
  duration: 8,
  resolution: "1080p",
  generate_audio: true,
  watermark: true,
  return_last_frame: true,
  execution_expires_after: 3600
};

// unverified: the cn (Volcengine) body and host are in no source; this mirrors the intl body
export const CREATE_TASK_REQUEST_CN_FIRST_FRAME = {
  model: "doubao-seedance-2-0-260128",
  content: [
    { type: "text", text: "A girl walks into the rain, the camera follows her" },
    { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "first_frame" }
  ],
  ratio: "9:16",
  duration: 5,
  resolution: "720p",
  generate_audio: false,
  watermark: false
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (create task, response)
export const CREATE_TASK_RESPONSE = { id: TASK_ID };

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (get task, response: queued)
export const GET_TASK_QUEUED = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "queued",
  created_at: 1_790_683_200,
  updated_at: 1_790_683_200,
  service_tier: "default",
  execution_expires_after: 172_800
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (list tasks, response: running)
export const GET_TASK_RUNNING = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "running",
  created_at: 1_790_683_200,
  updated_at: 1_790_683_210,
  service_tier: "default",
  execution_expires_after: 172_800
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (get task, response: succeeded, with last_frame_url)
// unverified: usage.total_tokens is in no source (the source shows completion_tokens and prompt_tokens)
export const GET_TASK_SUCCEEDED = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "succeeded",
  content: { video_url: VIDEO_URL, last_frame_url: LAST_FRAME_URL },
  usage: { completion_tokens: 108_900, total_tokens: 108_900 },
  created_at: 1_790_683_200,
  updated_at: 1_790_683_254,
  seed: 58_920,
  resolution: "720p",
  ratio: "9:16",
  duration: 5,
  framespersecond: 24,
  generate_audio: false,
  service_tier: "default",
  execution_expires_after: 172_800
};

// unverified: the cn (Volcengine) response and host are in no source; this mirrors the intl response
// unverified: usage.total_tokens is in no source
export const GET_TASK_SUCCEEDED_CN = {
  id: TASK_ID,
  model: "doubao-seedance-2-0-260128",
  status: "succeeded",
  content: { video_url: VIDEO_URL },
  usage: { completion_tokens: 108_900, total_tokens: 108_900 },
  created_at: 1_790_683_200,
  updated_at: 1_790_683_254,
  seed: 11_021,
  resolution: "720p",
  ratio: "9:16",
  duration: 5,
  framespersecond: 24,
  generate_audio: false,
  service_tier: "default",
  execution_expires_after: 172_800
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (get task, response: failed with error.code / error.message)
// source: https://github.com/Comfy-Org/ComfyUI/issues/13883 (real failed-task body)
export const GET_TASK_FAILED_SENSITIVE = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "failed",
  error: {
    code: "InputImageSensitiveContentDetected.PrivacyInformation",
    message: "The request failed because the input image may contain a real person."
  },
  created_at: 1_790_683_200,
  updated_at: 1_790_683_203,
  service_tier: "default",
  execution_expires_after: 172_800
};

// source: https://github.com/Comfy-Org/ComfyUI/issues/13883 (real failed-task body; the real one carries OutputAudioSensitiveContentDetected)
// unverified: OutputVideoSensitiveContentDetected is named by analogy with the real OutputAudio code
export const GET_TASK_FAILED_OUTPUT_VIDEO = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "failed",
  error: {
    code: "OutputVideoSensitiveContentDetected",
    message:
      "The request failed because the output video may contain sensitive information. Request id: 02177872492196700000000000000000000ffffc0a87832ba9e04"
  },
  generate_audio: false
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (get task, response: failed)
// unverified: InvalidParameter as a video task error code is in no source
export const GET_TASK_FAILED = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "failed",
  error: {
    code: "InvalidParameter",
    message: "The parameter `duration` specified in the request is not valid."
  },
  created_at: 1_790_683_200,
  updated_at: 1_790_683_203,
  service_tier: "default",
  execution_expires_after: 172_800
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (get task, response: expired)
export const GET_TASK_EXPIRED = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "expired",
  created_at: 1_790_683_200,
  updated_at: 1_790_856_000,
  service_tier: "default",
  execution_expires_after: 172_800
};

// unverified: the cancelled task status is in no source
export const GET_TASK_CANCELLED = {
  id: TASK_ID,
  model: "dreamina-seedance-2-0-260128",
  status: "cancelled",
  created_at: 1_790_683_200,
  updated_at: 1_790_683_230,
  service_tier: "default",
  execution_expires_after: 172_800
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (error body: error.code / error.message)
// unverified: error.param and error.type are in no source
export const ERROR_SENSITIVE_IMAGE = {
  error: {
    code: "InputImageSensitiveContentDetected.PrivacyInformation",
    message: "The request failed because the input image may contain a real person.",
    param: "",
    type: "BadRequest"
  }
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (error body: error.code / error.message)
// unverified: InputTextSensitiveContentDetected is in no source; error.param and error.type are in no source
export const ERROR_SENSITIVE_TEXT = {
  error: {
    code: "InputTextSensitiveContentDetected",
    message: "The request failed because the input text may contain sensitive information.",
    param: "",
    type: "BadRequest"
  }
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (error body: error.code / error.message)
// unverified: InvalidParameter for the video API is in no source; error.param and error.type are in no source
export const ERROR_INVALID_PARAMETER = {
  error: {
    code: "InvalidParameter",
    message: "The parameter `ratio` specified in the request is not valid.",
    param: "ratio",
    type: "BadRequest"
  }
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (error body: error.code / error.message)
// unverified: RateLimitExceeded.EndpointRPMExceeded is in no source; error.param and error.type are in no source
export const ERROR_RATE_LIMIT = {
  error: {
    code: "RateLimitExceeded.EndpointRPMExceeded",
    message: "The request has exceeded the RPM rate limit.",
    param: "",
    type: "TooManyRequests"
  }
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_seedance_adapter.py (error body: error.code / error.message)
// unverified: InternalServiceError is in no source; error.param and error.type are in no source
export const ERROR_INTERNAL = {
  error: {
    code: "InternalServiceError",
    message: "The service encountered an unexpected internal error.",
    param: "",
    type: "InternalServerError"
  }
};

// ─── Documented examples: Ark asset OpenAPI (control plane, signed) ─────────
// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/scripts/ark_openapi_sign.py (signing: host, Action/Version query, signed headers)

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_modelark_openapi_gateway.py (envelope: RequestId, Action, Version, Error?)
/** Response metadata of the documented OpenAPI examples. */
function responseMetadata(action: string): Record<string, string> {
  return {
    RequestId: "20260929120000A1B2C3D4E5F6A7B8C9",
    Action: action,
    Version: "2024-01-01"
  };
}

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (CreateAssetGroup, request)
export const CREATE_ASSET_GROUP_REQUEST: OpenApiBodies["CreateAssetGroup"] = {
  GroupType: "AIGC",
  Name: "moku-ai"
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (CreateAssetGroup, response)
export const CREATE_ASSET_GROUP_RESPONSE = {
  ResponseMetadata: responseMetadata("CreateAssetGroup"),
  Result: { Id: GROUP_ID }
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (CreateAsset, request)
export const CREATE_ASSET_REQUEST: OpenApiBodies["CreateAsset"] = {
  GroupId: GROUP_ID,
  URL: "https://cdn.example/faces/mira.png",
  AssetType: "Image",
  Name: "mira.png"
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (CreateAsset, response)
export const CREATE_ASSET_RESPONSE = {
  ResponseMetadata: responseMetadata("CreateAsset"),
  Result: { Id: ASSET_ID }
};

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (GetAsset, request)
export const GET_ASSET_REQUEST: OpenApiBodies["GetAsset"] = { Id: ASSET_ID };

/** One documented GetAsset result, by status. */
function getAssetResult(
  status: string,
  extra: Record<string, string> = {}
): Record<string, unknown> {
  return {
    ResponseMetadata: responseMetadata("GetAsset"),
    Result: {
      Id: ASSET_ID,
      Name: "mira.png",
      URL: "https://cdn.example/faces/mira.png",
      AssetType: "Image",
      GroupId: GROUP_ID,
      Status: status,
      ProjectName: "default",
      CreateTime: "2026-09-29T12:00:01Z",
      UpdateTime: "2026-09-29T12:00:14Z",
      ...extra
    }
  };
}

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (GetAsset, response: Processing)
export const GET_ASSET_PROCESSING = getAssetResult("Processing");

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (GetAsset, response: Active)
export const GET_ASSET_ACTIVE = getAssetResult("Active");

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (GetAsset, response: Failed)
// unverified: field name not confirmed in any source
export const GET_ASSET_FAILED = getAssetResult("Failed", {
  FailedReason: "No human face detected in the image"
});

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_modelark_openapi_gateway.py (error envelope: ResponseMetadata.Error.Code / .Message)
/** One documented OpenAPI error envelope. */
function openApiError(action: string, code: string, message: string): Record<string, unknown> {
  return {
    ResponseMetadata: { ...responseMetadata(action), Error: { Code: code, Message: message } }
  };
}

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (error envelope: InvalidParameter)
export const OPENAPI_ERROR_INVALID = openApiError(
  "CreateAsset",
  "InvalidParameter",
  "The specified parameter URL is invalid."
);

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/tests/contract/test_modelark_openapi_gateway.py (error envelope: throttling)
// unverified: Throttling.User is in no source (the source shows RequestLimitExceeded)
export const OPENAPI_ERROR_THROTTLING = openApiError(
  "GetAsset",
  "Throttling.User",
  "Request was denied due to user flow control."
);

// unverified: AccessDenied is in no source
export const OPENAPI_ERROR_ACCESS_DENIED = openApiError(
  "CreateAssetGroup",
  "AccessDenied",
  "User is not authorized to perform: ark:CreateAssetGroup."
);

// unverified: QuotaExceeded is in no source (the source lists quota codes as unverified)
export const OPENAPI_ERROR_QUOTA = openApiError(
  "CreateAssetGroup",
  "QuotaExceeded",
  "The number of asset groups has reached the limit of 50."
);

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Default config fixture, matching `arkPlugin`'s own defaults. */
export const DEFAULT_CONFIG: Config = {
  region: "intl",
  apiKeyEnv: "ARK_API_KEY",
  accessKeyEnv: "ARK_ACCESS_KEY",
  secretKeyEnv: "ARK_SECRET_KEY",
  // eslint-disable-next-line unicorn/no-null -- Config.baseUrl is `string | null`: null = the region's URL
  baseUrl: null,
  // eslint-disable-next-line unicorn/no-null -- Config.controlUrl is `string | null`: null = the region's URL
  controlUrl: null,
  // eslint-disable-next-line unicorn/no-null -- Config.groupId is `string | null`: null = create one per process
  groupId: null,
  groupName: "moku-ai",
  timeoutMs: 60_000,
  priceOverrides: {},
  cnyPerUsd: 7.1
};

/** The fake API key every test context resolves (never a real key). */
export const TEST_API_KEY = "test-ark-api-key";

/** The fake access key id every test context resolves. */
export const TEST_ACCESS_KEY = "AKLTtestaccesskey";

/** The fake secret access key every test context resolves. */
export const TEST_SECRET_KEY = "testsecretkey==";

/** `accountOf("intl", TEST_ACCESS_KEY)`, pinned. */
export const INTL_ACCOUNT = "1aea36531116";

/** `accountOf("cn", TEST_ACCESS_KEY)`, pinned. */
export const CN_ACCOUNT = "89079cf1d170";

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/specs/SPEC_MODELARK_ASSET_LIBRARY_CONTRACT.md (verified data-plane base URL)
/** intl data-plane tasks URL. */
export const INTL_TASKS_URL =
  "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

// unverified: the cn host is in no source
/** cn data-plane tasks URL. */
export const CN_TASKS_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks";

// source: https://raw.githubusercontent.com/byteplus-sa/ark-mcp/main/scripts/ark_openapi_sign.py (host and Action/Version query)
/** intl control-plane URL of one OpenAPI action. */
export function intlActionUrl(action: string): string {
  return `https://ark.ap-southeast-1.byteplusapi.com/?Action=${action}&Version=2024-01-01`;
}

/** Builds an in-memory fake mirroring registry's real register/resolve/providers/tasks behavior. */
export function createFakeRegistry(): RegistryApi {
  const handlers = new Map<string, Map<string, unknown>>();
  return {
    register(task, provider, handler) {
      const taskProviders = handlers.get(task) ?? new Map<string, unknown>();
      taskProviders.set(provider, handler);
      handlers.set(task, taskProviders);
    },
    resolve(task, provider) {
      return handlers.get(task)?.get(provider);
    },
    providers(task) {
      return [...(handlers.get(task)?.keys() ?? [])];
    },
    tasks() {
      return [...handlers.keys()];
    }
  };
}

/** Builds a fake `EnvApi` backed by a plain record; defaults to all three ark keys. */
export function createFakeEnv(given?: Record<string, string>): EnvApi {
  const values = given ?? {
    ARK_API_KEY: TEST_API_KEY,
    ARK_ACCESS_KEY: TEST_ACCESS_KEY,
    ARK_SECRET_KEY: TEST_SECRET_KEY
  };
  return {
    get: key => values[key],
    require: key => {
      const value = values[key];
      if (value === undefined)
        throw new Error(`[ai] env: required variable "${key}" is not defined.`);
      return value;
    },
    has: key => key in values,
    getPublic: () => ({ ...values }),
    getPublicMap: () => new Map(Object.entries(values))
  };
}

/** Builds a fake `LogApi` with every method a `vi.fn()` mock. */
export function createFakeLog(): LogApi {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: () => [],
    expect: vi.fn(),
    addSink: vi.fn(),
    reset: vi.fn(),
    clearSinks: vi.fn()
  };
}

/** Per-dependency overrides accepted by {@link createTestCtx}. */
export type TestCtxOverrides = {
  config?: Partial<Config>;
  state?: Partial<State>;
  registry?: RegistryApi;
  env?: EnvApi;
  log?: LogApi;
};

/** Builds a fake `ArkContext`: default config, fresh state, fake registry/env/log. */
export function createTestCtx(overrides: TestCtxOverrides = {}): ArkContext {
  const config: Config = { ...DEFAULT_CONFIG, ...overrides.config };
  const state: State = {
    // eslint-disable-next-line unicorn/no-null -- State.group is `X | null`; mirrors createArkState
    group: null,
    // eslint-disable-next-line unicorn/no-null -- State.account is `X | null`; mirrors createArkState
    account: null,
    activeAssets: new Set(),
    negativeWarned: false,
    ...overrides.state
  };
  const registry = overrides.registry ?? createFakeRegistry();
  const env = overrides.env ?? createFakeEnv();
  const log = overrides.log ?? createFakeLog();
  return { config, state, emit: () => undefined, require: () => registry, env, log };
}

/** Everything any log call of `ctx` received, stringified. */
export function loggedText(ctx: ArkContext): string {
  const log = ctx.log as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return JSON.stringify(
    ["info", "debug", "warn", "error"].flatMap(level => log[level]?.mock.calls ?? [])
  );
}

/** A real JSON `Response` with the given status, body and headers. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return Response.json(body, { status, headers });
}

/** A real binary `Response` (the clip download). */
export function bytesResponse(bytes: Uint8Array, contentType = "video/mp4"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

/** One recorded `fetch` call: URL, method, headers and body. */
export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
};

/** Normalizes a fetch mock's recorded calls into {@link FetchCall}s. */
export function callsOf(fetchMock: ReturnType<typeof vi.fn>): FetchCall[] {
  return fetchMock.mock.calls.map(call => {
    const [url, init] = call as [string, RequestInit | undefined];
    return {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: init?.body
    };
  });
}

/** Parses a recorded call's JSON body. */
export function jsonBodyOf(call: FetchCall | undefined): unknown {
  return JSON.parse(String(call?.body));
}

/** Stubs global `fetch` with responses returned in order; extra calls fail the test. */
export function stubFetch(...responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
  }
  fetchMock.mockRejectedValue(new Error("unexpected extra fetch call"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A temp directory holding real files for `VideoFile` / `AssetFile` inputs. */
export type TempFiles = {
  dir: string;
  /** Writes `bytes` under `name` and returns the file pointing at it. */
  file(name: string, bytes: Uint8Array, mimeType: string, hash?: string): VideoFile;
  /** Writes an encoded asset record under `name` and returns the ASSET_MIME file pointing at it. */
  asset(name: string, record: AssetRecord): VideoFile;
  /** Removes the directory. */
  cleanup(): void;
};

/** Creates a temp directory for file fixtures. */
export function createTempFiles(): TempFiles {
  const dir = mkdtempSync(path.join(tmpdir(), "moku-ark-"));
  const write = (name: string, bytes: Uint8Array, mimeType: string, hash: string): VideoFile => {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, bytes);
    return { path: filePath, mimeType, hash };
  };
  return {
    dir,
    file: (name, bytes, mimeType, hash = "a".repeat(64)) => write(name, bytes, mimeType, hash),
    asset: (name, record) => write(name, encodeAssetRecord(record), ASSET_MIME, "b".repeat(64)),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** An ark asset record of this test account (intl), for {@link TempFiles.asset}. */
export function arkRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    assetId: ASSET_ID,
    provider: "ark",
    account: INTL_ACCOUNT,
    groupId: GROUP_ID,
    registeredAt: 1_790_683_214_000,
    ...overrides
  };
}

/** Writes `value` as big-endian bytes of `width` length. */
function bigEndian(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >> (8 * (width - 1 - index))) & 0xff);
}

/** Writes `value` as little-endian bytes of `width` length. */
function littleEndian(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, index) => (value >> (8 * index)) & 0xff);
}

/** ASCII bytes of `text`. */
function asciiBytes(text: string): number[] {
  return [...text].map(char => char.codePointAt(0) ?? 0);
}

/** A PNG header (signature + IHDR) for a `width` x `height` image. */
export function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...bigEndian(13, 4),
    ...asciiBytes("IHDR"),
    ...bigEndian(width, 4),
    ...bigEndian(height, 4),
    8,
    6,
    0,
    0,
    0
  ]);
}

/** A JPEG header with an EXIF APP1 and a DQT segment before the SOF0 marker. */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    ...bigEndian(8, 2),
    ...asciiBytes("Exif"),
    0,
    0,
    0xff,
    0xdb,
    ...bigEndian(4, 2),
    0,
    1,
    0xff,
    0xc0,
    ...bigEndian(17, 2),
    8,
    ...bigEndian(height, 2),
    ...bigEndian(width, 2),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1
  ]);
}

/** A WebP header whose first chunk is `VP8 `, `VP8L` or `VP8X`. */
export function webpHeader(
  kind: "VP8 " | "VP8L" | "VP8X",
  width: number,
  height: number
): Uint8Array {
  const payloads: Record<typeof kind, number[]> = {
    "VP8 ": [0, 0, 0, 0x9d, 0x01, 0x2a, ...littleEndian(width, 2), ...littleEndian(height, 2)],
    VP8L: [0x2f, ...littleEndian((width - 1) | ((height - 1) << 14), 4)],
    VP8X: [0, 0, 0, 0, ...littleEndian(width - 1, 3), ...littleEndian(height - 1, 3)]
  };
  const payload = payloads[kind];
  return new Uint8Array([
    ...asciiBytes("RIFF"),
    ...littleEndian(payload.length + 12, 4),
    ...asciiBytes("WEBP"),
    ...asciiBytes(kind),
    ...littleEndian(payload.length, 4),
    ...payload
  ]);
}
