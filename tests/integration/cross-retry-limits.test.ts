/**
 * @file Batch 4 — cross-plugin retry/limits integration scenarios (S14–S17).
 *
 * Exercises the retry taxonomy, terminal-failure path, lane-slot behavior
 * during retry backoff (observational), and abort→pause→resume through the
 * REAL framework composition (buildfile → registry → runner → journal/store/
 * limits), against a per-test tmp-dir journal.db / store dir.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutableHandler, HandlerRequest, RunEvent } from "../../src/plugins/runner/types";
import {
  buildFileYaml,
  buildFramework,
  createDeferred,
  createFakeHandler,
  createFakeProviderPlugin,
  createRunEventListenerPlugin
} from "./helpers";

/**
 * Lane key for the fake task/provider pair. Verified in
 * `src/plugins/runner/pipeline.ts` (`laneOf`): the runner appends the literal
 * `"default"` account segment (M0 has no account pools), so the lane is
 * `"{task}/{provider}/default"` — NOT the bare `"{task}/{provider}"` prefix.
 */
const LANE = "fakeTask/fake/default";

/** Extracts the `text` input marker the runner passed to a handler. */
function markerOf(request: unknown): string {
  return String((request as HandlerRequest).text);
}

/** The `item:*` record types of a collected stream, in delivery order. */
function itemEventTypes(events: RunEvent[]): string[] {
  return events.filter(event => event.type.startsWith("item:")).map(event => event.type);
}

/** Pre-seeded sink for the five runner bus events. */
function createSink(): Record<string, unknown[]> {
  return {
    "run:progress": [],
    "run:done": [],
    "run:failed": [],
    "run:budget-stop": [],
    "run:paused": []
  };
}

describe("cross-plugin retry + limits integration", () => {
  let tempDir: string;
  let stopApp: (() => Promise<unknown>) | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
    stopApp = undefined;
  });

  afterEach(async () => {
    await stopApp?.();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S14 — retry path: item:retry → item:done, attempts ledger, breaker closed
  // ---------------------------------------------------------------------------

  it("S14: a retryable 5xx produces item:retry then item:done, ledgered, breaker still closed", async () => {
    const handler = createFakeHandler({ costUsd: 0.1, failuresBeforeSuccess: 1 });
    const framework = buildFramework(tempDir, {
      pluginConfigs: { runner: { maxAttempts: 3, retryBaseMs: 1 } },
      extraPlugins: [createFakeProviderPlugin("fixtureRetry", "fakeTask", "fake", handler)]
    });
    const app = framework.createApp();
    await app.start();
    stopApp = () => app.stop();

    // One build item that fails once (500) before succeeding.
    await writeFile(
      path.join(tempDir, "retry.moku.yaml"),
      buildFileYaml("retry", [{ task: "fakeTask", provider: "fake", input: { text: "a" } }])
    );

    // Collect the live stream around the run.
    const events: RunEvent[] = [];
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const consuming = (async (): Promise<void> => {
      for await (const event of app.runner.events()) {
        events.push(event);
        if (event.type === "terminal") break;
      }
    })();
    const [result] = await Promise.all([runPromise, consuming]);

    // Stream: queued → dispatching → retry → dispatching (re-admitted) → done.
    expect(itemEventTypes(events)).toEqual([
      "item:queued",
      "item:dispatching",
      "item:retry",
      "item:dispatching",
      "item:done"
    ]);
    expect(events.find(event => event.type === "item:retry")).toMatchObject({
      errorClass: "http-5xx",
      attempt: 1
    });
    expect(result).toMatchObject({ status: "done", totals: { total: 1, done: 1 } });

    // Attempts ledger: the handler ran twice; the item row's attemptCount is 1
    // because the journal increments attempt_count ONLY on the retryable
    // re-queue (markFailed terminal:false) — commitDone does not increment
    // (verified in src/plugins/journal/api.ts markFailed/commitDone). The plan
    // assumed 2; the durable field counts completed re-queues, not attempts.
    expect(handler.attempts()).toBe(2);
    const [item] = app.probe.journal.listItems(result.runId);
    expect(item).toMatchObject({ status: "done", attemptCount: 1, actualCostUsd: 0.1 });

    // The failed attempt is not charged.
    expect(app.probe.journal.totals(result.runId).spendUsd).toBeCloseTo(0.1);

    // One retryable-error is below the default breaker threshold (5): closed.
    expect(app.probe.limits.snapshot(LANE).breaker).toBe("closed");
  });

  // ---------------------------------------------------------------------------
  // S15 — terminal 4xx: item:failed, no retry, run still completes "done"
  // ---------------------------------------------------------------------------

  it("S15: a terminal 4xx fails the item on attempt 1 while the run completes done", async () => {
    const healthy = createFakeHandler({ costUsd: 0.1 });
    const broken = createFakeHandler({ costUsd: 0.1, terminalFailure: true });
    const framework = buildFramework(tempDir, {
      pluginConfigs: { runner: { maxAttempts: 3, retryBaseMs: 1 } },
      extraPlugins: [
        createFakeProviderPlugin("fixtureHealthy", "fakeTask", "fake", healthy),
        createFakeProviderPlugin("fixtureBroken", "fakeTask", "broken", broken)
      ]
    });
    const app = framework.createApp();
    await app.start();
    stopApp = () => app.stop();

    // Two items: one healthy provider, one that always throws {status: 400}.
    await writeFile(
      path.join(tempDir, "terminal.moku.yaml"),
      buildFileYaml("terminal", [
        { task: "fakeTask", provider: "fake", input: { text: "ok" } },
        { task: "fakeTask", provider: "broken", input: { text: "bad" } }
      ])
    );

    const events: RunEvent[] = [];
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const consuming = (async (): Promise<void> => {
      for await (const event of app.runner.events()) {
        events.push(event);
        if (event.type === "terminal") break;
      }
    })();
    const [result] = await Promise.all([runPromise, consuming]);

    // Exactly one item:failed with the 4xx class, and NO item:retry anywhere
    // (4xx except 429 is terminal — src/plugins/runner/retry.ts classifyError).
    const failed = events.filter(event => event.type === "item:failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ errorClass: "http-4xx" });
    expect(events.some(event => event.type === "item:retry")).toBe(false);

    // The run itself completes "done" with a mixed done/failed ledger.
    expect(result).toMatchObject({ status: "done", totals: { total: 2, done: 1, failed: 1 } });
    expect(result.totals.spendUsd).toBeCloseTo(0.1);

    // Terminal failure = exactly one provider attempt. The durable row's
    // attemptCount stays 0 — the journal increments attempt_count only on
    // retryable re-queues (markFailed terminal:true leaves it untouched,
    // verified in src/plugins/journal/api.ts). The plan assumed 1; the
    // single-attempt fact is asserted via the handler's own counter.
    expect(broken.attempts()).toBe(1);
    const [failedRow] = app.probe.journal.listItems(result.runId, { status: "failed" });
    expect(failedRow).toMatchObject({ provider: "broken", status: "failed", attemptCount: 0 });
  });

  // ---------------------------------------------------------------------------
  // S16 — lane slot released during retry backoff
  // ---------------------------------------------------------------------------

  it("S16: the lane concurrency slot is RELEASED during retry backoff", async () => {
    // In runAttempts (src/plugins/runner/pipeline.ts) the admission
    // `release()` runs BEFORE `await delay(waitMs)`: a retrying item gives its
    // concurrency slot back for the backoff window and takes it again on the
    // next attempt. On a concurrency-1 lane, a healthy item B dispatches inside
    // item A's backoff instead of waiting for it to elapse.
    const calls: Array<{ marker: string; at: number }> = [];
    let aFailedOnce = false;
    const handler: ExecutableHandler = {
      estimate: () => ({ usd: 0.1 }),
      execute: async request => {
        const marker = markerOf(request);
        calls.push({ marker, at: Date.now() });
        if (marker === "a" && !aFailedOnce) {
          aFailedOnce = true;
          throw Object.assign(new Error("server error"), { status: 500 });
        }
        return {
          body: new TextEncoder().encode(`artifact-${marker}`),
          mimeType: "text/plain",
          costUsd: 0.1
        };
      }
    };

    const framework = buildFramework(tempDir, {
      pluginConfigs: {
        runner: { maxAttempts: 3, retryBaseMs: 300 },
        limits: {
          defaults: { concurrency: 1, rpm: 6000, breakerThreshold: 50, breakerCooldownMs: 30_000 },
          lanes: {}
        }
      },
      extraPlugins: [createFakeProviderPlugin("fixtureLane", "fakeTask", "fake", handler)]
    });
    const app = framework.createApp();
    await app.start();
    stopApp = () => app.stop();

    // Two items on the SAME concurrency-1 lane: A fails once, B is healthy.
    await writeFile(
      path.join(tempDir, "lane.moku.yaml"),
      buildFileYaml("lane", [
        { task: "fakeTask", provider: "fake", input: { text: "a" } },
        { task: "fakeTask", provider: "fake", input: { text: "b" } }
      ])
    );

    // Consume the stream live, so the run's event buffer drains to the end.
    let retries = 0;
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const consuming = (async (): Promise<void> => {
      for await (const event of app.runner.events()) {
        if (event.type === "item:retry") retries += 1;
        if (event.type === "terminal") break;
      }
    })();
    const [result] = await Promise.all([runPromise, consuming]);

    expect(result).toMatchObject({ status: "done", totals: { total: 2, done: 2 } });
    expect(retries).toBe(1);

    // Execution order: A (fails) → B (admitted as soon as A releases, inside
    // A's backoff) → A's second attempt.
    expect(calls.map(call => call.marker)).toEqual(["a", "b", "a"]);

    // Timing: B starts inside A's 150–300ms jittered backoff window
    // (backoffMs: 300 * 2^0 * [0.5,1]), before A's second attempt. Only the
    // order is asserted, no ms margin, so a slow CI event loop cannot flake it.
    const bStart = calls[1];
    const aRetry = calls[2];
    if (!bStart || !aRetry) throw new Error("expected three handler calls");
    expect(bStart.at).toBeLessThan(aRetry.at);
  });

  // ---------------------------------------------------------------------------
  // S17 — abort → clean pause → resume completes without re-billing
  // ---------------------------------------------------------------------------

  it("S17: an abort signal pauses the run cleanly and resume() completes it", async () => {
    const started = createDeferred<void>();
    const gate = createDeferred<void>();
    let callCount = 0;
    const handler: ExecutableHandler = {
      estimate: () => ({ usd: 0.1 }),
      execute: async request => {
        callCount += 1;
        // Item "b" holds its slot in-flight until the test releases the gate.
        if (markerOf(request) === "b") {
          started.resolve(undefined);
          await gate.promise;
        }
        return {
          body: new TextEncoder().encode(`artifact-${markerOf(request)}`),
          mimeType: "text/plain",
          costUsd: 0.1
        };
      }
    };

    const sink = createSink();
    const framework = buildFramework(tempDir, {
      pluginConfigs: {
        // Concurrency 1 serializes the lane so item "c" is still waiting for
        // admission when the abort fires (its acquire cancels; it stays queued).
        limits: {
          defaults: { concurrency: 1, rpm: 6000, breakerThreshold: 5, breakerCooldownMs: 30_000 },
          lanes: {}
        }
      },
      extraPlugins: [
        createFakeProviderPlugin("fixtureGated", "fakeTask", "fake", handler),
        createRunEventListenerPlugin(sink)
      ]
    });
    const app = framework.createApp();
    await app.start();
    stopApp = () => app.stop();

    await writeFile(
      path.join(tempDir, "pause.moku.yaml"),
      buildFileYaml("pause", [
        { task: "fakeTask", provider: "fake", input: { text: "a" } },
        { task: "fakeTask", provider: "fake", input: { text: "b" } },
        { task: "fakeTask", provider: "fake", input: { text: "c" } }
      ])
    );

    // Abort while "b" is in flight; the in-flight item drains to done, the
    // never-admitted "c" stays queued.
    const controller = new AbortController();
    const runPromise = app.runner.run(
      { files: path.join(tempDir, "*.moku.yaml") },
      { signal: controller.signal }
    );
    await started.promise;
    controller.abort();
    gate.resolve(undefined);
    const paused = await runPromise;

    expect(paused.status).toBe("paused");
    expect(paused.totals).toMatchObject({ total: 3, done: 2, queued: 1 });
    expect(sink["run:paused"]).toEqual([{ runId: paused.runId, drained: 2 }]);
    expect(app.probe.journal.getRun(paused.runId)?.status).toBe("paused");
    expect(app.probe.journal.listItems(paused.runId, { status: "queued" })).toHaveLength(1);
    expect(callCount).toBe(2);

    // Resume on the same app: only the remaining queued item executes —
    // already-done items are never re-executed or re-billed.
    const resumed = await app.runner.resume();

    expect(resumed).toMatchObject({ runId: paused.runId, status: "done" });
    expect(resumed.totals).toMatchObject({ total: 3, done: 3, queued: 0 });
    expect(resumed.totals.spendUsd).toBeCloseTo(0.3);
    expect(sink["run:done"]).toEqual([{ runId: paused.runId, totals: resumed.totals }]);
    expect(callCount).toBe(3);
  });
});
