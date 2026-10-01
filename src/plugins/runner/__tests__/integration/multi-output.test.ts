import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../index";
import type { ExecutableHandler, HandlerRequest, ResolvedFile, RunEvent } from "../../types";

/**
 * Framework with registry + buildfile + runner, core plugins pinned under
 * `tempDir`, the given fake providers, and a probe exposing `ctx.journal` /
 * `ctx.store`.
 *
 * @param tempDir - Per-test directory.
 * @param providers - Fake providers as `[task, provider, handler]`.
 * @returns A started app.
 */
async function startApp(tempDir: string, providers: Array<[string, string, ExecutableHandler]>) {
  const providerPlugin = createPlugin("fakeProviders", {
    depends: [registryPlugin],
    onInit: ctx => {
      for (const [task, provider, handler] of providers) {
        ctx.require(registryPlugin).register(task, provider, handler);
      }
    }
  });
  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({ journal: ctx.journal, store: ctx.store })
  });

  const framework = createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin, providerPlugin, probePlugin],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 }
    }
  });
  const app = framework.createApp();
  await app.start();
  return app;
}

/**
 * The bytes of image `n` of a group for a prompt.
 *
 * @param prompt - The item's prompt.
 * @param n - 1-based image number.
 * @returns The image bytes.
 */
function groupImage(prompt: unknown, n: number): Uint8Array {
  return new TextEncoder().encode(`png:${String(prompt)}:${n}`);
}

/**
 * An image handler returning a group of three PNG images per call, `image`
 * being the first, like an image provider in group mode.
 *
 * @returns The handler and the prompts it was called with.
 */
function groupHandler(): { handler: ExecutableHandler; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    handler: {
      estimate: () => ({ usd: 0.105 }),
      execute: async request => {
        calls.push(String(request.prompt));
        const images = [1, 2, 3].map(n => ({
          image: groupImage(request.prompt, n),
          mimeType: "image/png"
        }));
        return {
          image: groupImage(request.prompt, 1),
          mimeType: "image/png",
          images,
          costUsd: 0.105
        };
      }
    }
  };
}

/**
 * A video handler that records the requests it got.
 *
 * @returns The handler and the requests.
 */
function videoHandler(): { handler: ExecutableHandler; requests: HandlerRequest[] } {
  const requests: HandlerRequest[] = [];
  return {
    requests,
    handler: {
      estimate: () => ({ usd: 0.5 }),
      execute: async request => {
        requests.push(request);
        return { video: new TextEncoder().encode("clip"), mimeType: "video/mp4", costUsd: 0.5 };
      }
    }
  };
}

/**
 * Consumes `app.runner.events()` next to a started run.
 *
 * @param app - The app.
 * @param app.runner - Its runner API.
 * @param app.runner.events - The event stream opener.
 * @param runPromise - The run in flight.
 * @returns The stream records.
 */
async function collect(
  app: { runner: { events(): AsyncIterable<RunEvent> } },
  runPromise: Promise<unknown>
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const consuming = (async () => {
    for await (const event of app.runner.events()) events.push(event);
  })();
  await Promise.all([consuming, runPromise]);
  return events;
}

/** Build file: a group of three keyframes, and a clip that `$ref`s the group. */
const GROUP_YAML = `version: 1
name: keys
items:
  - id: x
    task: image
    provider: fake
    input: { prompt: "patisserie at night" }
  - id: clip
    task: video
    provider: fake
    input:
      prompt: "slow push-in"
      image: { $ref: x }
`;

describe("runner: an item with several outputs", () => {
  let tempDir: string;
  let files: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-runner-outputs-"));
    files = path.join(tempDir, "*.moku.yaml");
    await writeFile(path.join(tempDir, "keys.moku.yaml"), GROUP_YAML);
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Starts an app with the group image handler and the video handler.
   *
   * @returns The app and both handlers.
   */
  async function startGroupApp() {
    const image = groupHandler();
    const video = videoHandler();
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    return { app, image, video };
  }

  it("stores and journals all three, reports their hashes, and a $ref gets the first", async () => {
    const { app, video } = await startGroupApp();

    const run = app.runner.run({ files });
    const events = await collect(app, run);
    const result = await run;

    expect(result).toMatchObject({ status: "done", totals: { done: 2, spendUsd: 0.605 } });
    const item = app.probe.journal.listItems(result.runId).find(row => row.label === "x");
    expect(item?.outputs).toHaveLength(3);
    expect(item?.outputs?.map(output => output.mimeType)).toEqual([
      "image/png",
      "image/png",
      "image/png"
    ]);
    expect(item?.contentHash).toBe(item?.outputs?.[0]?.contentHash);
    const hashes = item?.outputs?.map(output => output.contentHash) ?? [];
    for (const [index, hash] of hashes.entries()) {
      const stored = new TextDecoder().decode(await app.probe.store.read(hash));
      expect(stored).toBe(`png:patisserie at night:${index + 1}`);
    }
    const done = events.find(event => event.type === "item:done" && event.itemId === item?.id);
    expect(done).toMatchObject({ contentHash: hashes[0], contentHashes: hashes });

    const keyframe = video.requests[0]?.image as ResolvedFile;
    expect(keyframe).toMatchObject({ hash: hashes[0], mimeType: "image/png" });
    expect(await readFile(keyframe.path, "utf8")).toBe("png:patisserie at night:1");
  });

  it("a second run reuses all three at cost 0; a missing extra blob builds again", async () => {
    const { app, image } = await startGroupApp();
    const first = await app.runner.run({ files });
    const hashes =
      app.probe.journal
        .listItems(first.runId)
        .find(row => row.label === "x")
        ?.outputs?.map(output => output.contentHash) ?? [];

    const second = app.runner.run({ files });
    const events = await collect(app, second);

    expect(await second).toMatchObject({ status: "done", totals: { done: 2, spendUsd: 0 } });
    expect(image.calls).toHaveLength(1);
    const reused = events.find(
      event => event.type === "item:done" && "contentHashes" in event && event.costUsd === 0
    );
    expect(reused).toMatchObject({ contentHashes: hashes });

    await rm(app.probe.store.pathOf(hashes[1] ?? ""));
    const third = await app.runner.run({ files });

    expect(third.status).toBe("done");
    expect(image.calls).toHaveLength(2);
    expect(await app.probe.store.has(hashes[1] ?? "")).toBe(true);
  });

  it("export writes x.png, x-2.png and x-3.png, the item cost on the first", async () => {
    const { app } = await startGroupApp();
    await app.runner.run({ files });

    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });

    const group = exported.files.filter(file => file.label.startsWith("x"));
    expect(group.map(file => [file.label, path.relative(tempDir, file.path)])).toEqual([
      ["x", path.join("out", "keys", "x.png")],
      ["x-2", path.join("out", "keys", "x-2.png")],
      ["x-3", path.join("out", "keys", "x-3.png")]
    ]);
    expect(group.map(file => file.costUsd)).toEqual([0.105, 0, 0]);
    expect(group.map(file => file.mimeType)).toEqual(["image/png", "image/png", "image/png"]);
    expect(await readFile(path.join(tempDir, "out", "keys", "x-3.png"), "utf8")).toBe(
      "png:patisserie at night:3"
    );
  });
});
