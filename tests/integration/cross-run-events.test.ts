/**
 * @file Batch 3 — cross-plugin run/event integration scenarios (S10–S13).
 *
 * Exercises the buildfile → registry → runner → journal+store pipeline through
 * the REAL framework composition: happy-path bus events (S10), events() stream
 * ordering + payload fidelity (S11), slow-consumer overflow coalescing (S12),
 * and the run:failed terminal path (S13). Per-test tmp-dir journal.db / store
 * dir; no network, no `.moku/` in the repo.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecutableHandler, RunEvent } from "../../src/plugins/runner/types";
import {
  buildFileYaml,
  buildFramework,
  collectStream,
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

describe("cross-plugin run/event integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S10 — full happy run: buildfile → registry → runner → journal+store
  // ---------------------------------------------------------------------------

  it("S10: full happy run emits run:progress + run:done and persists both artifacts", async () => {
    const sink = createSink();
    const body = new TextEncoder().encode("s10-artifact");
    const handler = createFakeHandler({ costUsd: 0.1, body: () => body });
    const app = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler),
        createRunEventListenerPlugin(sink)
      ]
    }).createApp();
    await app.start();

    // One build file, two items with distinct planning keys.
    await writeFile(
      path.join(tempDir, "batch3-s10.moku.yaml"),
      buildFileYaml("s10-happy", [
        { task: "fakeTask", provider: "fake", input: { text: "one" } },
        { task: "fakeTask", provider: "fake", input: { text: "two" } }
      ])
    );

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });

    // Terminal result: both items done, spend accumulated.
    expect(result.status).toBe("done");
    expect(result.totals).toMatchObject({ total: 2, done: 2, failed: 0, flagged: 0 });
    expect(result.totals.spendUsd).toBeCloseTo(0.2, 10);
    expect(handler.attempts()).toBe(2);

    // Bus events: exactly one run:done with matching runId + totals; progress
    // is coalesced (≤1/500ms) so only presence + shape are asserted.
    expect(sink["run:done"]).toHaveLength(1);
    expect(sink["run:done"]?.[0]).toEqual({ runId: result.runId, totals: result.totals });
    expect(sink["run:progress"]?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(sink["run:progress"]?.[0]).toMatchObject({ runId: result.runId, total: 2 });
    expect(sink["run:failed"]).toHaveLength(0);

    // The journal ledger agrees with the returned totals.
    expect(app.probe.journal.totals(result.runId)).toEqual(result.totals);

    // Every done row's artifact is readable from the CAS and equals the handler body.
    const doneRows = app.probe.journal.listItems(result.runId, { status: "done" });
    expect(doneRows).toHaveLength(2);
    for (const row of doneRows) {
      if (row.contentHash === null) {
        throw new Error(`expected contentHash on done item ${row.id}`);
      }
      const stored = await app.probe.store.read(row.contentHash);
      expect(new TextDecoder().decode(stored)).toBe("s10-artifact");
    }

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S11 — events() stream record ordering + payload fidelity
  // ---------------------------------------------------------------------------

  it("S11: events() delivers queued → dispatching → done → terminal with faithful payloads", async () => {
    const body = new TextEncoder().encode("s11-artifact");
    const handler = createFakeHandler({ costUsd: 0.1, body: () => body });
    const app = buildFramework(tempDir, {
      extraPlugins: [createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler)]
    }).createApp();
    await app.start();

    await writeFile(
      path.join(tempDir, "batch3-s11.moku.yaml"),
      buildFileYaml("s11-stream", [{ task: "fakeTask", provider: "fake", input: { text: "solo" } }])
    );

    // Start consuming BEFORE the run promise is awaited.
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const records = await collectStream(app, runPromise);
    const result = await runPromise;

    // Ordering: item:queued → item:dispatching → item:done, terminal last.
    const queuedIndex = records.findIndex(record => record.type === "item:queued");
    const dispatchingIndex = records.findIndex(record => record.type === "item:dispatching");
    const doneIndex = records.findIndex(record => record.type === "item:done");
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchingIndex).toBeGreaterThan(queuedIndex);
    expect(doneIndex).toBeGreaterThan(dispatchingIndex);
    expect(records.at(-1)).toMatchObject({ type: "terminal", status: "done" });

    // item:queued carries the task/provider identity.
    const [queued] = recordsOfType(records, "item:queued");
    expect(queued).toMatchObject({ task: "fakeTask", provider: "fake" });

    // item:done payload fidelity: cost + the same contentHash the journal row
    // and the CAS hash function report.
    const [done] = recordsOfType(records, "item:done");
    if (!done) {
      throw new Error("expected an item:done record");
    }
    expect(done.costUsd).toBe(0.1);
    const [row] = app.probe.journal.listItems(result.runId);
    expect(row?.contentHash).toBe(done.contentHash);
    expect(app.probe.store.hashOf(body)).toBe(done.contentHash);

    // At least one progress record with RunTotals shape appears before terminal.
    const progressIndex = records.findIndex(record => record.type === "progress");
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(progressIndex).toBeLessThan(records.length - 1);
    const [progress] = recordsOfType(records, "progress");
    expect(progress?.totals).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        queued: expect.any(Number),
        dispatching: expect.any(Number),
        done: expect.any(Number),
        failed: expect.any(Number),
        flagged: expect.any(Number),
        spendUsd: expect.any(Number),
        estimatedRemainingUsd: expect.any(Number)
      })
    );

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S12 — events() slow-consumer overflow record
  // ---------------------------------------------------------------------------

  it("S12: a slow consumer gets an overflow marker and still receives the terminal record last", async () => {
    const handler = createFakeHandler({ costUsd: 0.01 });
    const app = buildFramework(tempDir, {
      pluginConfigs: { runner: { eventBufferSize: 2 } },
      extraPlugins: [createFakeProviderPlugin("fakeProviderFixture", "fakeTask", "fake", handler)]
    }).createApp();
    await app.start();

    // Six items → 18 item records against a 2-slot buffer.
    const items = Array.from({ length: 6 }, (_, index) => ({
      task: "fakeTask",
      provider: "fake",
      input: { text: `item-${index}` }
    }));
    await writeFile(
      path.join(tempDir, "batch3-s12.moku.yaml"),
      buildFileYaml("s12-overflow", items)
    );

    // Subscribe while the run is active, but do NOT pull until it resolves.
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const stream = app.runner.events();
    const result = await runPromise;
    expect(result.status).toBe("done");
    expect(result.totals).toMatchObject({ total: 6, done: 6 });

    // Drain the untouched queue after the fact.
    const drained: RunEvent[] = [];
    for await (const event of stream) {
      drained.push(event);
    }

    // Dropped item records were coalesced into overflow marker(s).
    const overflows = recordsOfType(drained, "overflow");
    expect(overflows.length).toBeGreaterThanOrEqual(1);
    for (const overflow of overflows) {
      expect(overflow.dropped).toBeGreaterThanOrEqual(1);
    }

    // The terminal record is still delivered, last, with the run's real status.
    expect(drained.at(-1)).toMatchObject({ type: "terminal", status: "done" });

    await app.stop();
  });

  // ---------------------------------------------------------------------------
  // S13 — run:failed on an unrecoverable pipeline error
  // ---------------------------------------------------------------------------

  it("S13: an unrecoverable planning error resolves failed, emits run:failed, and marks the run failed", async () => {
    const sink = createSink();

    // Verified in src/plugins/runner/pipeline.ts (attemptOnce): store.put
    // failures are caught by the per-attempt try/catch and classified per
    // item, so they never reach failRun (src/plugins/runner/api.ts). The
    // catch-all IS reached when planItems (plan.ts line ~140) calls a
    // REGISTERED handler's estimate() and it throws — used here instead of
    // the plan's store-as-file trigger.
    const explodingHandler: ExecutableHandler = {
      estimate: (): { usd: number } => {
        throw new Error("estimate exploded");
      },
      execute: async () => ({
        body: new TextEncoder().encode("never-produced"),
        mimeType: "text/plain",
        costUsd: 0
      })
    };
    const app = buildFramework(tempDir, {
      extraPlugins: [
        createFakeProviderPlugin("explodingProviderFixture", "fakeTask", "fake", explodingHandler),
        createRunEventListenerPlugin(sink)
      ]
    }).createApp();
    await app.start();

    await writeFile(
      path.join(tempDir, "batch3-s13.moku.yaml"),
      buildFileYaml("s13-failed", [{ task: "fakeTask", provider: "fake", input: { text: "boom" } }])
    );

    // run() resolves (never rejects) with the failed result.
    const runPromise = app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const records = await collectStream(app, runPromise);
    const result = await runPromise;

    expect(result.status).toBe("failed");

    // Bus: one run:failed with the runId and a string error message.
    expect(sink["run:failed"]).toHaveLength(1);
    expect(sink["run:failed"]?.[0]).toMatchObject({
      runId: result.runId,
      error: expect.stringContaining("estimate exploded")
    });
    expect(sink["run:done"]).toHaveLength(0);

    // Stream: the terminal record reports the failed status.
    expect(records.at(-1)).toMatchObject({ type: "terminal", status: "failed" });

    // Journal: the run row is durably marked failed.
    expect(app.probe.journal.getRun(result.runId)?.status).toBe("failed");

    await app.stop();
  });
});
