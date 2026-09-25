import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../index";
import type { ExecutableHandler, JobPoll, RunEvent } from "../../types";

/** Runner and limits overrides for one test app. */
type AppOptions = {
  runner?: Record<string, number>;
  limits?: { lanes: Record<string, { concurrency: number }> };
};

/**
 * Framework with registry + buildfile + runner, core plugins pinned under
 * `tempDir`, fast polling and backoff, the given fake providers, and a probe
 * exposing `ctx.journal`, `ctx.store` and `ctx.log`.
 *
 * @param tempDir - Per-test directory.
 * @param providers - Fake providers as `[task, provider, handler]`.
 * @param options - Runner and limits config overrides.
 * @returns A started app.
 * @example
 * ```ts
 * const app = await startApp(tempDir, [["text", "fake", handler]], { runner: { maxActiveRuns: 2 } });
 * ```
 */
async function startApp(
  tempDir: string,
  providers: Array<[string, string, ExecutableHandler]>,
  options: AppOptions = {}
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
    api: ctx => ({ journal: ctx.journal, store: ctx.store, log: ctx.log })
  });

  const framework = createCore(coreConfig, {
    plugins: [registryPlugin, buildfilePlugin, runnerPlugin, providerPlugin, probePlugin],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      runner: { retryBaseMs: 1, pollIntervalMs: 1, ...options.runner },
      ...(options.limits ? { limits: options.limits } : {})
    }
  });
  const app = framework.createApp();
  await app.start();
  return app;
}

/**
 * Resolves after `ms` milliseconds.
 *
 * @param ms - Delay.
 * @returns Resolves once the delay elapses.
 * @example
 * ```ts
 * await sleep(5);
 * ```
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * An `execute` handler for the `text` task. Each call can be held on a
 * promise keyed by the item's `text`; it records calls and peak concurrency.
 *
 * @param options - Holds per item text, a delay, fixed bytes and a cost.
 * @param options.holds - Promise each item text waits on before it returns.
 * @param options.delayMs - Delay for items without a hold. Default 0.
 * @param options.bytes - Bytes every call returns; default derived from the text.
 * @param options.costUsd - Estimate and cost per item. Default 0.1.
 * @returns The handler, its calls and its concurrency counters.
 * @example
 * ```ts
 * const text = executeHandler({ holds: { a1: hold.promise } });
 * ```
 */
function executeHandler(
  options: {
    holds?: Record<string, Promise<void>>;
    delayMs?: number;
    bytes?: string;
    costUsd?: number;
  } = {}
) {
  const calls: string[] = [];
  const concurrency = { now: 0, peak: 0 };
  const costUsd = options.costUsd ?? 0.1;
  const handler: ExecutableHandler = {
    estimate: () => ({ usd: costUsd }),
    execute: async request => {
      const text = String(request.text);
      calls.push(text);
      concurrency.now += 1;
      concurrency.peak = Math.max(concurrency.peak, concurrency.now);
      try {
        await (options.holds?.[text] ?? sleep(options.delayMs ?? 0));
      } finally {
        concurrency.now -= 1;
      }
      return {
        body: new TextEncoder().encode(options.bytes ?? `bytes:${text}`),
        mimeType: "text/plain",
        costUsd
      };
    }
  };
  return { handler, calls, concurrency };
}

/** The pending poll. */
const PENDING: JobPoll = { state: "pending" };

/** A finished job poll carrying video bytes, cost 0.5. */
const DONE: JobPoll = {
  state: "done",
  video: new TextEncoder().encode("clip"),
  mimeType: "video/mp4",
  costUsd: 0.5
};

/**
 * A job-style (`submit` + `poll`) handler for the `video` task: polls stay
 * pending until `isDone()` is true.
 *
 * @param isDone - Whether the provider has finished the job.
 * @returns The handler and its submit/poll logs.
 * @example
 * ```ts
 * const video = jobHandler(() => finished);
 * ```
 */
function jobHandler(isDone: () => boolean) {
  const submits: string[] = [];
  const polls: string[] = [];
  const handler: ExecutableHandler = {
    estimate: () => ({ usd: 0.5 }),
    submit: async () => {
      const jobId = `job-${submits.length + 1}`;
      submits.push(jobId);
      return { jobId };
    },
    poll: async jobId => {
      polls.push(jobId);
      return isDone() ? DONE : PENDING;
    }
  };
  return { handler, submits, polls };
}

/**
 * Writes one build file with one item per text into its own folder.
 *
 * @param dir - Folder for the build file.
 * @param texts - One item per text.
 * @param task - The items' task. Default "text".
 * @returns The glob matching that folder's build files.
 * @example
 * ```ts
 * const files = await writeBuild(path.join(tempDir, "a"), ["a1", "a2"]);
 * ```
 */
async function writeBuild(dir: string, texts: string[], task = "text"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = path.basename(dir);
  const items = texts
    .map(text => `  - task: ${task}\n    provider: fake\n    input: { text: "${text}" }`)
    .join("\n");
  await writeFile(
    path.join(dir, `${name}.moku.yaml`),
    `version: 1\nname: ${name}\nitems:\n${items}\n`
  );
  return path.join(dir, "*.moku.yaml");
}

/**
 * Drains a stream into an array.
 *
 * @param stream - The stream.
 * @returns Every record, in delivery order.
 * @example
 * ```ts
 * const records = await collect(app.runner.events());
 * ```
 */
async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const records: RunEvent[] = [];
  for await (const event of stream) records.push(event);
  return records;
}

/**
 * Counts the content-addressed objects in a store directory.
 *
 * @param dir - Store root.
 * @returns How many files are named like a sha256 hash, and how many temp files remain.
 * @example
 * ```ts
 * const { objects } = await storeFiles(path.join(tempDir, "store"));
 * ```
 */
async function storeFiles(dir: string): Promise<{ objects: number; temporary: number }> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile());
  return {
    objects: files.filter(entry => /^[0-9a-f]{64}$/.test(entry.name)).length,
    temporary: files.filter(entry => entry.name.startsWith(".tmp")).length
  };
}

/**
 * How many times the runner logged `event` so far.
 *
 * @param app - The app.
 * @param app.probe - Its probe, exposing the log.
 * @param app.probe.log - The log API.
 * @param app.probe.log.trace - The in-memory trace.
 * @param event - Log event name.
 * @returns The count.
 * @example
 * ```ts
 * logged(app, "runner:dedupe:wait"); // 1
 * ```
 */
function logged(
  app: { probe: { log: { trace(): readonly { event: string }[] } } },
  event: string
): number {
  return app.probe.log.trace().filter(entry => entry.event === event).length;
}

describe("runner: several runs at once", () => {
  let tempDir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-runner-concurrent-"));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Starts an app for this test and registers its stop.
   *
   * @param providers - Fake providers.
   * @param options - Config overrides.
   * @returns The started app.
   * @example
   * ```ts
   * const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
   * ```
   */
  async function open(providers: Array<[string, string, ExecutableHandler]>, options?: AppOptions) {
    const app = await startApp(tempDir, providers, options);
    stops.push(() => app.stop());
    return app;
  }

  // -------------------------------------------------------------------------
  // The cap
  // -------------------------------------------------------------------------

  it("maxActiveRuns 2: two runs at once finish done with their own runIds and totals", async () => {
    const hold = Promise.withResolvers<void>();
    const texts = ["a1", "a2", "b1", "b2", "b3"];
    const text = executeHandler({
      holds: Object.fromEntries(texts.map(name => [name, hold.promise]))
    });
    const app = await open([["text", "fake", text.handler]], {
      runner: { maxActiveRuns: 2 },
      limits: { lanes: { "text/fake": { concurrency: 8 } } }
    });
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a1", "a2"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1", "b2", "b3"]);

    const runA = app.runner.run({ files: filesA });
    const runB = app.runner.run({ files: filesB });
    // Both runs have items in the provider at the same moment.
    await vi.waitFor(() => expect(text.calls).toHaveLength(5));
    hold.resolve();
    const [a, b] = await Promise.all([runA, runB]);

    expect(a.runId).not.toBe(b.runId);
    expect(a).toMatchObject({ status: "done", totals: { total: 2, done: 2 } });
    expect(b).toMatchObject({ status: "done", totals: { total: 3, done: 3 } });
    expect(app.runner.status(a.runId).totals.total).toBe(2);
  });

  it("maxActiveRuns 2 refuses a third run and names both active runs", async () => {
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { a1: hold.promise, b1: hold.promise } });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a1"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1"]);
    const filesC = await writeBuild(path.join(tempDir, "c"), ["c1"]);
    const ids: string[] = [];

    const runA = app.runner.run({ files: filesA }, { onStart: runId => ids.push(runId) });
    const runB = app.runner.run({ files: filesB }, { onStart: runId => ids.push(runId) });

    await expect(app.runner.run({ files: filesC })).rejects.toThrow(
      `[ai] A run is already active: ${ids.join(", ")}.\n  maxActiveRuns is 2. Wait for a run to finish, or raise runner.maxActiveRuns.`
    );
    hold.resolve();
    await Promise.all([runA, runB]);
    expect(text.calls.toSorted()).toEqual(["a1", "b1"]);
  });

  it("the default config refuses a second run with today's first line", async () => {
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { a1: hold.promise } });
    const app = await open([["text", "fake", text.handler]]);
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a1"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1"]);
    let idA = "";

    const runA = app.runner.run({ files: filesA }, { onStart: runId => (idA = runId) });
    const refused: unknown = await app.runner
      .run({ files: filesB })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message.split("\n")[0]).toBe(`[ai] A run is already active: ${idA}.`);
    hold.resolve();
    expect(await runA).toMatchObject({ status: "done" });
  });

  // -------------------------------------------------------------------------
  // Shared lanes
  // -------------------------------------------------------------------------

  it("two runs share one lane: concurrency 2 is never exceeded across both runs", async () => {
    const text = executeHandler({ delayMs: 20 });
    const app = await open([["text", "fake", text.handler]], {
      runner: { maxActiveRuns: 2 },
      limits: { lanes: { "text/fake": { concurrency: 2 } } }
    });
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a1", "a2", "a3"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1", "b2", "b3"]);

    const [a, b] = await Promise.all([
      app.runner.run({ files: filesA }),
      app.runner.run({ files: filesB })
    ]);

    expect([a.status, b.status]).toEqual(["done", "done"]);
    expect(text.calls).toHaveLength(6);
    expect(text.concurrency.peak).toBe(2);
  });

  it("four runs share one lane: concurrency 4 stays the total in flight across all four", async () => {
    const hold = Promise.withResolvers<void>();
    const runNames = ["a", "b", "c", "d"];
    const texts = runNames.flatMap(name => [`${name}1`, `${name}2`, `${name}3`]);
    const text = executeHandler({
      holds: Object.fromEntries(texts.map(name => [name, hold.promise]))
    });
    const app = await open([["text", "fake", text.handler]], {
      runner: { maxActiveRuns: 4 },
      limits: { lanes: { "text/fake": { concurrency: 4 } } }
    });
    const globs = await Promise.all(
      runNames.map(name =>
        writeBuild(path.join(tempDir, name), [`${name}1`, `${name}2`, `${name}3`])
      )
    );

    const runs = globs.map(files => app.runner.run({ files }));
    // Four items reach the provider; the other eight wait for the shared lane.
    await vi.waitFor(() => expect(text.calls).toHaveLength(4));
    await sleep(20);
    expect(text.concurrency.now).toBe(4);
    expect(text.calls).toHaveLength(4);
    hold.resolve();
    const results = await Promise.all(runs);

    expect(results.map(result => result.status)).toEqual(["done", "done", "done", "done"]);
    expect(text.calls).toHaveLength(12);
    expect(text.concurrency.peak).toBe(4);
  });

  // -------------------------------------------------------------------------
  // Cross-run dedupe
  // -------------------------------------------------------------------------

  it("the same job item in two runs is submitted once; the follower reuses it at cost 0", async () => {
    let finished = false;
    const video = jobHandler(() => finished);
    const app = await open([["video", "fake", video.handler]], { runner: { maxActiveRuns: 2 } });
    const files = await writeBuild(path.join(tempDir, "shared"), ["clip"], "video");

    const runA = app.runner.run({ files });
    const runB = app.runner.run({ files });
    await vi.waitFor(() => {
      expect(video.submits).toHaveLength(1);
      expect(logged(app, "runner:dedupe:wait")).toBe(1);
    });
    finished = true;
    const [a, b] = await Promise.all([runA, runB]);

    expect(video.submits).toHaveLength(1);
    expect([a.status, b.status]).toEqual(["done", "done"]);
    const [itemA] = app.probe.journal.listItems(a.runId);
    const [itemB] = app.probe.journal.listItems(b.runId);
    expect(new Set([itemA?.actualCostUsd, itemB?.actualCostUsd])).toEqual(new Set([0, 0.5]));
    expect(new Set([a.totals.spendUsd, b.totals.spendUsd])).toEqual(new Set([0, 0.5]));
    expect(itemA?.contentHash).toBeTruthy();
    expect(itemA?.contentHash).toBe(itemB?.contentHash);
  });

  it("the same execute item in two runs is executed once", async () => {
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { shot: hold.promise } });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const files = await writeBuild(path.join(tempDir, "shared"), ["shot"]);

    const runA = app.runner.run({ files });
    const runB = app.runner.run({ files });
    await vi.waitFor(() => {
      expect(text.calls).toHaveLength(1);
      expect(logged(app, "runner:dedupe:wait")).toBe(1);
    });
    hold.resolve();
    const [a, b] = await Promise.all([runA, runB]);

    expect(text.calls).toEqual(["shot"]);
    expect([a.totals.done, b.totals.done]).toEqual([1, 1]);
  });

  // -------------------------------------------------------------------------
  // Abort isolation
  // -------------------------------------------------------------------------

  it("aborting one run pauses it while the other run keeps going to done", async () => {
    const video = jobHandler(() => false);
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { b1: hold.promise } });
    const app = await open(
      [
        ["video", "fake", video.handler],
        ["text", "fake", text.handler]
      ],
      { runner: { maxActiveRuns: 2 } }
    );
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a-clip"], "video");
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1"]);
    const controller = new AbortController();

    const runA = app.runner.run({ files: filesA }, { signal: controller.signal });
    const runB = app.runner.run({ files: filesB });
    await vi.waitFor(() => {
      expect(video.submits).toHaveLength(1);
      expect(text.calls).toEqual(["b1"]);
    });
    controller.abort();

    const a = await runA;
    expect(a).toMatchObject({ status: "paused", totals: { dispatching: 1 } });
    // B's item is still inside its provider call: A's abort did not touch it.
    expect(text.concurrency.now).toBe(1);

    hold.resolve();
    expect(await runB).toMatchObject({ status: "done", totals: { done: 1 } });
  });

  it("aborting the leader of a shared item hands its job to the follower: one submit, follower done", async () => {
    let finished = false;
    const video = jobHandler(() => finished);
    const app = await open([["video", "fake", video.handler]], { runner: { maxActiveRuns: 2 } });
    const files = await writeBuild(path.join(tempDir, "shared"), ["clip"], "video");
    const controller = new AbortController();

    const runA = app.runner.run({ files }, { signal: controller.signal });
    await vi.waitFor(() => expect(video.submits).toHaveLength(1));
    const runB = app.runner.run({ files });
    await vi.waitFor(() => expect(logged(app, "runner:dedupe:wait")).toBe(1));
    finished = true;
    controller.abort();
    const [a, b] = await Promise.all([runA, runB]);

    expect(a.status).toBe("paused");
    expect(b).toMatchObject({ status: "done", totals: { done: 1, spendUsd: 0.5 } });
    expect(video.submits).toEqual(["job-1"]);
    expect(logged(app, "runner:job:adopted")).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Per-run budget
  // -------------------------------------------------------------------------

  it("maxCostUsd is per run: the capped run budget-stops, the uncapped one finishes", async () => {
    const text = executeHandler({ costUsd: 0.6 });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a1", "a2"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1", "b2"]);

    const [a, b] = await Promise.all([
      app.runner.run({ files: filesA, maxCostUsd: 1 }),
      app.runner.run({ files: filesB })
    ]);

    expect(a).toMatchObject({ status: "budget-stopped", totals: { done: 1, queued: 1 } });
    expect(b).toMatchObject({ status: "done", totals: { done: 2 } });
    expect(b.totals.spendUsd).toBeCloseTo(1.2, 10);
  });

  // -------------------------------------------------------------------------
  // resume() next to an active run
  // -------------------------------------------------------------------------

  it("resume() works while another run is active, and its default target skips that run", async () => {
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { x1: hold.promise } });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const filesP = await writeBuild(path.join(tempDir, "p"), ["p1"]);
    const filesX = await writeBuild(path.join(tempDir, "x"), ["x1"]);
    const stopped = new AbortController();
    stopped.abort();

    const paused = await app.runner.run({ files: filesP }, { signal: stopped.signal });
    expect(paused).toMatchObject({ status: "paused", totals: { queued: 1 } });
    await sleep(5);
    let idX = "";
    const runX = app.runner.run({ files: filesX }, { onStart: runId => (idX = runId) });
    await vi.waitFor(() => expect(text.calls).toEqual(["x1"]));
    // Without the exclusion the newest resumable run would be the active one.
    expect(app.probe.journal.latestResumableRun()?.id).toBe(idX);

    const resumed = await app.runner.resume();

    expect(resumed).toMatchObject({ runId: paused.runId, status: "done", totals: { done: 1 } });
    hold.resolve();
    expect(await runX).toMatchObject({ runId: idX, status: "done" });
  });

  it("resume({ runId }) of a run this process drives is refused at cap 2", async () => {
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { x1: hold.promise } });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const filesX = await writeBuild(path.join(tempDir, "x"), ["x1"]);
    let idX = "";

    const runX = app.runner.run({ files: filesX }, { onStart: runId => (idX = runId) });

    await expect(app.runner.resume({ runId: idX })).rejects.toThrow(
      `[ai] Run is already active in this process: ${idX}.\n  Follow it with events({ runId }) instead of resuming it.`
    );
    hold.resolve();
    expect(await runX).toMatchObject({ status: "done" });
  });

  // -------------------------------------------------------------------------
  // events(): one run or all runs
  // -------------------------------------------------------------------------

  it("events({ runId }) sees only its run; events() sees both and closes after the last run", async () => {
    const holdA = Promise.withResolvers<void>();
    const holdB = Promise.withResolvers<void>();
    const text = executeHandler({ holds: { a1: holdA.promise, b1: holdB.promise } });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const filesA = await writeBuild(path.join(tempDir, "a"), ["a1"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["b1"]);
    let ownA: Promise<RunEvent[]> = Promise.resolve([]);
    let ownB: Promise<RunEvent[]> = Promise.resolve([]);
    let everyRun: Promise<RunEvent[]> = Promise.resolve([]);
    let everyRunClosed = false;

    const runA = app.runner.run(
      { files: filesA },
      {
        onStart: runId => {
          ownA = collect(app.runner.events({ runId }));
          everyRun = collect(app.runner.events()).finally(() => (everyRunClosed = true));
        }
      }
    );
    const runB = app.runner.run(
      { files: filesB },
      { onStart: runId => (ownB = collect(app.runner.events({ runId }))) }
    );
    await vi.waitFor(() => expect(text.calls.toSorted()).toEqual(["a1", "b1"]));

    holdA.resolve();
    const a = await runA;
    const recordsA = await ownA;
    await sleep(5);
    expect(everyRunClosed).toBe(false);

    holdB.resolve();
    const b = await runB;
    const [recordsB, recordsAll] = await Promise.all([ownB, everyRun]);
    expect(everyRunClosed).toBe(true);

    expect(recordsA.every(record => record.runId === a.runId)).toBe(true);
    expect(recordsA.at(-1)).toMatchObject({ type: "terminal", runId: a.runId, status: "done" });
    expect(recordsB.every(record => record.runId === b.runId)).toBe(true);
    expect(recordsB.at(-1)).toMatchObject({ type: "terminal", runId: b.runId, status: "done" });
    expect(recordsAll.every(record => typeof record.runId === "string")).toBe(true);
    expect(new Set(recordsAll.map(record => record.runId))).toEqual(new Set([a.runId, b.runId]));
    expect(
      recordsAll.filter(record => record.type === "terminal").map(record => record.runId)
    ).toEqual([a.runId, b.runId]);
  });

  it("onStart runs once, synchronously; a stream opened inside it gets the run's first and last record", async () => {
    const text = executeHandler();
    const app = await open([["text", "fake", text.handler]]);
    const files = await writeBuild(path.join(tempDir, "s"), ["s1"]);
    let own: Promise<RunEvent[]> = Promise.resolve([]);
    const onStart = vi.fn((runId: string) => {
      own = collect(app.runner.events({ runId }));
    });

    const pending = app.runner.run({ files }, { onStart });
    expect(onStart).toHaveBeenCalledTimes(1);
    const result = await pending;
    const records = await own;

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(result.runId);
    expect(records[0]).toMatchObject({ type: "item:queued", runId: result.runId });
    expect(records.at(-1)).toMatchObject({ type: "terminal", runId: result.runId, status: "done" });
  });

  // -------------------------------------------------------------------------
  // Store safety
  // -------------------------------------------------------------------------

  it("two runs committing the same bytes at once leave one store object, and both items point at it", async () => {
    const hold = Promise.withResolvers<void>();
    const text = executeHandler({
      bytes: "identical bytes",
      holds: { one: hold.promise, two: hold.promise }
    });
    const app = await open([["text", "fake", text.handler]], { runner: { maxActiveRuns: 2 } });
    const filesA = await writeBuild(path.join(tempDir, "a"), ["one"]);
    const filesB = await writeBuild(path.join(tempDir, "b"), ["two"]);

    const runA = app.runner.run({ files: filesA });
    const runB = app.runner.run({ files: filesB });
    await vi.waitFor(() => expect(text.calls).toHaveLength(2));
    hold.resolve();
    const [a, b] = await Promise.all([runA, runB]);

    const [itemA] = app.probe.journal.listItems(a.runId);
    const [itemB] = app.probe.journal.listItems(b.runId);
    expect([itemA?.status, itemB?.status]).toEqual(["done", "done"]);
    expect(itemA?.artifactKey).not.toBe(itemB?.artifactKey);
    expect(itemA?.contentHash).toBe(itemB?.contentHash);
    expect(await storeFiles(path.join(tempDir, "store"))).toEqual({ objects: 1, temporary: 0 });
  });
});
