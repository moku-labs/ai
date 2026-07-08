import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSqliteDriver } from "../../driver/select";
import type { SqliteDriver } from "../../driver/types";

const mocks = vi.hoisted(() => ({
  openBetterSqlite3Driver: vi.fn(),
  openBunSqliteDriver: vi.fn()
}));

vi.mock("../../driver/better-sqlite3", () => ({
  openBetterSqlite3Driver: mocks.openBetterSqlite3Driver
}));
vi.mock("../../driver/bun-sqlite", () => ({
  openBunSqliteDriver: mocks.openBunSqliteDriver
}));

function createFakeDriver(): SqliteDriver {
  return {
    exec: vi.fn(),
    run: vi.fn(() => ({ changes: 0 })),
    all: vi.fn(() => []),
    get: vi.fn(() => undefined),
    transactionImmediate: vi.fn(fn => fn()),
    close: vi.fn()
  };
}

describe("openSqliteDriver — runtime detection", () => {
  const originalBun = globalThis.Bun;

  beforeEach(() => {
    mocks.openBetterSqlite3Driver.mockReset().mockReturnValue(createFakeDriver());
    mocks.openBunSqliteDriver.mockReset().mockReturnValue(createFakeDriver());
  });

  afterEach(() => {
    (globalThis as { Bun?: typeof Bun }).Bun = originalBun;
  });

  it("opens the better-sqlite3 driver when the Bun global is undefined", () => {
    delete (globalThis as { Bun?: typeof Bun }).Bun;

    openSqliteDriver({ path: ":memory:", busyTimeoutMs: 5000 });

    expect(mocks.openBetterSqlite3Driver).toHaveBeenCalledWith({
      path: ":memory:",
      busyTimeoutMs: 5000
    });
    expect(mocks.openBunSqliteDriver).not.toHaveBeenCalled();
  });

  it("opens the bun:sqlite driver when the Bun global is defined", () => {
    (globalThis as { Bun?: typeof Bun }).Bun = originalBun ?? ({} as typeof Bun);

    openSqliteDriver({ path: ":memory:", busyTimeoutMs: 5000 });

    expect(mocks.openBunSqliteDriver).toHaveBeenCalledWith({
      path: ":memory:",
      busyTimeoutMs: 5000
    });
    expect(mocks.openBetterSqlite3Driver).not.toHaveBeenCalled();
  });

  it("applies the durability pragma set to the opened driver", () => {
    (globalThis as { Bun?: typeof Bun }).Bun = originalBun ?? ({} as typeof Bun);
    const fakeDriver = createFakeDriver();
    mocks.openBunSqliteDriver.mockReturnValue(fakeDriver);

    openSqliteDriver({ path: ":memory:", busyTimeoutMs: 7000 });

    expect(fakeDriver.exec).toHaveBeenCalledWith("PRAGMA journal_mode = WAL");
    expect(fakeDriver.exec).toHaveBeenCalledWith("PRAGMA synchronous = FULL");
    expect(fakeDriver.exec).toHaveBeenCalledWith("PRAGMA fullfsync = 1");
    expect(fakeDriver.exec).toHaveBeenCalledWith("PRAGMA busy_timeout = 7000");
  });
});
