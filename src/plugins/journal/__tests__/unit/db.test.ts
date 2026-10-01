import { describe, expect, it, vi } from "vitest";
import { isOpen, mapItem, mapRun, NOT_OPEN_ERROR, requireDriver, SQL_NULL } from "../../db";
import type { ItemDatabaseRow, RunDatabaseRow, SqliteDriver } from "../../driver/types";
import type { State } from "../../types";
import { closedState } from "./fixtures";

/**
 * A raw `items` row of a done single-artifact item, with overrides.
 *
 * @param overrides - Columns to replace.
 * @returns The raw row.
 */
function itemRow(overrides: Partial<ItemDatabaseRow> = {}): ItemDatabaseRow {
  return {
    id: "item-1",
    run_id: "run-1",
    build_file: "keys.build.yaml",
    planning_key: "pk-1",
    task: "image",
    provider: "ark",
    pack_version: SQL_NULL,
    artifact_key: "ak-1",
    content_hash: "ch-1",
    status: "done",
    estimated_cost_usd: 0.105,
    actual_cost_usd: 0.07,
    attempt_count: 0,
    updated_at: 1000,
    label: "key",
    build_name: "keys",
    mime_type: "image/jpeg",
    outputs: SQL_NULL,
    ...overrides
  };
}

describe("journal db", () => {
  describe("isOpen", () => {
    it("is true while the driver is open", () => {
      const state = { ...closedState(), driver: {} as SqliteDriver };

      expect(isOpen(state)).toBe(true);
    });

    it("is false without a driver, and does not throw", () => {
      const state = closedState();

      expect(() => isOpen(state)).not.toThrow();
      expect(isOpen(state)).toBe(false);
    });

    it("follows the state: false once the driver is cleared", () => {
      const state: State = { ...closedState(), driver: {} as SqliteDriver };
      expect(isOpen(state)).toBe(true);

      // eslint-disable-next-line unicorn/no-null -- closeDriver sets State.driver back to null
      state.driver = null;

      expect(isOpen(state)).toBe(false);
    });
  });

  describe("requireDriver", () => {
    it("throws the documented not-open error when the driver is null", () => {
      expect(() => requireDriver(closedState())).toThrow(
        "[ai] Journal is not open.\n  Call app.start() before using the journal."
      );
      expect(NOT_OPEN_ERROR).toBe(
        "[ai] Journal is not open.\n  Call app.start() before using the journal."
      );
    });

    it("returns the open driver", () => {
      const driver: SqliteDriver = {
        exec: vi.fn(),
        run: vi.fn(() => ({ changes: 0 })),
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
        transactionImmediate: vi.fn(fn => fn()),
        close: vi.fn()
      };

      expect(requireDriver({ ...closedState(), driver })).toBe(driver);
    });
  });

  describe("SQL_NULL", () => {
    it("is the literal null bind value", () => {
      expect(SQL_NULL).toBeNull();
    });
  });

  describe("mapItem", () => {
    it("maps every snake_case column to its camelCase field", () => {
      const row: ItemDatabaseRow = {
        id: "item-1",
        run_id: "run-1",
        build_file: "voice.build.yaml",
        planning_key: "pk-1",
        task: "voiceover",
        provider: "elevenlabs",
        pack_version: "v1",
        artifact_key: "ak-1",
        content_hash: "ch-1",
        status: "done",
        estimated_cost_usd: 0.1,
        actual_cost_usd: 0.2,
        attempt_count: 3,
        updated_at: 1000,
        label: "Line 1",
        build_name: "voice",
        mime_type: "audio/mpeg",
        outputs: SQL_NULL
      };

      expect(mapItem(row)).toEqual({
        id: "item-1",
        runId: "run-1",
        buildFile: "voice.build.yaml",
        planningKey: "pk-1",
        task: "voiceover",
        provider: "elevenlabs",
        packVersion: "v1",
        artifactKey: "ak-1",
        contentHash: "ch-1",
        status: "done",
        estimatedCostUsd: 0.1,
        actualCostUsd: 0.2,
        attemptCount: 3,
        updatedAt: 1000,
        label: "Line 1",
        buildName: "voice",
        mimeType: "audio/mpeg",
        outputs: SQL_NULL
      });
    });

    it("parses outputs, in order", () => {
      const outputs = [
        { contentHash: "ch-1", mimeType: "image/jpeg" },
        { contentHash: "ch-2", mimeType: "image/png" }
      ];

      expect(mapItem(itemRow({ outputs: JSON.stringify(outputs) })).outputs).toEqual(outputs);
    });

    it.each<[string, string | null | undefined]>([
      ["NULL", SQL_NULL],
      ["missing (an un-migrated file)", undefined],
      ["not JSON", "[{"],
      ["not an array", '{"contentHash":"ch-1","mimeType":"image/png"}'],
      ["an empty array", "[]"],
      ["an entry without a string hash", '[{"contentHash":1,"mimeType":"image/png"}]'],
      ["an entry without a mime type", '[{"contentHash":"ch-1"}]'],
      ["an entry that is not an object", '["ch-1"]']
    ])("maps outputs %s to null, so the row stays a single artifact", (_name, outputs) => {
      const row = { ...itemRow(), outputs } as ItemDatabaseRow;

      expect(mapItem(row).outputs).toBeNull();
    });
  });

  describe("mapRun", () => {
    it("maps every snake_case column to its camelCase field", () => {
      const row: RunDatabaseRow = {
        id: "run-1",
        created_at: 1000,
        status: "done",
        glob: "voice/*.yaml",
        max_cost_usd: 5,
        finished_at: 2000
      };

      expect(mapRun(row)).toEqual({
        id: "run-1",
        createdAt: 1000,
        status: "done",
        glob: "voice/*.yaml",
        maxCostUsd: 5,
        finishedAt: 2000
      });
    });
  });
});
