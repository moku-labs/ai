/**
 * @file Batch 10 — journey: budget ceilings, resume semantics, and status
 * reports (S37–S40).
 *
 * Exercises the runner's spend-bound guarantees through the REAL framework
 * composition: budget-stop terminal path (S37), resume of a budget-stopped
 * run never exceeding the recorded bound (S38), pause → process restart →
 * argument-less resume picking the latest resumable run (S39), and live vs
 * historical `runner.status()` reports (S40). Per-test tmp-dir journal.db /
 * store dir; no network, no `.moku/` in the repo.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../../src/plugins/runner/types";
import {
  buildFileYaml,
  buildFramework,
  collectStream,
  createDeferred,
  createFakeHandler,
  createFakeProviderPlugin,
  createRunEventListenerPlugin
} from "./helpers";

/** Fresh bus-event sink pre-seeded with every runner event key. */
function createSink(): Record<string, unknown[]> {
  return {
    "run:progress": [],
    "run:done": [],
    "run:failed": [],
    "run:budget-stop": [],
    "run:paused": []
  };
}

/** Narrows a stream capture to the records of one discriminant type. */
function recordsOfType<T extends RunEvent["type"]>(
  records: RunEvent[],
  type: T
): Extract<RunEvent, { type: T }>[] {
  return records.filter((record): record is Extract<RunEvent, { type: T }> => record.type === type);
}

/** Writes a five-item build file (task `fakeTask`, provider `fake`) into `dir`. */
async function writeFiveItemBuildFile(dir: string, name: string): Promise<string> {
  const items = ["one", "two", "three", "four", "five"].map(text => ({
    task: "fakeTask",
    provider: "fake",
    input: { text }
  }));
  const filePath = path.join(dir, `${name}.moku.yaml`);
  await writeFile(filePath, buildFileYaml(name, items));
  return filePath;
}

describe("journey: budget ceilings, resume, and status reports", () => {
  let tempDir: string;
  let stopApps: Array<() => Promise<void>>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
    stopApps = [];
  });

  afterEach(async () => {
    for (const stop of stopApps.toReversed()) {
      await stop();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S37 — budget ceiling → run:budget-stop → status "budget-stopped"
  // ---------------------------------------------------------------------------

  it("S37: hitting the budget ceiling emits run:budget-stop and ends the run budget-stopped", async () => {
    const sink = createSink();
    const handler = createFakeHandler({ costUsd: 0.1 });
    const app = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler),
        createRunEventListenerPlugin(sink)
      ]
    }).createApp();
    await app.start();
    stopApps.push(() => app.stop());

    await writeFiveItemBuildFile(tempDir, "s37-budget");

    // Cap admits exactly two 0.1-estimate items (third projects 0.3 > 0.25).
    const runPromise = app.runner.run({
      files: path.join(tempDir, "*.moku.yaml"),
      maxCostUsd: 0.25
    });
    const records = await collectStream(app, runPromise);
    const result = await runPromise;

    // Terminal result: budget-stopped with spend under the cap.
    expect(result.status).toBe("budget-stopped");
    expect(result.totals.done).toBe(2);
    expect(result.totals.spendUsd).toBeLessThanOrEqual(0.25);

    // Bus event: exactly one run:budget-stop carrying the cap and the spend.
    expect(sink["run:budget-stop"]).toHaveLength(1);
    expect(sink["run:budget-stop"]?.[0]).toEqual({
      runId: result.runId,
      spendUsd: result.totals.spendUsd,
      maxCostUsd: 0.25
    });
    const budgetStopPayload = sink["run:budget-stop"]?.[0] as { spendUsd: number };
    expect(budgetStopPayload.spendUsd).toBeLessThanOrEqual(0.25);
    expect(sink["run:done"]).toHaveLength(0);
    expect(sink["run:failed"]).toHaveLength(0);

    // Journal ledger: done spend within the cap, the other three items still queued.
    const doneRows = app.probe.journal.listItems(result.runId, { status: "done" });
    const doneSpend = doneRows.reduce((sum, row) => sum + (row.actualCostUsd ?? 0), 0);
    expect(doneSpend).toBeLessThanOrEqual(0.25);
    expect(app.probe.journal.listItems(result.runId, { status: "queued" })).toHaveLength(3);

    // Stream: the terminal record reports budget-stopped.
    const terminals = recordsOfType(records, "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.status).toBe("budget-stopped");
  });

  // ---------------------------------------------------------------------------
  // S38 — resume of a budget-stopped run never exceeds the recorded bound
  // ---------------------------------------------------------------------------

  it("S38: resuming a budget-stopped run budget-stops again without exceeding the bound", async () => {
    const handler = createFakeHandler({ costUsd: 0.1 });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler)]
    }).createApp();
    await app.start();
    stopApps.push(() => app.stop());

    await writeFiveItemBuildFile(tempDir, "s38-budget");

    // First run stops at the cap: two items done, three left queued.
    const first = await app.runner.run({
      files: path.join(tempDir, "*.moku.yaml"),
      maxCostUsd: 0.25
    });
    expect(first.status).toBe("budget-stopped");
    const attemptsAfterFirst = handler.attempts();
    expect(attemptsAfterFirst).toBe(2);

    // Resume by id: the done spend already saturates the cap, so the very
    // first gate projects over budget and the run budget-stops again
    // (pinned ratified behavior — no new item is ever admitted).
    const resumed = await app.runner.resume({ runId: first.runId });
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe("budget-stopped");

    // The recorded bound holds ALWAYS: totals spend never exceeds the cap.
    expect(app.probe.journal.totals(first.runId).spendUsd).toBeLessThanOrEqual(0.25);
    expect(resumed.totals.spendUsd).toBeLessThanOrEqual(0.25);
    expect(resumed.totals.done).toBe(2);

    // No done item was re-executed: the handler's attempt counter is unchanged.
    expect(handler.attempts()).toBe(attemptsAfterFirst);
  });

  // ---------------------------------------------------------------------------
  // S39 — pause → process restart → resume() auto-picks the latest resumable run
  // ---------------------------------------------------------------------------

  it("S39: after a pause and app restart, argument-less resume() completes the paused run", async () => {
    // Lane concurrency 1 serializes the three items so an abort mid-item-1
    // leaves the remaining items queued (not merely draining in-flight).
    const started = createDeferred<void>();
    const gate = createDeferred<void>();
    const handler1 = createFakeHandler({
      costUsd: 0.5,
      executeGate: gate.promise,
      onExecuteStart: () => {
        started.resolve();
      }
    });
    const app1 = buildFramework(tempDir, {
      pluginConfigs: { limits: { lanes: { "fakeTask/fake/default": { concurrency: 1 } } } },
      extraPlugins: [createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler1)]
    }).createApp();
    await app1.start();

    await writeFile(
      path.join(tempDir, "s39-pause.moku.yaml"),
      buildFileYaml("s39-pause", [
        { task: "fakeTask", provider: "fake", input: { text: "one" } },
        { task: "fakeTask", provider: "fake", input: { text: "two" } },
        { task: "fakeTask", provider: "fake", input: { text: "three" } }
      ])
    );

    // Abort while item 1 is in-flight, then release it so the run drains.
    const controller = new AbortController();
    const runPromise = app1.runner.run(
      { files: path.join(tempDir, "*.moku.yaml") },
      { signal: controller.signal }
    );
    await started.promise;
    controller.abort();
    gate.resolve();
    const paused = await runPromise;

    // Clean pause: the in-flight item drained to done, the rest stayed queued.
    expect(paused.status).toBe("paused");
    expect(paused.totals.done).toBe(1);
    expect(paused.totals.queued).toBe(2);
    expect(handler1.attempts()).toBe(1);

    // "Process restart": stop app1, build a SECOND framework on the same
    // journal.db + store dir with a fresh, ungated fake handler.
    await app1.stop();
    const handler2 = createFakeHandler({ costUsd: 0.5 });
    const app2 = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler2)]
    }).createApp();
    await app2.start();
    stopApps.push(() => app2.stop());

    // Argument-less resume picks the paused run (latestResumableRun semantics).
    const resumed = await app2.runner.resume();
    expect(resumed.runId).toBe(paused.runId);
    expect(resumed.status).toBe("done");
    expect(resumed.totals.done).toBe(3);

    // Spend is exactly 3 × cost: the pre-pause item was never re-charged.
    expect(resumed.totals.spendUsd).toBe(1.5);
    expect(handler2.attempts()).toBeLessThan(3);
    expect(handler2.attempts()).toBe(2);
    expect(handler1.attempts()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // S40 — runner.status() report: live, historical, and unknown-id behavior
  // ---------------------------------------------------------------------------

  it("S40: status() reports a live dispatching run, historical done totals, and throws on unknown ids", async () => {
    const started = createDeferred<void>();
    const gate = createDeferred<void>();
    const handler = createFakeHandler({
      costUsd: 0.1,
      executeGate: gate.promise,
      onExecuteStart: () => {
        started.resolve();
      }
    });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler)]
    }).createApp();
    await app.start();
    stopApps.push(() => app.stop());

    await writeFile(
      path.join(tempDir, "s40-status.moku.yaml"),
      buildFileYaml("s40-status", [{ task: "fakeTask", provider: "fake", input: { text: "solo" } }])
    );

    // Live report while the single item is held in-flight by the gate.
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    await started.promise;
    const live = app.runner.status();
    expect(live.status).toBe("active");
    expect(live.totals.dispatching).toBeGreaterThanOrEqual(1);
    expect(live.totals.done).toBe(0);

    // Release the gate and let the run finish.
    gate.resolve();
    const result = await runPromise;
    expect(result.status).toBe("done");
    expect(live.runId).toBe(result.runId);

    // Historical report by id after completion.
    const historical = app.runner.status(result.runId);
    expect(historical.runId).toBe(result.runId);
    expect(historical.status).toBe("done");
    expect(historical.totals).toEqual(result.totals);
    expect(historical.totals.done).toBe(1);

    // Pinned contract: with the run done there is no active/resumable run to
    // infer, so an argument-less status() throws; an unknown id also throws.
    expect(() => app.runner.status()).toThrow(/No run to report status for/);
    expect(() => app.runner.status("no-such-run")).toThrow(/Run not found: no-such-run/);
  });
});
