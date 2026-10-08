import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Ark } from "../../../../index";
import { createApp } from "../../../../index";
import {
  bytesResponse,
  callsOf,
  DRAFT_CREATED_MS,
  DRAFT_TASK_ID,
  DRAFT_VIDEO_URL,
  FINAL_TASK_ID,
  FINAL_VIDEO_URL,
  INTL_IMAGES_URL,
  INTL_TASKS_URL,
  jpegHeader,
  jsonBodyOf,
  jsonResponse,
  LIVE_DRAFT_TASK,
  LIVE_FINAL_TASK,
  LIVE_SEEDREAM_RESPONSE,
  SEEDREAM_IMAGE_URL,
  TEST_ACCESS_KEY,
  TEST_API_KEY,
  TEST_SECRET_KEY
} from "../fixtures";

// ---------------------------------------------------------------------------
// Integration: the full framework (`createApp` from src/index.ts) runs the
// README's draft → final build file on mocked fetch: a Seedream key image,
// a Seedance 2.5 draft that `$ref`s it, and a 1080p final from the draft.
// The fetch mock answers with the live BytePlus bodies in ../fixtures.ts.
// `Date.now()` is pinned relative to the live draft's `created_at`, because
// a draft id is valid for 7 days only.
// ---------------------------------------------------------------------------

/** The Seedance model of the draft and the final. */
const MODEL = "dreamina-seedance-2-5-260628";

/** Prompts of the key image and the draft. */
const KEY_PROMPT = "Vertical 9:16 photo. Close-up, Akari at the counter";
const DRAFT_PROMPT = "Akari lifts the lid of a cake box";

/** Bytes of the Seedream image, the draft clip and the final clip. */
const KEY_IMAGE = jpegHeader(1440, 2560);
const DRAFT_CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1]);
const FINAL_CLIP = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 2]);

/** The key image and the draft: the part of the build file that exists before the final. */
const DRAFT_ITEMS = `version: 1
name: e01
items:
  - id: e01.s04.key
    task: image
    provider: ark
    input: { prompt: "${KEY_PROMPT}", aspect: "9:16" }
  - id: e01.s04.draft
    task: video
    provider: ark
    input:
      model: ${MODEL}
      prompt: "${DRAFT_PROMPT}"
      image: { $ref: e01.s04.key }
      seconds: 5
      audio: true
    params: { draft: true }
`;

/** The whole build file: the README example. */
const DRAFT_FINAL_YAML = `${DRAFT_ITEMS}  - id: e01.s04.final
    task: video
    provider: ark
    input:
      model: ${MODEL}
      fromDraft: { $ref: e01.s04.draft }
`;

/** A fixture env provider with the three ark keys, so process.env is never read. */
const fixtureEnvProvider: EnvProvider = {
  name: "ark-draft-fixture",
  load: () => ({
    ARK_API_KEY: TEST_API_KEY,
    ARK_ACCESS_KEY: TEST_ACCESS_KEY,
    ARK_SECRET_KEY: TEST_SECRET_KEY
  })
};

/** The real clock, captured before any spy. */
const realNow = Date.now.bind(Date);

/**
 * Pins `Date.now()` to `at`, still ticking from there.
 *
 * @param at - The moment, ms since the epoch.
 * @example
 * ```ts
 * setClock(DRAFT_CREATED_MS + 60_000);
 * ```
 */
function setClock(at: number): void {
  const offset = at - realNow();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
}

/**
 * Whether a task POST is a final: its content is the draft task only.
 *
 * @param init - The recorded request init.
 * @returns True for a final body.
 * @example
 * ```ts
 * isFinalPost({ body: '{"content":[{"type":"draft_task"}]}' }); // => true
 * ```
 */
function isFinalPost(init: RequestInit | undefined): boolean {
  return String(init?.body).includes('"type":"draft_task"');
}

/**
 * Stubs global fetch by URL with the live BytePlus bodies.
 *
 * @returns The fetch mock.
 * @example
 * ```ts
 * const fetchMock = stubArk();
 * ```
 */
function stubArk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === INTL_IMAGES_URL) return jsonResponse(200, LIVE_SEEDREAM_RESPONSE);
    if (url === SEEDREAM_IMAGE_URL) return bytesResponse(KEY_IMAGE, "image/jpeg");
    if (url === INTL_TASKS_URL) {
      return jsonResponse(200, { id: isFinalPost(init) ? FINAL_TASK_ID : DRAFT_TASK_ID });
    }
    if (url === `${INTL_TASKS_URL}/${DRAFT_TASK_ID}`) return jsonResponse(200, LIVE_DRAFT_TASK);
    if (url === `${INTL_TASKS_URL}/${FINAL_TASK_ID}`) return jsonResponse(200, LIVE_FINAL_TASK);
    if (url === DRAFT_VIDEO_URL) return bytesResponse(DRAFT_CLIP);
    if (url === FINAL_VIDEO_URL) return bytesResponse(FINAL_CLIP);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The recorded JSON bodies POSTed to one URL, in call order.
 *
 * @param fetchMock - The fetch mock.
 * @param url - The exact URL.
 * @returns The parsed bodies.
 * @example
 * ```ts
 * postedTo(fetchMock, INTL_TASKS_URL).length; // => 2
 * ```
 */
function postedTo(fetchMock: ReturnType<typeof vi.fn>, url: string): unknown[] {
  return callsOf(fetchMock)
    .filter(call => call.url === url && call.method === "POST")
    .map(call => jsonBodyOf(call));
}

describe("ark: image → draft → final through the full framework", () => {
  let tempDir: string;
  let files: string;
  const stops: Array<() => Promise<void>> = [];

  /**
   * An app from src/index.ts, not started yet, with the journal, store and
   * env pinned to fixtures and fast polling everywhere.
   *
   * @returns The app, before `app.start()`.
   * @example
   * ```ts
   * const app = buildApp();
   * ```
   */
  function buildApp() {
    // Core plugins take createApp overrides at runtime; a named object skips the excess-key check.
    const pluginConfigs = {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      env: { providers: [fixtureEnvProvider] },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      video: { pollIntervalMs: 1 }
    };
    return createApp({ pluginConfigs });
  }

  /**
   * A started app from {@link buildApp}, stopped by {@link stopAll}.
   *
   * @returns The started app.
   * @example
   * ```ts
   * const app = await startApp();
   * ```
   */
  async function startApp() {
    const app = buildApp();
    await app.start();
    stops.push(() => app.stop());
    return app;
  }

  /**
   * Stops every app started so far.
   *
   * @example
   * ```ts
   * await stopAll();
   * ```
   */
  async function stopAll(): Promise<void> {
    for (const stop of stops.splice(0)) await stop();
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-ark-draft-"));
    files = path.join(tempDir, "*.moku.yaml");
    setClock(DRAFT_CREATED_MS + 60 * 60 * 1000);
  });

  afterEach(async () => {
    await stopAll();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes the Seedream key, the draft from it and the 1080p final from the draft", async () => {
    await writeFile(path.join(tempDir, "e01.moku.yaml"), DRAFT_FINAL_YAML);
    const fetchMock = stubArk();
    const app = await startApp();

    const result = await app.runner.run({ files });

    expect(result).toMatchObject({ status: "done", totals: { total: 3, done: 3, failed: 0 } });
    expect(result.totals.spendUsd).toBeCloseTo(0.035 + 0.518_276 + 2.866_793, 6);

    // The key: Seedream text-to-image at 1440x2560.
    expect(postedTo(fetchMock, INTL_IMAGES_URL)).toEqual([
      {
        model: "seedream-5-0-lite-260128",
        prompt: KEY_PROMPT,
        size: "1440x2560",
        response_format: "url",
        watermark: false
      }
    ]);

    // The draft takes the key's original bytes as its first frame, no ratio; the final only the draft task.
    const keyDataUri = `data:image/jpeg;base64,${Buffer.from(KEY_IMAGE).toString("base64")}`;
    expect(postedTo(fetchMock, INTL_TASKS_URL)).toEqual([
      {
        model: MODEL,
        content: [
          { type: "text", text: DRAFT_PROMPT },
          { type: "image_url", image_url: { url: keyDataUri }, role: "first_frame" }
        ],
        duration: 5,
        resolution: "480p",
        generate_audio: true,
        watermark: false,
        draft: true
      },
      {
        model: MODEL,
        content: [{ type: "draft_task", draft_task: { id: DRAFT_TASK_ID } }],
        resolution: "1080p",
        watermark: false
      }
    ]);

    // All three artifacts are exported with the bytes ark sent.
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });
    const contents = await Promise.all(exported.files.map(file => readFile(file.path)));
    const bytes = contents.map(content => new Uint8Array(content));
    expect(bytes).toEqual(expect.arrayContaining([KEY_IMAGE, DRAFT_CLIP, FINAL_CLIP]));
  });

  it("prices the final at the video-in rate when the draft had a reference video", async () => {
    const withVideo = DRAFT_FINAL_YAML.replace(
      "params: { draft: true }",
      'params: { draft: true, refUrls: ["https://cdn.example/walk.mp4"] }'
    );
    await writeFile(path.join(tempDir, "e01.moku.yaml"), withVideo);
    stubArk();
    const app = await startApp();

    const result = await app.runner.run({ files });

    // Key, then the draft and the final both at the video-in rows: $6.4 and $7.0 per 1M.
    expect(result).toMatchObject({ status: "done", totals: { total: 3, done: 3, failed: 0 } });
    expect(result.totals.spendUsd).toBeCloseTo(0.035 + 0.309_997 + 1.715_175, 6);
  });

  it("reads the draft's record through app.ark.draftRecord, and nothing before app.start()", async () => {
    await writeFile(path.join(tempDir, "e01.moku.yaml"), DRAFT_ITEMS);
    stubArk();
    const hash = createHash("sha256").update(DRAFT_CLIP).digest("hex");

    // Before app.start() the journal is closed: no record, no throw.
    expect(buildApp().ark.draftRecord(hash)).toBeUndefined();

    const app = await startApp();
    expectTypeOf(app.ark.draftRecord).toEqualTypeOf<
      (hash: string) => Ark.ArkDraftRecord | undefined
    >();
    expect(app.ark.draftRecord(hash)).toBeUndefined();

    await app.runner.run({ files });

    expect(app.ark.draftRecord(hash)).toEqual({
      taskId: DRAFT_TASK_ID,
      model: MODEL,
      seed: LIVE_DRAFT_TASK.seed,
      createdAt: DRAFT_CREATED_MS,
      withVideoInput: false
    });
  });

  it("reuses all three on a second run, with no fetch at all", async () => {
    await writeFile(path.join(tempDir, "e01.moku.yaml"), DRAFT_FINAL_YAML);
    const fetchMock = stubArk();
    const first = await startApp();
    await first.runner.run({ files });
    await stopAll();
    fetchMock.mockClear();

    const second = await startApp();
    const result = await second.runner.run({ files });

    expect(result).toMatchObject({ status: "done", totals: { total: 3, done: 3, spendUsd: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails a final added 7 days after its draft, with the expired message and no fetch", async () => {
    await writeFile(path.join(tempDir, "e01.moku.yaml"), DRAFT_ITEMS);
    const fetchMock = stubArk();
    const first = await startApp();
    await first.runner.run({ files });
    await stopAll();
    fetchMock.mockClear();

    // A week later, the final joins the build file.
    setClock(DRAFT_CREATED_MS + 7 * 24 * 60 * 60 * 1000);
    await writeFile(path.join(tempDir, "e01.moku.yaml"), DRAFT_FINAL_YAML);
    const app = await startApp();
    const result = await app.runner.run({ files });

    expect(result.totals).toMatchObject({ total: 3, done: 2, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();

    // The same final through the facade names the expiry.
    const draft = {
      path: path.join(tempDir, "draft.mp4"),
      mimeType: "video/mp4",
      hash: createHash("sha256").update(DRAFT_CLIP).digest("hex")
    };
    await writeFile(draft.path, DRAFT_CLIP);
    await expect(
      app.video.generate({ model: MODEL, prompt: "", fromDraft: draft }, { provider: "ark" })
    ).rejects.toThrow(
      `[ai] ark draft ${DRAFT_TASK_ID} expired on 2026-10-07T09:10:42.000Z.\n  Bump params.generation on the draft item to render it again.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
