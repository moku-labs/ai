import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteDriver } from "../../driver/select";
import type { SqliteDriver } from "../../driver/types";
import { createSchema } from "../../schema";

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
