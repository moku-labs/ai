import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import { videoPlugin } from "../../../video";
import type { VideoHandler } from "../../../video/contract";
import { apimodelsPlugin } from "../../index";
import type { ApimodelsApi, ApimodelsContext, ApimodelsInfo, Config } from "../../types";
import { createVideoHandler } from "../../video/handler";
import { CLIP, completedTask, envelope, stubApi } from "../unit/fixtures";

// ---------------------------------------------------------------------------
// Integration: apimodels registered in onInit through the real createApp
// lifecycle, driven by the real runner with a temp journal and store. fetch
// is stubbed at the boundary; no real network calls anywhere in this suite.
// ---------------------------------------------------------------------------

const KEY = "integration-apimodels-key";
const ACCOUNT = createHash("sha256").update(`moku-ai:${KEY}`).digest("hex").slice(0, 12);
const FACE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);
const FACE_HASH = createHash("sha256").update(FACE).digest("hex");

/** A fixture env provider resolving the key without touching process.env. */
const fixtureEnvProvider: EnvProvider = {
  name: "apimodels-integration-fixture",
  load: () => ({ APIMODELS_API_KEY: KEY })
};

/** Assembles registry + buildfile + runner + video + apimodels, core plugins pinned under `dir`. */
function buildFramework(dir: string) {
  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({ journal: ctx.journal })
  });
  return createCore(coreConfig, {
    plugins: [
      registryPlugin,
      buildfilePlugin,
      runnerPlugin,
      videoPlugin,
      apimodelsPlugin,
      probePlugin
    ],
    pluginConfigs: {
      journal: { path: path.join(dir, "journal.db") },
      store: { dir: path.join(dir, "store") },
      env: { providers: [fixtureEnvProvider] },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 }
    }
  });
}

/** A build file with one apimodels Seedance item for the face, named as an asset. */
function buildYaml(id: string, prompt: string): string {
  return `version: 1
name: shots
items:
  - id: ${id}
    task: video
    provider: apimodels
    input:
      model: seedance-2.5
      prompt: "${prompt}"
      image: { $file: anna.png }
      seconds: 8
    params: { assets: ["image"] }
`;
}

describe("apimodels integration", () => {
  let dir: string;
  let files: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "moku-apimodels-integration-"));
    files = path.join(dir, "*.moku.yaml");
    writeFileSync(path.join(dir, "anna.png"), FACE);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  /** Creates and starts an app on the shared temp dir. */
  async function startApp() {
    const app = buildFramework(dir).createApp();
    await app.start();
    stops.push(() => app.stop());
    return app;
  }

  it("registers under the video task in onInit and reports info()", async () => {
    const app = await startApp();

    expect(app.video.providers()).toContain("apimodels");
    expect(app.apimodels.info()).toEqual({
      provider: "apimodels",
      configured: true,
      models: ["seedance-2.5", "seedance-2.5-ref", "seedance-2.0", "seedance-2.0-ref"]
    });
  });

  it("runs a build item with params.assets to done: cost includes 0.01, one asset record journaled", async () => {
    const api = stubApi({
      poll: (taskId, n) =>
        n < 2 ? envelope({ taskId, state: "processing" }) : completedTask(taskId)
    });
    writeFileSync(
      path.join(dir, "shots.moku.yaml"),
      buildYaml("shot-03", "She turns to the window.")
    );
    const app = await startApp();

    const estimate = await app.runner.estimate({ files });
    const result = await app.runner.run({ files });

    expect(estimate.totalUsd).toBe(2.17);
    expect(result.status).toBe("done");
    expect(result.totals).toMatchObject({ done: 1, failed: 0, spendUsd: 2.17 });
    expect(api.count("register")).toBe(1);
    expect(api.count("submit")).toBe(1);
    expect(
      app.probe.journal.findProviderRecord({
        provider: "apimodels",
        account: ACCOUNT,
        kind: "asset",
        key: FACE_HASH
      })
    ).toBe("asset://asset-1");
    const exported = await app.runner.export({ outDir: path.join(dir, "out") });
    expect(readFileSync(exported.files[0]?.path ?? "")).toEqual(Buffer.from(CLIP));
  });

  it("a new item with the same face after a restart registers nothing (journal hit)", async () => {
    const api = stubApi({ poll: completedTask });
    writeFileSync(
      path.join(dir, "shots.moku.yaml"),
      buildYaml("shot-03", "She turns to the window.")
    );
    const first = await startApp();
    await first.runner.run({ files });
    await first.stop();

    writeFileSync(
      path.join(dir, "shots.moku.yaml"),
      buildYaml("shot-04", "She smiles at the camera.")
    );
    const second = await startApp();
    const result = await second.runner.run({ files });

    expect(result.totals).toMatchObject({ done: 1, spendUsd: 2.16 });
    expect(api.count("submit")).toBe(2);
    expect(api.count("register")).toBe(1);
    expect(api.count("group")).toBe(1);
    expect(api.count("upload")).toBe(1);
    expect(api.calls("submit").map(call => JSON.parse(String(call.body)).first_frame_url)).toEqual([
      "asset://asset-1",
      "asset://asset-1"
    ]);
  });

  it("a restart after submit adopts the same taskId: resume polls it, no second POST", async () => {
    const controller = new AbortController();
    const api = stubApi({
      submit: () => {
        controller.abort(new Error("paused"));
        return envelope({ taskId: "task-42", state: "pending" });
      },
      poll: completedTask
    });
    writeFileSync(
      path.join(dir, "shots.moku.yaml"),
      buildYaml("shot-03", "She turns to the window.")
    );
    const first = await startApp();

    const paused = await first.runner.run({ files }, { signal: controller.signal });
    await first.stop();

    expect(paused.status).toBe("paused");
    expect(api.count("poll")).toBe(0);

    const second = await startApp();
    const resumed = await second.runner.resume();

    expect(resumed).toMatchObject({ runId: paused.runId, status: "done" });
    expect(resumed.totals.spendUsd).toBe(2.17);
    expect(api.count("submit")).toBe(1);
    expect(api.calls("poll").map(call => new URL(call.url).searchParams.get("task_id"))).toEqual([
      "task-42"
    ]);
  });

  it("app.video.generate() before app.start() works on the state tier alone", async () => {
    const api = stubApi({ poll: completedTask });
    const app = buildFramework(dir).createApp({ pluginConfigs: { video: { pollIntervalMs: 0 } } });

    const result = await app.video.generate(
      {
        model: "seedance-2.5",
        prompt: "She turns to the window.",
        image: { path: path.join(dir, "anna.png"), mimeType: "image/png", hash: FACE_HASH },
        params: { assets: ["image"] }
      },
      { provider: "apimodels" }
    );

    expect(result).toMatchObject({ video: CLIP, mimeType: "video/mp4", costUsd: 1.36 });
    expect(api.count("register")).toBe(1);
  });

  describe("types", () => {
    it("app.apimodels.info() is typed", () => {
      const app = buildFramework(dir).createApp();
      expectTypeOf(app.apimodels.info).returns.toEqualTypeOf<ApimodelsInfo>();
    });

    it("createVideoHandler returns the async VideoHandler form for an ApimodelsContext", () => {
      expectTypeOf(createVideoHandler).parameter(0).toEqualTypeOf<ApimodelsContext>();
      expectTypeOf(createVideoHandler).returns.toMatchTypeOf<VideoHandler>();
      expectTypeOf(createVideoHandler).returns.toEqualTypeOf<
        Required<Pick<VideoHandler, "estimate" | "submit" | "poll">>
      >();
    });

    it("createPlugin infers name, config and api from the spec object (no explicit generics)", () => {
      expectTypeOf(apimodelsPlugin.name).toEqualTypeOf<"apimodels">();
      expectTypeOf(apimodelsPlugin._phantom.config).toEqualTypeOf<Config>();
      expectTypeOf(apimodelsPlugin._phantom.api).toEqualTypeOf<ApimodelsApi>();
      const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
      expect(source).not.toMatch(/createPlugin\s*</);
    });
  });
});
