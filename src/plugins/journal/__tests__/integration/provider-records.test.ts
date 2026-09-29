import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { openSqliteDriver } from "../../driver/select";
import type { ProviderRecord } from "../../types";

const ANNA = { provider: "apimodels", account: "3f9a0c1b2d4e", kind: "asset", key: "anna-hash" };
const BEN = { provider: "apimodels", account: "3f9a0c1b2d4e", kind: "asset", key: "ben-hash" };

/** Builds a fresh app whose probe plugin reaches the provider-record API through `ctx.journal`. */
function buildProbeApp(dbPath: string) {
  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({
      isOpen: () => ctx.journal.isOpen(),
      findRecord: (q: Omit<ProviderRecord, "value">) => ctx.journal.findProviderRecord(q),
      putRecords: (records: ProviderRecord[]) => {
        ctx.journal.putProviderRecords(records);
      },
      deleteRecord: (q: Omit<ProviderRecord, "value">) => {
        ctx.journal.deleteProviderRecord(q);
      }
    })
  });

  const { createApp } = createCore(coreConfig, {
    plugins: [probePlugin],
    pluginConfigs: { journal: { path: dbPath } }
  });

  return createApp();
}

describe("journal provider records integration", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "journal-provider-records-it-"));
    dbPath = path.join(dir, "journal.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("isOpen is false before start, true between start and stop, false after stop", async () => {
    const app = buildProbeApp(dbPath);

    expect(app.probe.isOpen()).toBe(false);
    await app.start();
    expect(app.probe.isOpen()).toBe(true);
    await app.stop();
    expect(app.probe.isOpen()).toBe(false);
  });

  it("throws the not-open error from find, put and delete before start", () => {
    const app = buildProbeApp(dbPath);
    const notOpen = "[ai] Journal is not open.\n  Call app.start() before using the journal.";

    expect(() => app.probe.findRecord(ANNA)).toThrow(notOpen);
    expect(() => app.probe.putRecords([{ ...ANNA, value: "asset://asset-1" }])).toThrow(notOpen);
    expect(() => app.probe.deleteRecord(ANNA)).toThrow(notOpen);
  });

  it("puts, finds and deletes records through ctx.journal", async () => {
    const app = buildProbeApp(dbPath);
    await app.start();

    app.probe.putRecords([
      { ...ANNA, value: "asset://asset-1" },
      { ...BEN, value: "asset://asset-2" }
    ]);
    expect(app.probe.findRecord(ANNA)).toBe("asset://asset-1");
    expect(app.probe.findRecord(BEN)).toBe("asset://asset-2");

    app.probe.deleteRecord(ANNA);
    expect(app.probe.findRecord(ANNA)).toBeUndefined();
    expect(app.probe.findRecord(BEN)).toBe("asset://asset-2");

    await app.stop();
  });

  it("keeps records across close and reopen", async () => {
    const first = buildProbeApp(dbPath);
    await first.start();
    first.probe.putRecords([{ ...ANNA, value: "asset://asset-1" }]);
    await first.stop();

    const second = buildProbeApp(dbPath);
    await second.start();
    expect(second.probe.findRecord(ANNA)).toBe("asset://asset-1");
    await second.stop();
  });

  it("adds the provider_records table to an older journal file on start", async () => {
    const legacy = openSqliteDriver({ path: dbPath, busyTimeoutMs: 5000 });
    legacy.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        glob TEXT NOT NULL, max_cost_usd REAL, finished_at INTEGER);
      INSERT INTO runs VALUES ('run-old', 1, 'done', 'voice/*.yaml', NULL, 2);
    `);
    const before = legacy.get<{ total: number }>(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'provider_records'"
    );
    legacy.close();
    expect(before).toEqual({ total: 0 });

    const app = buildProbeApp(dbPath);
    await app.start();
    app.probe.putRecords([{ ...ANNA, value: "asset://asset-1" }]);
    expect(app.probe.findRecord(ANNA)).toBe("asset://asset-1");
    await app.stop();

    const reopened = openSqliteDriver({ path: dbPath, busyTimeoutMs: 5000 });
    try {
      expect(reopened.get<{ id: string }>("SELECT id FROM runs")).toEqual({ id: "run-old" });
      expect(reopened.get<{ value: string }>("SELECT value FROM provider_records")).toEqual({
        value: "asset://asset-1"
      });
    } finally {
      reopened.close();
    }
  });
});
