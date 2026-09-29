import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createApp } from "../../../../index";
import type { AssetRecord } from "../../../asset/contract";
import { ASSET_MIME, encodeAssetRecord, parseAssetRecord } from "../../../asset/contract";
import type { ArkInfo } from "../../types";
import type { FetchCall } from "../fixtures";
import {
  ASSET_ID,
  bytesResponse,
  CREATE_ASSET_GROUP_REQUEST,
  CREATE_ASSET_GROUP_RESPONSE,
  CREATE_ASSET_REQUEST,
  CREATE_ASSET_RESPONSE,
  CREATE_TASK_REQUEST_ASSET_FIRST_FRAME,
  callsOf,
  GET_ASSET_ACTIVE,
  GET_ASSET_FAILED,
  GET_ASSET_PROCESSING,
  GET_ASSET_REQUEST,
  GET_TASK_SUCCEEDED,
  GROUP_ID,
  INTL_ACCOUNT,
  INTL_TASKS_URL,
  intlActionUrl,
  jsonBodyOf,
  jsonResponse,
  pngHeader,
  TASK_ID,
  TEST_ACCESS_KEY,
  TEST_API_KEY,
  TEST_SECRET_KEY,
  VIDEO_URL
} from "../fixtures";

// ---------------------------------------------------------------------------
// Integration: the full framework (`createApp` from src/index.ts, every
// plugin registered, fal before ark) with fetch stubbed by URL. A build file
// registers one portrait with ark and animates two clips that `$ref` it. The
// fetch mock answers with the documented examples in ../fixtures.ts. No
// request leaves the process.
// ---------------------------------------------------------------------------

/** Bytes of the finished clip the stubbed download returns. */
const CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

/** The Seedance model both clips use (intl). */
const MODEL = "dreamina-seedance-2-0-260128";

/** Prompts of the two clips, in build-file order. */
const PROMPTS = ["image 1 walks into the rain", "image 1 turns to the camera"] as const;

/** Build file: one portrait registered with ark, two clips that `$ref` it. */
const PORTRAIT_YAML = `version: 1
name: mira
items:
  - id: face-mira
    task: asset
    provider: ark
    input:
      image: { $file: faces/mira.png }
      url: "https://cdn.example/faces/mira.png"
  - id: clip-01
    task: video
    provider: ark
    input:
      model: ${MODEL}
      prompt: "${PROMPTS[0]}"
      refs: [{ $ref: face-mira }]
      seconds: 5
      resolution: 720p
      aspect: "9:16"
  - id: clip-02
    task: video
    provider: ark
    input:
      model: ${MODEL}
      prompt: "${PROMPTS[1]}"
      refs: [{ $ref: face-mira }]
      seconds: 5
      resolution: 720p
      aspect: "9:16"
`;

/** A fixture env provider with the three ark keys, so process.env is never read. */
const fixtureEnvProvider: EnvProvider = {
  name: "ark-integration-fixture",
  load: () => ({
    ARK_API_KEY: TEST_API_KEY,
    ARK_ACCESS_KEY: TEST_ACCESS_KEY,
    ARK_SECRET_KEY: TEST_SECRET_KEY
  })
};

/** How the stubbed GetAsset answers, by 1-based call count. */
type AssetAnswer = (count: number) => unknown;

/** The asset polls Processing once, then Active on every later call. */
const processingThenActive: AssetAnswer = count =>
  count === 1 ? GET_ASSET_PROCESSING : GET_ASSET_ACTIVE;

/**
 * Stubs global fetch by URL: the three asset actions on the intl control
 * plane, the task create and get on the intl data plane, and the clip
 * download. Each create-task POST gets its own task id.
 *
 * @param getAsset - GetAsset answer by call count.
 * @returns The fetch mock.
 * @example
 * ```ts
 * const fetchMock = stubArk(processingThenActive);
 * ```
 */
function stubArk(getAsset: AssetAnswer): ReturnType<typeof vi.fn> {
  let getAssetCalls = 0;
  let tasks = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === intlActionUrl("CreateAssetGroup"))
      return jsonResponse(200, CREATE_ASSET_GROUP_RESPONSE);
    if (url === intlActionUrl("CreateAsset")) return jsonResponse(200, CREATE_ASSET_RESPONSE);
    if (url === intlActionUrl("GetAsset")) {
      getAssetCalls += 1;
      return jsonResponse(200, getAsset(getAssetCalls));
    }
    if (url === INTL_TASKS_URL && init?.method === "POST") {
      tasks += 1;
      return jsonResponse(200, { id: `${TASK_ID}-${tasks}` });
    }
    if (url.startsWith(`${INTL_TASKS_URL}/`)) {
      const id = decodeURIComponent(url.slice(INTL_TASKS_URL.length + 1));
      return jsonResponse(200, { ...GET_TASK_SUCCEEDED, id });
    }
    if (url === VIDEO_URL) return bytesResponse(CLIP);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Recorded calls to one URL, optionally of one method.
 *
 * @param fetchMock - The fetch mock.
 * @param url - The exact URL.
 * @param method - The HTTP method, when it matters.
 * @returns The matching calls, in call order.
 * @example
 * ```ts
 * callsTo(fetchMock, INTL_TASKS_URL, "POST");
 * ```
 */
function callsTo(fetchMock: ReturnType<typeof vi.fn>, url: string, method?: string): FetchCall[] {
  return callsOf(fetchMock).filter(
    call => call.url === url && (method === undefined || call.method === method)
  );
}

/**
 * The create-task body ark sends for one clip of the build file.
 *
 * @param prompt - The clip's prompt.
 * @returns The expected body: the prompt, then the asset as a reference image.
 * @example
 * ```ts
 * clipBody(PROMPTS[0]).content[1]; // => { type: "image_url", image_url: { url: "asset://asset-..." }, role: "reference_image" }
 * ```
 */
function clipBody(prompt: string): unknown {
  return {
    model: MODEL,
    content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `asset://${ASSET_ID}` }, role: "reference_image" }
    ],
    ratio: "9:16",
    duration: 5,
    resolution: "720p",
    generate_audio: false,
    watermark: false
  };
}

/**
 * An app with a region ark does not have. Never called: it exists for the
 * compile-time check.
 *
 * @returns The app, if it ever compiled.
 * @example
 * ```ts
 * expectTypeOf(appWithUnknownRegion).toBeFunction();
 * ```
 */
function appWithUnknownRegion() {
  // @ts-expect-error -- ark region is "intl" or "cn"
  return createApp({ pluginConfigs: { ark: { region: "us" } } });
}

describe("ark: through the full framework", () => {
  let tempDir: string;
  let files: string;
  let portrait: string;
  const stops: Array<() => Promise<void>> = [];

  /**
   * A started app from src/index.ts, with the journal, store and env pinned
   * to fixtures and fast polling everywhere.
   *
   * @param ark - Extra ark config.
   * @param ark.groupId - A configured AIGC group id, when the test needs one.
   * @returns The started app.
   * @example
   * ```ts
   * const app = await startApp({ groupId: GROUP_ID });
   * ```
   */
  async function startApp(ark: { groupId?: string } = {}) {
    // Core plugins (journal, store, env) take createApp overrides at runtime (the
    // 4-level cascade), but core's CreateAppOptions types only regular plugins.
    // A named object is not checked for excess keys, so it passes both.
    const pluginConfigs = {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      env: { providers: [fixtureEnvProvider] },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      video: { pollIntervalMs: 1 },
      asset: { pollIntervalMs: 1 },
      ark
    };
    const app = createApp({ pluginConfigs });
    await app.start();
    stops.push(() => app.stop());
    return app;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-ark-int-"));
    files = path.join(tempDir, "*.moku.yaml");
    portrait = path.join(tempDir, "faces", "mira.png");
    await mkdir(path.dirname(portrait));
    await writeFile(portrait, pngHeader(768, 1024));
    await writeFile(path.join(tempDir, "mira.moku.yaml"), PORTRAIT_YAML);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("registers the portrait once and sends asset://<id> in both clips", async () => {
    const fetchMock = stubArk(processingThenActive);
    const app = await startApp();

    const result = await app.runner.run({ files });

    // One group, one asset, polled from Processing to Active.
    expect(result).toMatchObject({ status: "done", totals: { total: 3, done: 3, flagged: 0 } });
    const groups = callsTo(fetchMock, intlActionUrl("CreateAssetGroup"));
    const assets = callsTo(fetchMock, intlActionUrl("CreateAsset"));
    const getAssets = callsTo(fetchMock, intlActionUrl("GetAsset"));
    expect(groups.map(call => jsonBodyOf(call))).toEqual([CREATE_ASSET_GROUP_REQUEST]);
    expect(assets.map(call => jsonBodyOf(call))).toEqual([CREATE_ASSET_REQUEST]);
    expect(assets[0]?.headers.Authorization).toMatch(
      /^HMAC-SHA256 Credential=AKLTtestaccesskey\/\d{8}\/ap-southeast-1\/ark\/request, /
    );
    // Two polls reach Active; then the video preflight checks it (once or twice, concurrent clips).
    expect(getAssets.length).toBeGreaterThanOrEqual(3);
    expect(getAssets.length).toBeLessThanOrEqual(4);
    for (const call of getAssets) expect(jsonBodyOf(call)).toEqual(GET_ASSET_REQUEST);

    // Both clips carry the asset as a reference image, with the Bearer key.
    const posts = callsTo(fetchMock, INTL_TASKS_URL, "POST");
    expect(posts).toHaveLength(2);
    const bodies = posts.map(call => jsonBodyOf(call));
    expect(bodies).toEqual(expect.arrayContaining([clipBody(PROMPTS[0]), clipBody(PROMPTS[1])]));
    for (const call of posts) expect(call.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);

    // The stored asset record belongs to this account, so the account check passed.
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });
    const recordFile = exported.files.find(file => file.mimeType === ASSET_MIME);
    expect(recordFile?.path.endsWith(".json")).toBe(true);
    const record = parseAssetRecord(await readFile(recordFile?.path ?? ""));
    expect(record).toEqual({
      assetId: ASSET_ID,
      provider: "ark",
      account: INTL_ACCOUNT,
      groupId: GROUP_ID,
      registeredAt: expect.any(Number)
    });
  });

  it("reuses the asset and both clips on a second run, with no fetch at all", async () => {
    const fetchMock = stubArk(processingThenActive);
    const first = await startApp();
    await first.runner.run({ files });
    await first.stop();
    stops.splice(0);
    fetchMock.mockClear();

    const second = await startApp();
    const result = await second.runner.run({ files });

    expect(result).toMatchObject({ status: "done", totals: { total: 3, done: 3, spendUsd: 0 } });
    expect(callsTo(fetchMock, intlActionUrl("CreateAsset"))).toHaveLength(0);
    expect(callsTo(fetchMock, INTL_TASKS_URL, "POST")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags a refused portrait and never dispatches the clips that use it", async () => {
    const fetchMock = stubArk(() => GET_ASSET_FAILED);
    const app = await startApp();

    const result = await app.runner.run({ files });

    expect(result.totals).toMatchObject({ total: 3, flagged: 1, done: 0 });
    expect(callsTo(fetchMock, intlActionUrl("CreateAsset"))).toHaveLength(1);
    expect(callsTo(fetchMock, intlActionUrl("GetAsset"))).toHaveLength(1);
    expect(callsTo(fetchMock, INTL_TASKS_URL, "POST")).toHaveLength(0);
  });

  it("keeps fal the default video provider", async () => {
    const app = await startApp();

    expect(app.registry.providers("video")[0]).toBe("fal");
    expect(app.registry.providers("video")).toContain("ark");
    expect(app.registry.providers("asset")).toEqual(["ark"]);
    expect(app.ark.info()).toEqual({
      provider: "ark",
      region: "intl",
      configured: { video: true, assets: true },
      models: [MODEL, "dreamina-seedance-2-5-260628"]
    });
    expectTypeOf(app.ark.info()).toEqualTypeOf<ArkInfo>();
  });

  it("registers through app.asset and animates through app.video on provider ark", async () => {
    const fetchMock = stubArk(processingThenActive);
    const app = await startApp({ groupId: GROUP_ID });
    const image = { path: portrait, mimeType: "image/png", hash: "a".repeat(64) };

    const record: AssetRecord = await app.asset.register(
      { image, url: "https://cdn.example/faces/mira.png" },
      { provider: "ark" }
    );
    const recordPath = path.join(tempDir, "mira.asset.json");
    await writeFile(recordPath, encodeAssetRecord(record));
    const clip = await app.video.generate(
      {
        model: MODEL,
        prompt: "image 1 walks into the rain",
        image: { path: recordPath, mimeType: ASSET_MIME, hash: "b".repeat(64) }
      },
      { provider: "ark" }
    );

    // The configured group is used as is: no CreateAssetGroup.
    expect(record).toMatchObject({ assetId: ASSET_ID, account: INTL_ACCOUNT, groupId: GROUP_ID });
    expect(callsTo(fetchMock, intlActionUrl("CreateAssetGroup"))).toHaveLength(0);
    expect(callsTo(fetchMock, intlActionUrl("CreateAsset"))).toHaveLength(1);

    // The clip takes the asset as its first frame, priced from the task's tokens.
    const posts = callsTo(fetchMock, INTL_TASKS_URL, "POST");
    expect(posts.map(call => jsonBodyOf(call))).toEqual([CREATE_TASK_REQUEST_ASSET_FIRST_FRAME]);
    expect(clip).toMatchObject({ video: CLIP, mimeType: "video/mp4", costUsd: 0.7623 });
  });

  it("rejects an unknown region at compile time", () => {
    expectTypeOf(appWithUnknownRegion).toBeFunction();
  });
});
