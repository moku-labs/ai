import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import type { VideoFile, VideoHandler, VideoRequest } from "../../../video/contract";
import {
  ASSET_MIME,
  type AssetHandler,
  type AssetJobPoll,
  type AssetRecord,
  type AssetRequest,
  encodeAssetRecord,
  parseAssetRecord
} from "../../contract";
import { assetPlugin } from "../../index";

const record: AssetRecord = {
  assetId: "asset-20260929-a1",
  provider: "fake",
  account: "3f9a0c1b2d4e",
  groupId: "group-7",
  registeredAt: 1_790_000_000_000
};

/**
 * A fake asset provider: submit records the request, poll answers `answer(count)`.
 *
 * @param answer - Poll answer by 1-based poll count.
 * @returns The handler and the requests it was submitted.
 * @example
 * ```ts
 * const asset = assetHandler(() => doneRecord());
 * ```
 */
function assetHandler(answer: (count: number) => AssetJobPoll) {
  const submits: AssetRequest[] = [];
  let polls = 0;
  const handler: AssetHandler = {
    estimate: () => ({ usd: 0 }),
    submit: async submitted => {
      submits.push(submitted);
      return { jobId: `asset-job-${submits.length}` };
    },
    poll: async () => {
      polls += 1;
      return answer(polls);
    }
  };
  return { handler, submits };
}

/**
 * The finished poll carrying the stored record.
 *
 * @returns A `done` asset poll.
 * @example
 * ```ts
 * doneRecord().mimeType; // => "application/vnd.moku.asset+json"
 * ```
 */
function doneRecord(): AssetJobPoll {
  return {
    state: "done",
    body: encodeAssetRecord(record),
    mimeType: ASSET_MIME,
    costUsd: 0,
    meta: { assetId: record.assetId, account: record.account }
  };
}

/**
 * A fake video provider that records each submitted request.
 *
 * @returns The handler and the requests it was submitted.
 * @example
 * ```ts
 * const video = videoHandler();
 * ```
 */
function videoHandler() {
  const submits: VideoRequest[] = [];
  const handler: VideoHandler = {
    estimate: () => ({ usd: 0.5 }),
    submit: async submitted => {
      submits.push(submitted);
      return { jobId: `video-job-${submits.length}` };
    },
    poll: async () => ({
      state: "done",
      video: new TextEncoder().encode("clip"),
      mimeType: "video/mp4",
      costUsd: 0.5
    })
  };
  return { handler, submits };
}

/**
 * A started app: registry, buildfile, runner, asset and one fake provider plugin
 * that registers the given handlers in `onInit`. Core plugins live under `tempDir`.
 *
 * @param tempDir - Per-test directory.
 * @param providers - Handlers as `[task, provider, handler]`.
 * @returns The started app.
 * @example
 * ```ts
 * const app = await startApp(tempDir, [["asset", "fake", handler]]);
 * ```
 */
async function startApp(tempDir: string, providers: Array<[string, string, unknown]>) {
  const fakeProviders = createPlugin("fakeProviders", {
    depends: [registryPlugin, assetPlugin],
    onInit: ctx => {
      for (const [task, provider, handler] of providers) {
        ctx.require(registryPlugin).register(task, provider, handler);
      }
    }
  });
  const app = createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin, assetPlugin, fakeProviders],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      asset: { defaultProvider: "fake", pollIntervalMs: 1 }
    }
  }).createApp();
  await app.start();
  return app;
}

/** Build file: register one portrait, then animate a clip that `$ref`s the asset. */
const PORTRAIT_YAML = `version: 1
name: portrait
items:
  - id: mira.asset
    task: asset
    provider: fake
    input:
      image: { $file: refs/mira.png }
      url: "https://cdn.example/mira.png"
  - id: mira.clip
    task: video
    provider: fake
    input:
      model: seedance-2
      prompt: "slow push-in"
      refs: [{ $ref: mira.asset }]
`;

describe("asset: through a real app", () => {
  let tempDir: string;
  let files: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "asset-int-"));
    files = path.join(tempDir, "*.moku.yaml");
    await mkdir(path.join(tempDir, "refs"));
    await writeFile(path.join(tempDir, "refs", "mira.png"), "portrait-bytes");
    await writeFile(path.join(tempDir, "portrait.moku.yaml"), PORTRAIT_YAML);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers one portrait through app.asset", async () => {
    const asset = assetHandler(count => (count < 2 ? { state: "pending" } : doneRecord()));
    const app = await startApp(tempDir, [["asset", "fake", asset.handler]]);
    stops.push(() => app.stop());
    const image = { path: "refs/mira.png", mimeType: "image/png", hash: "a".repeat(64) };

    const result = await app.asset.register({ image, url: "https://cdn.example/mira.png" });

    expect(result).toStrictEqual(record);
    expect(asset.submits).toHaveLength(1);
    expect(app.asset.estimate({ image })).toEqual({ usd: 0 });
    expect(app.asset.providers()).toEqual(["fake"]);
    expectTypeOf(app.asset.register).returns.resolves.toEqualTypeOf<AssetRecord>();
  });

  it("hands the video item a ref whose bytes are the asset record", async () => {
    const asset = assetHandler(() => doneRecord());
    const video = videoHandler();
    const app = await startApp(tempDir, [
      ["asset", "fake", asset.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());

    const result = await app.runner.run({ files });

    expect(result).toMatchObject({ status: "done", totals: { total: 2, done: 2 } });
    const [assetRequest] = asset.submits;
    expect(assetRequest?.url).toBe("https://cdn.example/mira.png");
    expect(assetRequest?.image.mimeType).toBe("image/png");
    const [reference] = video.submits[0]?.refs ?? [];
    const assetFile = reference as VideoFile;
    expect(assetFile.mimeType).toBe(ASSET_MIME);
    expect(parseAssetRecord(await readFile(assetFile.path))).toStrictEqual(record);
  });

  it("reuses the registered asset on the second run without submitting again", async () => {
    const asset = assetHandler(() => doneRecord());
    const video = videoHandler();
    const app = await startApp(tempDir, [
      ["asset", "fake", asset.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());

    await app.runner.run({ files });
    const second = await app.runner.run({ files });

    expect(second).toMatchObject({ status: "done", totals: { done: 2, spendUsd: 0 } });
    expect(asset.submits).toHaveLength(1);
    expect(video.submits).toHaveLength(1);
  });

  it("leaves the video item undispatched when the asset is flagged", async () => {
    const refusal = Object.assign(
      new Error("[ai] fake refused asset.\n  Items that use it will not run."),
      {
        kind: "content-policy"
      }
    );
    const asset = assetHandler(() => ({ state: "failed", error: refusal }));
    const video = videoHandler();
    const app = await startApp(tempDir, [
      ["asset", "fake", asset.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());

    const result = await app.runner.run({ files });

    expect(result.totals).toMatchObject({ flagged: 1, done: 0 });
    expect(asset.submits).toHaveLength(1);
    expect(video.submits).toHaveLength(0);
  });
});
