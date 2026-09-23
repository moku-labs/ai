import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { openSqliteDriver } from "../../driver/select";
import type { GateResult, ItemIntent } from "../../types";

function intent(planningKey: string, overrides: Partial<ItemIntent> = {}): ItemIntent {
  return {
    planningKey,
    buildFile: "voice.build.yaml",
    task: "voiceover",
    provider: "elevenlabs",
    // eslint-disable-next-line unicorn/no-null -- ItemIntent.packVersion is typed `string | null`, matching the nullable SQL column
    packVersion: null,
    estimatedCostUsd: 0.1,
    label: planningKey,
    buildName: "voice",
    artifactKey: `ak-${planningKey}`,
    ...overrides
  };
}

/** Builds a fresh probe plugin + app pointed at a journal db under `dbPath`. */
function buildProbeApp(dbPath: string) {
  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({
      openRun: (glob: string, maxCostUsd?: number) =>
        maxCostUsd === undefined
          ? ctx.journal.openRun({ glob })
          : ctx.journal.openRun({ glob, maxCostUsd }),
      insertItems: (runId: string, items: ItemIntent[]) => ctx.journal.insertItems(runId, items),
      gateToDispatching: (itemId: string): GateResult => ctx.journal.gateToDispatching(itemId),
      totals: (runId: string) => ctx.journal.totals(runId),
      readSnapshot: (runId: string) => ctx.journal.readSnapshot(runId)
    })
  });

  const { createApp } = createCore(coreConfig, {
    plugins: [probePlugin],
    pluginConfigs: { journal: { path: dbPath } }
  });

  return createApp();
}

describe("journal plugin integration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "journal-integration-"));
    dbPath = path.join(dir, "journal.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens the journal on start and exposes ctx.journal on a probe plugin", async () => {
    const app = buildProbeApp(dbPath);

    await app.start();
    const run = app.probe.openRun("voice/*.yaml");
    expect(app.probe.totals(run.id)).toEqual({
      total: 0,
      queued: 0,
      dispatching: 0,
      done: 0,
      failed: 0,
      flagged: 0,
      spendUsd: 0,
      estimatedRemainingUsd: 0
    });
    await app.stop();
  });

  it("admits exactly one of two items dispatched near a tight budget cap", async () => {
    const app = buildProbeApp(dbPath);
    await app.start();

    const run = app.probe.openRun("voice/*.yaml", 1);
    const [a, b] = app.probe.insertItems(run.id, [
      intent("pk-1", { estimatedCostUsd: 0.6 }),
      intent("pk-2", { estimatedCostUsd: 0.6 })
    ]);
    if (!a || !b) {
      throw new Error("expected both items to be inserted");
    }

    const [resultA, resultB] = await Promise.all([
      Promise.resolve(app.probe.gateToDispatching(a.id)),
      Promise.resolve(app.probe.gateToDispatching(b.id))
    ]);

    const admitted = [resultA, resultB].filter(r => r.ok);
    const blocked = [resultA, resultB].filter(r => !r.ok);
    expect(admitted).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual({ ok: false, reason: "budget" });

    await app.stop();
  });

  it("applies the durability pragma set (WAL, synchronous=FULL, fullfsync=1)", async () => {
    const app = buildProbeApp(dbPath);
    await app.start();
    app.probe.openRun("voice/*.yaml");

    const secondConnection = openSqliteDriver({ path: dbPath, busyTimeoutMs: 5000 });
    try {
      const journalMode = secondConnection.get<{ journal_mode: string }>("PRAGMA journal_mode");
      const synchronous = secondConnection.get<{ synchronous: number }>("PRAGMA synchronous");
      const fullfsync = secondConnection.get<{ fullfsync: number }>("PRAGMA fullfsync");

      expect(journalMode?.journal_mode).toBe("wal");
      expect(synchronous?.synchronous).toBe(2);
      if (process.platform === "darwin") {
        expect(fullfsync?.fullfsync).toBe(1);
      } else {
        expect(typeof fullfsync?.fullfsync).toBe("number");
      }
    } finally {
      secondConnection.close();
    }

    await app.stop();
  });

  it("lets a second read-only connection see rows committed by the app", async () => {
    const app = buildProbeApp(dbPath);
    await app.start();

    const run = app.probe.openRun("voice/*.yaml");
    app.probe.insertItems(run.id, [intent("pk-1")]);

    const secondConnection = openSqliteDriver({ path: dbPath, busyTimeoutMs: 5000 });
    try {
      const runRow = secondConnection.get<{ id: string }>("SELECT id FROM runs WHERE id = ?", [
        run.id
      ]);
      const itemCount = secondConnection.get<{ total: number }>(
        "SELECT COUNT(*) AS total FROM items WHERE run_id = ?",
        [run.id]
      );

      expect(runRow?.id).toBe(run.id);
      expect(itemCount?.total).toBe(1);
    } finally {
      secondConnection.close();
    }

    await app.stop();
  });

  it("readSnapshot opens its own short-lived connection and reads committed state", async () => {
    const app = buildProbeApp(dbPath);
    await app.start();

    const run = app.probe.openRun("voice/*.yaml");
    app.probe.insertItems(run.id, [intent("pk-1")]);

    const snapshot = app.probe.readSnapshot(run.id);

    expect(snapshot.run.id).toBe(run.id);
    expect(snapshot.totals.total).toBe(1);
    expect(snapshot.recentItems).toHaveLength(1);

    await app.stop();
  });

  it("closes the driver connection on stop, allowing a fresh open afterward", async () => {
    const app = buildProbeApp(dbPath);
    await app.start();
    app.probe.openRun("voice/*.yaml");
    await app.stop();

    const reopened = openSqliteDriver({ path: dbPath, busyTimeoutMs: 5000 });
    try {
      const journalMode = reopened.get<{ journal_mode: string }>("PRAGMA journal_mode");
      expect(journalMode?.journal_mode).toBe("wal");
    } finally {
      reopened.close();
    }
  });
});
