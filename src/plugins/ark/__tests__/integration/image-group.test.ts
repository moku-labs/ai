import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createPlugin } from "../../../../index";
import type { RunEvent } from "../../../runner/types";
import {
  bytesResponse,
  callsOf,
  INTL_IMAGES_URL,
  jsonBodyOf,
  jsonResponse,
  SEEDREAM_GROUP_RESPONSE,
  SEEDREAM_GROUP_URLS,
  TEST_ACCESS_KEY,
  TEST_API_KEY,
  TEST_SECRET_KEY
} from "../fixtures";

// ---------------------------------------------------------------------------
// Integration: the full framework (`createApp` from src/index.ts) runs a build
// file with one Seedream group item (`params.images: 3`) on mocked fetch. The
// runner stores the three images and journals them as the item's outputs. No
// request leaves the process.
// ---------------------------------------------------------------------------

/** The group item's prompt. */
const PROMPT = "Three panels of Akari at the counter, same apron";

/** Build file: one ark image item asking for a group of three. */
const GROUP_YAML = `version: 1
name: panels
items:
  - id: akari.panels
    task: image
    provider: ark
    input: { prompt: "${PROMPT}", aspect: "9:16" }
    params: { images: 3 }
`;

/** A fixture env provider with the three ark keys, so process.env is never read. */
const fixtureEnvProvider: EnvProvider = {
  name: "ark-group-fixture",
  load: () => ({
    ARK_API_KEY: TEST_API_KEY,
    ARK_ACCESS_KEY: TEST_ACCESS_KEY,
    ARK_SECRET_KEY: TEST_SECRET_KEY
  })
};

/** A probe plugin exposing the journal to the test. */
const probePlugin = createPlugin("probe", { api: ctx => ({ journal: ctx.journal }) });

/**
 * JPEG bytes that carry their position `n`, so order is visible.
 *
 * @param n - 1-based image number.
 * @returns The bytes.
 */
function jpegNumber(n: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n]);
}

/**
 * Stubs global fetch by URL: the generation answers the documented group
 * response, each group URL its numbered JPEG.
 *
 * @returns The fetch mock.
 */
function stubArk(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === INTL_IMAGES_URL) return jsonResponse(200, SEEDREAM_GROUP_RESPONSE);
    const index = SEEDREAM_GROUP_URLS.indexOf(url);
    if (index !== -1) return bytesResponse(jpegNumber(index + 1), "image/jpeg");
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ark image group: through the full framework", () => {
  let tempDir: string;
  let files: string;
  const stops: Array<() => Promise<void>> = [];

  /**
   * A started app from src/index.ts with the probe, the journal, store and
   * env pinned to fixtures.
   *
   * @returns The started app.
   */
  async function startApp() {
    // Core plugins take createApp overrides at runtime; a named object passes the regular-plugin typing.
    const pluginConfigs = {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      env: { providers: [fixtureEnvProvider] },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 }
    };
    const app = createApp({ plugins: [probePlugin], pluginConfigs });
    await app.start();
    stops.push(() => app.stop());
    return app;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-ark-group-"));
    files = path.join(tempDir, "*.moku.yaml");
    await writeFile(path.join(tempDir, "panels.moku.yaml"), GROUP_YAML);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("journals 3 outputs for params.images: 3, priced 3 images", async () => {
    const fetchMock = stubArk();
    const app = await startApp();

    const events: RunEvent[] = [];
    const run = app.runner.run({ files });
    for await (const event of app.runner.events()) events.push(event);
    const result = await run;

    // One group request, three downloads, billed 3 × $0.035.
    expect(result).toMatchObject({ status: "done", totals: { done: 1, spendUsd: 0.105 } });
    const [generate, ...downloads] = callsOf(fetchMock);
    expect(jsonBodyOf(generate)).toMatchObject({
      sequential_image_generation: "auto",
      sequential_image_generation_options: { max_images: 3 }
    });
    expect(downloads.map(call => call.url)).toEqual([...SEEDREAM_GROUP_URLS]);

    // Three outputs journaled in order; the item's content hash is the first.
    const [item] = app.probe.journal.listItems(result.runId);
    expect(item?.outputs).toHaveLength(3);
    expect(item?.outputs?.map(output => output.mimeType)).toEqual([
      "image/jpeg",
      "image/jpeg",
      "image/jpeg"
    ]);
    expect(item?.contentHash).toBe(item?.outputs?.[0]?.contentHash);
    const done = events.find(event => event.type === "item:done");
    expect(done).toMatchObject({
      costUsd: 0.105,
      contentHashes: item?.outputs?.map(output => output.contentHash)
    });

    // Export writes one file per image.
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });
    expect(exported.files.map(file => path.basename(file.path))).toEqual([
      "akari.panels.jpg",
      "akari.panels-2.jpg",
      "akari.panels-3.jpg"
    ]);
    const third = await readFile(path.join(tempDir, "out", "panels", "akari.panels-3.jpg"));
    expect(new Uint8Array(third)).toEqual(jpegNumber(3));
  });
});
