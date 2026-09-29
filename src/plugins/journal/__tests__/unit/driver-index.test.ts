import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { closeDriver, openDriver } from "../../driver";
import type { SqliteDriver } from "../../driver/types";
import type { Config, State } from "../../types";
import { closedState, mustExist } from "./fixtures";

const CHECKPOINT = "PRAGMA wal_checkpoint(TRUNCATE)";

describe("journal driver lifecycle", () => {
  let dir: string;
  let config: Config;
  let state: State;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(tmpdir(), "journal-driver-"));
    config = {
      path: path.join(dir, "nested", "journal.db"),
      checkpointIntervalMs: 1000,
      busyTimeoutMs: 5000
    };
    state = closedState();
  });

  afterEach(() => {
    closeDriver({ config, state });
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Opens the driver, then spies on the open connection's exec. */
  function openAndSpy(): { driver: SqliteDriver; exec: MockInstance<SqliteDriver["exec"]> } {
    openDriver({ config, state });
    const driver = mustExist(state.driver ?? undefined);
    return { driver, exec: vi.spyOn(driver, "exec") };
  }

  describe("openDriver", () => {
    it("creates the parent directory and the schema", () => {
      const { driver } = openAndSpy();

      expect(existsSync(path.dirname(config.path))).toBe(true);
      const tables = driver
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining(["attempts", "items", "runs"]));
    });

    it("runs wal_checkpoint(TRUNCATE) every checkpointIntervalMs", () => {
      const { exec } = openAndSpy();

      vi.advanceTimersByTime(config.checkpointIntervalMs - 1);
      expect(exec).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(CHECKPOINT);

      vi.advanceTimersByTime(config.checkpointIntervalMs);
      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  describe("closeDriver", () => {
    it("clears the timer, runs one final checkpoint, closes and nulls the driver", () => {
      const { driver, exec } = openAndSpy();
      const close = vi.spyOn(driver, "close");

      closeDriver({ config, state });

      expect(state.checkpointTimer).toBeNull();
      expect(state.driver).toBeNull();
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(CHECKPOINT);
      expect(close).toHaveBeenCalledTimes(1);
      expect(exec.mock.invocationCallOrder[0]).toBeLessThan(
        mustExist(close.mock.invocationCallOrder[0])
      );

      vi.advanceTimersByTime(config.checkpointIntervalMs * 3);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("is a no-op when the journal was never opened", () => {
      closeDriver({ config, state });

      expect(state.driver).toBeNull();
      expect(state.checkpointTimer).toBeNull();
    });
  });
});
