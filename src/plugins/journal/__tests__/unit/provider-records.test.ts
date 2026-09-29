import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createJournalApi } from "../../api";
import { openSqliteDriver } from "../../driver/select";
import type { SqliteDriver } from "../../driver/types";
import { createSchema } from "../../schema";
import type { Config, JournalApi, ProviderRecord, State } from "../../types";

const NOT_OPEN = "[ai] Journal is not open.\n  Call app.start() before using the journal.";

/** A provider record for the `apimodels` asset kind, keyed by `key`. */
function record(
  key: string,
  value: string,
  overrides: Partial<ProviderRecord> = {}
): ProviderRecord {
  return {
    provider: "apimodels",
    account: "3f9a0c1b2d4e",
    kind: "asset",
    key,
    value,
    ...overrides
  };
}

/** The identity of the `record(key, …)` fixture. */
function identity(key: string, overrides: Partial<Omit<ProviderRecord, "value">> = {}) {
  return { provider: "apimodels", account: "3f9a0c1b2d4e", kind: "asset", key, ...overrides };
}

/** A journal API over a state whose driver was never opened. */
function closedApi(config: Config): JournalApi {
  return createJournalApi({
    config,
    // eslint-disable-next-line unicorn/no-null -- State fields are typed `X | null` (not opened yet)
    state: { driver: null, checkpointTimer: null }
  });
}

describe("journal provider records", () => {
  let dir: string;
  let driver: SqliteDriver;
  let config: Config;
  let state: State;
  let api: JournalApi;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "journal-provider-records-"));
    config = {
      path: path.join(dir, "journal.db"),
      checkpointIntervalMs: 30_000,
      busyTimeoutMs: 5000
    };
    driver = openSqliteDriver({ path: config.path, busyTimeoutMs: config.busyTimeoutMs });
    createSchema(driver);
    // eslint-disable-next-line unicorn/no-null -- State.checkpointTimer is typed `... | null` (not running yet)
    state = { driver, checkpointTimer: null };
    api = createJournalApi({ config, state });
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("not-open guard", () => {
    it("findProviderRecord throws the documented error", () => {
      expect(() => closedApi(config).findProviderRecord(identity("k-1"))).toThrow(NOT_OPEN);
    });

    it("putProviderRecords throws the documented error, even for an empty batch", () => {
      expect(() =>
        closedApi(config).putProviderRecords([record("k-1", "asset://asset-1")])
      ).toThrow(NOT_OPEN);
      expect(() => closedApi(config).putProviderRecords([])).toThrow(NOT_OPEN);
    });

    it("deleteProviderRecord throws the documented error", () => {
      expect(() => closedApi(config).deleteProviderRecord(identity("k-1"))).toThrow(NOT_OPEN);
    });
  });

  describe("put / find", () => {
    it("round-trips a record", () => {
      api.putProviderRecords([record("k-1", "asset://asset-1")]);

      expect(api.findProviderRecord(identity("k-1"))).toBe("asset://asset-1");
    });

    it("returns undefined for an unknown record", () => {
      expect(api.findProviderRecord(identity("never-stored"))).toBeUndefined();
    });

    it("keys by provider, account, kind and key together", () => {
      api.putProviderRecords([record("k-1", "asset://asset-1")]);

      expect(api.findProviderRecord(identity("k-1", { provider: "fal" }))).toBeUndefined();
      expect(api.findProviderRecord(identity("k-1", { account: "other" }))).toBeUndefined();
      expect(api.findProviderRecord(identity("k-1", { kind: "asset-group" }))).toBeUndefined();
      expect(api.findProviderRecord(identity("k-2"))).toBeUndefined();
    });

    it("stores several records of one batch", () => {
      api.putProviderRecords([
        record("anna", "asset://asset-1"),
        record("ben", "asset://asset-2"),
        record("moku-ai", "group-7", { kind: "asset-group" })
      ]);

      expect(api.findProviderRecord(identity("anna"))).toBe("asset://asset-1");
      expect(api.findProviderRecord(identity("ben"))).toBe("asset://asset-2");
      expect(api.findProviderRecord(identity("moku-ai", { kind: "asset-group" }))).toBe("group-7");
    });

    it("upserts: a second put with the same identity replaces value and created_at", () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      api.putProviderRecords([record("k-1", "asset://old")]);
      clock.mockReturnValue(2000);
      api.putProviderRecords([record("k-1", "asset://new")]);
      clock.mockRestore();

      expect(api.findProviderRecord(identity("k-1"))).toBe("asset://new");
      expect(
        driver.all<{ value: string; created_at: number }>(
          "SELECT value, created_at FROM provider_records"
        )
      ).toEqual([{ value: "asset://new", created_at: 2000 }]);
    });

    it("writes a batch in one BEGIN IMMEDIATE transaction", () => {
      const transaction = vi.spyOn(driver, "transactionImmediate");

      api.putProviderRecords([
        record("a", "asset://a"),
        record("b", "asset://b"),
        record("c", "c")
      ]);

      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it("treats an empty batch as a no-op: no transaction, no row", () => {
      const transaction = vi.spyOn(driver, "transactionImmediate");

      expect(() => api.putProviderRecords([])).not.toThrow();

      expect(transaction).not.toHaveBeenCalled();
      expect(
        driver.get<{ total: number }>("SELECT COUNT(*) AS total FROM provider_records")
      ).toEqual({ total: 0 });
    });

    it("rolls back the whole batch when one row fails", () => {
      api.putProviderRecords([record("anna", "asset://old")]);
      driver.exec(`
        CREATE TRIGGER reject_bad_key BEFORE INSERT ON provider_records
        WHEN NEW.key = 'bad' BEGIN SELECT RAISE(ABORT, 'bad provider record'); END;
      `);

      expect(() =>
        api.putProviderRecords([
          record("anna", "asset://new"),
          record("ben", "asset://asset-2"),
          record("bad", "asset://asset-3"),
          record("cleo", "asset://asset-4")
        ])
      ).toThrow("bad provider record");

      expect(api.findProviderRecord(identity("anna"))).toBe("asset://old");
      expect(api.findProviderRecord(identity("ben"))).toBeUndefined();
      expect(api.findProviderRecord(identity("cleo"))).toBeUndefined();
    });
  });

  describe("deleteProviderRecord", () => {
    it("deletes a record so find returns undefined", () => {
      api.putProviderRecords([record("k-1", "asset://asset-1"), record("k-2", "asset://asset-2")]);

      api.deleteProviderRecord(identity("k-1"));

      expect(api.findProviderRecord(identity("k-1"))).toBeUndefined();
      expect(api.findProviderRecord(identity("k-2"))).toBe("asset://asset-2");
    });

    it("is a no-op for a missing record", () => {
      expect(() => api.deleteProviderRecord(identity("never-stored"))).not.toThrow();
    });

    it("writes inside a BEGIN IMMEDIATE transaction", () => {
      const transaction = vi.spyOn(driver, "transactionImmediate");

      api.deleteProviderRecord(identity("k-1"));

      expect(transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("types", () => {
    it("types the four members as the spec declares them", () => {
      expectTypeOf(api.isOpen).returns.toEqualTypeOf<boolean>();
      expectTypeOf(api.findProviderRecord).returns.toEqualTypeOf<string | undefined>();
      expectTypeOf(api.putProviderRecords).parameter(0).toEqualTypeOf<ProviderRecord[]>();
      expectTypeOf(api.deleteProviderRecord).returns.toEqualTypeOf<void>();
    });
  });
});
