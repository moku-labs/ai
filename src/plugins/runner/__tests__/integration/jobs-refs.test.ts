import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../index";
import type {
  ExecutableHandler,
  HandlerRequest,
  JobPoll,
  ResolvedFile,
  RunEvent
} from "../../types";

/**
 * Framework with registry + buildfile + runner, core plugins pinned under
 * `tempDir`, fast polling and backoff, the given fake providers, and a probe
 * exposing `ctx.journal` / `ctx.store`.
 *
 * @param tempDir - Per-test directory.
 * @param providers - Fake providers as `[task, provider, handler]`.
 * @param runnerConfig - Runner config overrides.
 * @returns A started app.
 * @example
 * ```ts
 * const app = await startApp(tempDir, [["image", "fake", handler]]);
 * ```
 */
async function startApp(
  tempDir: string,
  providers: Array<[string, string, ExecutableHandler]>,
  runnerConfig: Record<string, number> = {}
) {
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
      runner: { retryBaseMs: 1, pollIntervalMs: 1, ...runnerConfig }
    }
  });
  const app = framework.createApp();
  await app.start();
  return app;
}

/**
 * A sync image handler returning PNG-typed bytes derived from the prompt.
 *
 * @returns The handler and its call log.
 * @example
 * ```ts
 * const { handler, calls } = imageHandler();
 * ```
 */
function imageHandler(): { handler: ExecutableHandler; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    handler: {
      estimate: () => ({ usd: 0 }),
      execute: async request => {
        calls.push(String(request.prompt));
        return {
          image: new TextEncoder().encode(`png:${String(request.prompt)}`),
          mimeType: "image/png",
          costUsd: 0
        };
      }
    }
  };
}

/** Script for one fake video job handler. */
type JobScript = {
  /** Poll results per job id, consumed in order; the last one repeats. */
  polls: (jobId: string, count: number) => JobPoll;
  /** Called on every poll, before the result is returned. */
  onPoll?: (jobId: string) => void;
};

/**
 * A job-style (`submit` + `poll`) video handler that records submits, polls
 * and the requests it saw.
 *
 * @param script - How polls answer.
 * @returns The handler and its logs.
 * @example
 * ```ts
 * const video = jobHandler({ polls: () => done("clip") });
 * ```
 */
function jobHandler(script: JobScript) {
  const submits: HandlerRequest[] = [];
  const polls: string[] = [];
  const pollCounts = new Map<string, number>();
  const handler: ExecutableHandler = {
    estimate: request => ({ usd: Number(request.seconds ?? 5) * 0.1 }),
    submit: async request => {
      submits.push(request);
      return { jobId: `job-${submits.length}` };
    },
    poll: async jobId => {
      polls.push(jobId);
      const count = (pollCounts.get(jobId) ?? 0) + 1;
      pollCounts.set(jobId, count);
      script.onPoll?.(jobId);
      return script.polls(jobId, count);
    }
  };
  return { handler, submits, polls };
}

/**
 * A finished job poll carrying video bytes.
 *
 * @param text - Marker for the bytes.
 * @returns A `done` poll.
 * @example
 * ```ts
 * done("clip");
 * ```
 */
function done(text: string): JobPoll {
  return {
    state: "done",
    video: new TextEncoder().encode(text),
    mimeType: "video/mp4",
    costUsd: 0.5
  };
}

/** The pending poll. */
const PENDING: JobPoll = { state: "pending" };

/**
 * Consumes `app.runner.events()` next to a started run.
 *
 * @param app - The app.
 * @param app.runner - Its runner API.
 * @param app.runner.events - The event stream opener.
 * @param runPromise - The run in flight.
 * @returns The stream records.
 * @example
 * ```ts
 * const events = await collect(app, app.runner.run({ files }));
 * ```
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

/** Build file: one keyframe image and one video that `$ref`s it. */
const CHAIN_YAML = `version: 1
name: chain
items:
  - id: shot.key
    task: image
    provider: fake
    input: { prompt: "patisserie at night" }
  - id: shot.clip
    task: video
    provider: fake
    input:
      model: m1
      prompt: "slow push-in"
      image: { $ref: shot.key }
      seconds: 5
`;

describe("runner: flat requests, jobs, references, export, reuse", () => {
  let tempDir: string;
  let files: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-runner-jobs-"));
    files = path.join(tempDir, "*.moku.yaml");
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("D1+D10: the video handler gets a flat request with the image resolved to a stored file", async () => {
    const image = imageHandler();
    const video = jobHandler({ polls: () => done("clip") });
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const result = await app.runner.run({ files });

    expect(result).toMatchObject({ status: "done", totals: { total: 2, done: 2 } });
    const [request] = video.submits;
    expect(request?.prompt).toBe("slow push-in");
    expect(request?.params).toEqual({});
    const keyframe = request?.image as ResolvedFile;
    expect(keyframe.mimeType).toBe("image/png");
    expect(await readFile(keyframe.path, "utf8")).toBe("png:patisserie at night");
  });

  it("D9: export writes <out>/<build>/<label>.<ext> with the stored bytes", async () => {
    const image = imageHandler();
    const video = jobHandler({ polls: () => done("clip") });
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const result = await app.runner.run({ files });
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });

    expect(exported.runId).toBe(result.runId);
    expect(exported.files.map(file => path.relative(tempDir, file.path)).toSorted()).toEqual([
      path.join("out", "chain", "shot.clip.mp4"),
      path.join("out", "chain", "shot.key.png")
    ]);
    expect(await readFile(path.join(tempDir, "out", "chain", "shot.clip.mp4"), "utf8")).toBe(
      "clip"
    );
    expect(exported.files.find(file => file.label === "shot.clip")?.costUsd).toBe(0.5);
  });

  it("D8: submits once, polls until done, and records the job", async () => {
    const video = jobHandler({ polls: (_jobId, count) => (count < 3 ? PENDING : done("clip")) });
    const image = imageHandler();
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const result = await app.runner.run({ files });

    expect(result.status).toBe("done");
    expect(video.submits).toHaveLength(1);
    expect(video.polls).toEqual(["job-1", "job-1", "job-1"]);
    const clip = app.probe.journal
      .listItems(result.runId, { status: "done" })
      .find(item => item.task === "video");
    expect(clip?.mimeType).toBe("video/mp4");
    expect(app.probe.journal.findLiveJob(clip?.artifactKey ?? "")).toBeUndefined();
  });

  it("D8: a pause mid-poll never re-submits — resume() polls the same job", async () => {
    const controller = new AbortController();
    const video = jobHandler({
      polls: (_jobId, count) => (count < 2 ? PENDING : done("clip")),
      onPoll: () => controller.abort()
    });
    const image = imageHandler();
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const paused = await app.runner.run({ files }, { signal: controller.signal });
    expect(paused.status).toBe("paused");
    expect(paused.totals).toMatchObject({ done: 1, dispatching: 1 });

    const resumed = await app.runner.resume();

    expect(resumed).toMatchObject({ runId: paused.runId, status: "done" });
    expect(video.submits).toHaveLength(1);
    expect(video.polls).toEqual(["job-1", "job-1"]);
  });

  it("D8: a new run adopts a job left live by a paused run", async () => {
    const controller = new AbortController();
    const video = jobHandler({
      polls: (_jobId, count) => (count < 2 ? PENDING : done("clip")),
      onPoll: () => controller.abort()
    });
    const image = imageHandler();
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    await app.runner.run({ files }, { signal: controller.signal });
    const second = await app.runner.run({ files });

    expect(second.status).toBe("done");
    expect(video.submits).toHaveLength(1);
    expect(image.calls).toHaveLength(1);
  });

  it("D8: a job the provider failed is re-submitted on the next attempt", async () => {
    const video = jobHandler({
      polls: jobId =>
        jobId === "job-1"
          ? { state: "failed", error: Object.assign(new Error("gen timeout"), { status: 503 }) }
          : done("clip")
    });
    const image = imageHandler();
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const result = await app.runner.run({ files });

    expect(result.status).toBe("done");
    expect(video.submits).toHaveLength(2);
  });

  it("D8: a job that stays pending through two timeouts is stuck, and a later attempt re-submits", async () => {
    const video = jobHandler({ polls: jobId => (jobId === "job-1" ? PENDING : done("clip")) });
    const image = imageHandler();
    const app = await startApp(
      tempDir,
      [
        ["image", "fake", image.handler],
        ["video", "fake", video.handler]
      ],
      { jobTimeoutMs: 20 }
    );
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const result = await app.runner.run({ files });

    expect(result.status).toBe("done");
    expect(video.submits).toHaveLength(2);
  });

  it("D7: a TypeError in a handler runs once and fails as unknown", async () => {
    let calls = 0;
    const broken: ExecutableHandler = {
      estimate: () => ({ usd: 0.1 }),
      execute: async () => {
        calls += 1;
        throw new TypeError("cannot read properties of undefined");
      }
    };
    const app = await startApp(tempDir, [["image", "fake", broken]]);
    stops.push(() => app.stop());
    await writeFile(
      path.join(tempDir, "one.moku.yaml"),
      `version: 1\nname: one\nitems:\n  - task: image\n    provider: fake\n    input: { prompt: x }\n`
    );

    const events = await collect(app, app.runner.run({ files }));

    expect(calls).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "item:failed", errorClass: "unknown" })
    );
  });

  it("D10: a failed $ref target leaves its dependent queued and the run paused", async () => {
    const failing: ExecutableHandler = {
      estimate: () => ({ usd: 0 }),
      execute: async () => {
        throw Object.assign(new Error("bad prompt"), { status: 400 });
      }
    };
    const video = jobHandler({ polls: () => done("clip") });
    const app = await startApp(tempDir, [
      ["image", "fake", failing],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    const result = await app.runner.run({ files });

    expect(result).toMatchObject({ status: "paused", totals: { failed: 1, queued: 1 } });
    expect(video.submits).toHaveLength(0);
  });

  it("D2: a second run reuses every done artifact — no provider calls, no spend", async () => {
    const image = imageHandler();
    const video = jobHandler({ polls: () => done("clip") });
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);

    await app.runner.run({ files });
    const second = await app.runner.run({ files });

    expect(second).toMatchObject({ status: "done", totals: { done: 2, spendUsd: 0 } });
    expect(image.calls).toHaveLength(1);
    expect(video.submits).toHaveLength(1);
  });

  it("D2+D10: changing a $ref target re-runs it and its dependents only", async () => {
    const image = imageHandler();
    const video = jobHandler({ polls: () => done("clip") });
    const app = await startApp(tempDir, [
      ["image", "fake", image.handler],
      ["video", "fake", video.handler]
    ]);
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "chain.moku.yaml"), CHAIN_YAML);
    await app.runner.run({ files });

    await writeFile(
      path.join(tempDir, "chain.moku.yaml"),
      CHAIN_YAML.replace("patisserie at night", "patisserie at dawn")
    );
    const second = await app.runner.run({ files });

    expect(second.status).toBe("done");
    expect(image.calls).toEqual(["patisserie at night", "patisserie at dawn"]);
    expect(video.submits).toHaveLength(2);
  });

  it("D10: $file resolves next to the build file, and a changed file is a new artifact", async () => {
    const image = imageHandler();
    const seen: ResolvedFile[] = [];
    const recording: ExecutableHandler = {
      estimate: () => ({ usd: 0 }),
      execute: async request => {
        const [reference] = request.refs as ResolvedFile[];
        if (reference) seen.push(reference);
        return image.handler.execute?.(request, {}) ?? { costUsd: 0 };
      }
    };
    const app = await startApp(tempDir, [["image", "fake", recording]]);
    stops.push(() => app.stop());
    await mkdir(path.join(tempDir, "refs"));
    await writeFile(path.join(tempDir, "refs", "akari.png"), "sheet-v1");
    await writeFile(
      path.join(tempDir, "sheet.moku.yaml"),
      `version: 1\nname: sheet\nitems:\n  - task: image\n    provider: fake\n    input: { prompt: p, refs: [{ $file: refs/akari.png }] }\n`
    );

    await app.runner.run({ files });
    await app.runner.run({ files });
    await writeFile(path.join(tempDir, "refs", "akari.png"), "sheet-v2");
    await app.runner.run({ files });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.path).toBe(path.join(tempDir, "refs", "akari.png"));
    expect(seen[0]?.mimeType).toBe("image/png");
    expect(seen[0]?.hash).not.toBe(seen[1]?.hash);
  });
  it("D9: export skips a label that would escape the output folder, and needs a run", async () => {
    const image = imageHandler();
    const app = await startApp(tempDir, [["image", "fake", image.handler]]);
    stops.push(() => app.stop());

    await expect(app.runner.export()).rejects.toThrow(/No run to export/);
    await expect(app.runner.export({ runId: "nope" })).rejects.toThrow(/Run not found: nope/);

    await writeFile(
      path.join(tempDir, "escape.moku.yaml"),
      `version: 1\nname: esc\nitems:\n  - id: ../escape\n    task: image\n    provider: fake\n    input: { prompt: p }\n  - task: image\n    provider: fake\n    input: { prompt: q }\n`
    );
    await app.runner.run({ files });
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });

    expect(exported.skipped).toEqual(["../escape"]);
    expect(exported.files.map(file => file.label)).toEqual(["02-image"]);
  });

  it("D10: a missing $file fails the run with the file path and the item label", async () => {
    const image = imageHandler();
    const app = await startApp(tempDir, [["image", "fake", image.handler]]);
    stops.push(() => app.stop());
    await writeFile(
      path.join(tempDir, "missing.moku.yaml"),
      `version: 1\nname: missing\nitems:\n  - id: k\n    task: image\n    provider: fake\n    input: { prompt: p, refs: [{ $file: refs/none.png }] }\n`
    );

    await expect(app.runner.estimate({ files })).rejects.toThrow(
      /File not found: .*refs\/none\.png\.\n {2}Referenced by item "k"/
    );
  });
});
