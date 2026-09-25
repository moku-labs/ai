import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerApi, shouldEmitProgress } from "../../api";
import { addActiveRun } from "../../state";
import type { RunEvent } from "../../types";
import { type CallLog, createFakeRunnerContext, ZERO_TOTALS } from "./fixtures";

/**
 * Drains a stream into an array.
 *
 * @param stream - The stream to drain.
 * @returns Every record, in delivery order.
 * @example
 * ```ts
 * const records = await collect(api.events());
 * ```
 */
async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const records: RunEvent[] = [];
  for await (const event of stream) records.push(event);
  return records;
}

// ---------------------------------------------------------------------------
// shouldEmitProgress — the ≤1/500ms progress-coalescing throttle rule
// ---------------------------------------------------------------------------

describe("shouldEmitProgress", () => {
  const PROGRESS_COALESCE_MS = 500;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not emit before the coalescing window elapses", () => {
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS - 100);
    expect(shouldEmitProgress(0, Date.now())).toBe(false);
  });

  it("emits once the coalescing window elapses (inclusive boundary)", () => {
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS);
    expect(shouldEmitProgress(0, Date.now())).toBe(true);
  });

  it("emits again only after another full window from the new lastProgressAt", () => {
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS);
    const firstEmitAt = Date.now();

    vi.advanceTimersByTime(PROGRESS_COALESCE_MS - 1);
    expect(shouldEmitProgress(firstEmitAt, Date.now())).toBe(false);

    vi.advanceTimersByTime(1);
    expect(shouldEmitProgress(firstEmitAt, Date.now())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createRunnerApi — status()/events() edge behavior without an active run
// ---------------------------------------------------------------------------

describe("createRunnerApi", () => {
  it("status() throws a two-line error when no run id is given and none can be inferred", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const api = createRunnerApi(ctx);

    expect(() => api.status()).toThrow(/^\[ai\] No run to report status for/);
  });

  it("status() reads the given runId via journal.readSnapshot", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const api = createRunnerApi(ctx);

    const report = api.status("run-42");

    expect(report.runId).toBe("run-42");
  });

  it("events() returns an already-closed empty stream when no run is active", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const api = createRunnerApi(ctx);

    const received: RunEvent[] = [];
    for await (const event of api.events()) {
      received.push(event);
    }

    expect(received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Several runs at once — maxActiveRuns guards, onStart, targets, events(opts)
// ---------------------------------------------------------------------------

describe("createRunnerApi — maxActiveRuns guards", () => {
  it.each([
    0,
    1.5,
    Number.NaN
  ])("run() refuses maxActiveRuns %s with the config error", async value => {
    const ctx = createFakeRunnerContext([], { config: { maxActiveRuns: value } });
    const api = createRunnerApi(ctx);

    await expect(api.run({})).rejects.toThrow(
      `[ai] runner.maxActiveRuns must be a whole number >= 1, got ${value}.\n  Fix the runner config.`
    );
    await expect(api.resume()).rejects.toThrow(/^\[ai\] runner\.maxActiveRuns must be/);
  });

  it("the default cap of 1 refuses a second run with today's first line", async () => {
    const ctx = createFakeRunnerContext([]);
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    const refused: unknown = await api.run({}).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(Error);
    const message = (refused as Error).message;
    expect(message.split("\n")[0]).toBe("[ai] A run is already active: run-a.");
    expect(message).toBe(
      "[ai] A run is already active: run-a.\n  maxActiveRuns is 1. Wait for a run to finish, or raise runner.maxActiveRuns."
    );
  });

  it("checks the cap before the dry-run branch", async () => {
    const ctx = createFakeRunnerContext([]);
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    await expect(api.run({ dryRun: true })).rejects.toThrow(/^\[ai\] A run is already active/);
  });

  it("at the cap lists every active run id", async () => {
    const ctx = createFakeRunnerContext([], { config: { maxActiveRuns: 2 } });
    addActiveRun(ctx.state, "run-a", undefined);
    addActiveRun(ctx.state, "run-b", undefined);
    const api = createRunnerApi(ctx);

    await expect(api.run({})).rejects.toThrow(
      "[ai] A run is already active: run-a, run-b.\n  maxActiveRuns is 2."
    );
  });

  it("below the cap starts another run while one is active", async () => {
    const ctx = createFakeRunnerContext([], { config: { maxActiveRuns: 2 } });
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    const result = await api.run({});

    expect(result).toMatchObject({ runId: "run-1", status: "done" });
    expect([...ctx.state.active.keys()]).toEqual(["run-a"]);
  });

  it("resume() checks the cap before the already-active guard", async () => {
    const ctx = createFakeRunnerContext([]);
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    await expect(api.resume({ runId: "run-a" })).rejects.toThrow(
      /^\[ai\] A run is already active: run-a\./
    );
  });

  it("resume({ runId }) of a run this process drives is refused below the cap", async () => {
    const ctx = createFakeRunnerContext([], { config: { maxActiveRuns: 2 } });
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    await expect(api.resume({ runId: "run-a" })).rejects.toThrow(
      "[ai] Run is already active in this process: run-a.\n  Follow it with events({ runId }) instead of resuming it."
    );
  });
});

describe("createRunnerApi — run lifecycle", () => {
  it("calls onStart once, synchronously, with the run id", async () => {
    const ctx = createFakeRunnerContext([]);
    const api = createRunnerApi(ctx);
    const onStart = vi.fn();

    const pending = api.run({}, { onStart });
    expect(onStart).toHaveBeenCalledWith("run-1");
    expect(ctx.state.active.has("run-1")).toBe(true);
    await pending;

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("a stream opened for the run inside onStart receives its terminal record", async () => {
    const ctx = createFakeRunnerContext([]);
    const api = createRunnerApi(ctx);
    let records: Promise<RunEvent[]> | undefined;

    await api.run({}, { onStart: runId => (records = collect(api.events({ runId }))) });

    const received = await records;
    expect(received?.at(-1)).toEqual({
      type: "terminal",
      runId: "run-1",
      status: "done",
      totals: ZERO_TOTALS
    });
  });

  it("a throwing onStart fails the run and frees its slot", async () => {
    const ctx = createFakeRunnerContext([]);
    const api = createRunnerApi(ctx);

    const result = await api.run(
      {},
      {
        onStart: () => {
          throw new Error("consumer bug");
        }
      }
    );

    expect(result.status).toBe("failed");
    expect(ctx.state.active.size).toBe(0);
  });

  it("leaves state.active and closes every stream of the run when it ends", async () => {
    const ctx = createFakeRunnerContext([]);
    const api = createRunnerApi(ctx);
    let streams: Array<Promise<RunEvent[]>> = [];

    await api.run(
      {},
      { onStart: runId => (streams = [collect(api.events({ runId })), collect(api.events())]) }
    );

    const [ownRun, everyRun] = await Promise.all(streams);
    expect(ctx.state.active.size).toBe(0);
    expect(ctx.state.subscribers.size).toBe(0);
    expect(ownRun?.at(-1)?.type).toBe("terminal");
    expect(everyRun?.at(-1)?.type).toBe("terminal");
  });

  it("resume() targets the newest resumable run that this process does not drive", async () => {
    const opened = createFakeRunnerContext([]).journal.openRun({ glob: "(default)" });
    const paused = { ...opened, id: "run-p", status: "paused" as const };
    const latestResumableRun = vi.fn(() => paused);
    const ctx = createFakeRunnerContext([], {
      config: { maxActiveRuns: 2 },
      journal: { latestResumableRun }
    });
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    const result = await api.resume();

    expect(latestResumableRun).toHaveBeenCalledWith({ exclude: ["run-a"] });
    expect(result.runId).toBe("run-p");
  });
});

describe("createRunnerApi — status() and events(opts) with several runs", () => {
  it("status() with no id prefers the newest active run", () => {
    const ctx = createFakeRunnerContext([], { config: { maxActiveRuns: 2 } });
    addActiveRun(ctx.state, "run-a", undefined);
    addActiveRun(ctx.state, "run-b", undefined);
    const api = createRunnerApi(ctx);

    expect(api.status().runId).toBe("run-b");
  });

  it("events({ runId }) for a run that is not active returns an already-closed empty stream", async () => {
    const ctx = createFakeRunnerContext([]);
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    expect(await collect(api.events({ runId: "run-unknown" }))).toEqual([]);
    expect(ctx.state.subscribers.size).toBe(0);
  });

  it("events({ runId }) of an active run subscribes to that run only", () => {
    const ctx = createFakeRunnerContext([]);
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);

    api.events({ runId: "run-a" });
    api.events();

    expect([...ctx.state.subscribers].map(subscriber => subscriber.runId)).toEqual([
      "run-a",
      undefined
    ]);
  });

  it("a consumer that stops iterating early is removed from the subscribers", async () => {
    const ctx = createFakeRunnerContext([]);
    addActiveRun(ctx.state, "run-a", undefined);
    const api = createRunnerApi(ctx);
    const stream = api.events({ runId: "run-a" });
    const [subscriber] = ctx.state.subscribers;
    subscriber?.queue.push({ type: "item:dispatching", runId: "run-a", itemId: "i1" });

    for await (const event of stream) {
      expect(event.runId).toBe("run-a");
      break;
    }

    expect(ctx.state.subscribers.size).toBe(0);
  });
});
