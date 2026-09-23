import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteDriver } from "../../driver/select";
import type { SqliteDriver } from "../../driver/types";
import { createSchema, migrateSchema } from "../../schema";

describe("createSchema", () => {
  let dir: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "journal-schema-"));
    driver = openSqliteDriver({ path: path.join(dir, "journal.db"), busyTimeoutMs: 5000 });
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the runs, items, and attempts tables", () => {
    createSchema(driver);

    const tables = driver
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map(row => row.name);

    expect(tables).toEqual(expect.arrayContaining(["runs", "items", "attempts"]));
  });

  it("is idempotent — calling it twice does not throw", () => {
    createSchema(driver);

    expect(() => createSchema(driver)).not.toThrow();
  });

  it("enforces the (run_id, planning_key) uniqueness constraint on items", () => {
    createSchema(driver);
    driver.run(
      "INSERT INTO runs (id, created_at, status, glob, max_cost_usd, finished_at) VALUES ('r1', 0, 'active', '*.yaml', NULL, NULL)"
    );
    driver.run(
      `INSERT INTO items (id, run_id, build_file, planning_key, task, provider, status, estimated_cost_usd, attempt_count, updated_at)
       VALUES ('i1', 'r1', 'a.yaml', 'pk-1', 'voiceover', 'elevenlabs', 'queued', 0.1, 0, 0)`
    );

    expect(() =>
      driver.run(
        `INSERT INTO items (id, run_id, build_file, planning_key, task, provider, status, estimated_cost_usd, attempt_count, updated_at)
         VALUES ('i2', 'r1', 'b.yaml', 'pk-1', 'voiceover', 'elevenlabs', 'queued', 0.1, 0, 0)`
      )
    ).toThrow();
  });
});

describe("migrateSchema", () => {
  let dir: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "journal-migrate-"));
    driver = openSqliteDriver({ path: path.join(dir, "journal.db"), busyTimeoutMs: 5000 });
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Column names of a table.
   *
   * @param table - Table name.
   * @returns The column names.
   * @example
   * ```ts
   * columnsOf("items");
   * ```
   */
  function columnsOf(table: string): string[] {
    return driver.all<{ name: string }>(`PRAGMA table_info(${table})`).map(row => row.name);
  }

  it("adds label, build_name, mime_type, external_id and job_state to a journal from before them", () => {
    driver.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, build_file TEXT NOT NULL,
        planning_key TEXT NOT NULL, task TEXT NOT NULL, provider TEXT NOT NULL, pack_version TEXT,
        artifact_key TEXT, content_hash TEXT, status TEXT NOT NULL, estimated_cost_usd REAL NOT NULL,
        actual_cost_usd REAL, attempt_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL,
        provider TEXT NOT NULL, account TEXT NOT NULL DEFAULT 'default', started_at INTEGER NOT NULL,
        ended_at INTEGER, outcome TEXT, error_class TEXT, cost_usd REAL);
    `);

    createSchema(driver);
    migrateSchema(driver);

    expect(columnsOf("items")).toEqual(
      expect.arrayContaining(["label", "build_name", "mime_type"])
    );
    expect(columnsOf("attempts")).toEqual(expect.arrayContaining(["external_id", "job_state"]));
  });
});
