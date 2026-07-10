import { describe, expect, it } from "vitest";
import { pollUntilTerminal, runStatusCommand } from "../../../commands/status";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext, ZERO_TOTALS } from "../fixtures";

/** Reusable `null` sentinel for the nullable `RunRow` fields this file fakes. */
// eslint-disable-next-line unicorn/no-null -- see comment above; the single source of the null literal for this file
const FAKE_NULL = null;

describe("runStatusCommand — non-follow", () => {
  it("renders runner.status's snapshot and exits ok", async () => {
    const { context, lines } = createFakeCommandContext({
      runner: {
        status: runId => ({
          runId: runId ?? "run-1",
          status: "done",
          totals: { ...ZERO_TOTALS, done: 3, total: 3 },
          updatedAt: 0
        })
      }
    });

    const code = await runStatusCommand(context, {}, ["run-1"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(lines.some(line => line.includes("run-1"))).toBe(true);
    expect(lines.some(line => line.includes("3/3"))).toBe(true);
  });
});

describe("pollUntilTerminal — short-lived polling reads", () => {
  it("polls journal.readSnapshot on each tick via an injectable sleep until the run is terminal", async () => {
    let readCount = 0;
    const { context } = createFakeCommandContext({
      journal: {
        readSnapshot: runId => {
          readCount += 1;
          return {
            run: {
              id: runId,
              createdAt: 0,
              status: readCount < 3 ? "active" : "done",
              glob: "*",
              maxCostUsd: FAKE_NULL,
              finishedAt: FAKE_NULL
            },
            totals: ZERO_TOTALS,
            recentItems: []
          };
        }
      }
    });

    const sleepCalls: number[] = [];
    const immediateSleep = (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };

    await pollUntilTerminal(context, "run-1", 1000, immediateSleep);

    expect(readCount).toBe(3);
    // One sleep between each non-terminal read: 2 non-terminal reads -> 2 sleeps.
    expect(sleepCalls).toEqual([1000, 1000]);
  });

  it("never holds a connection open — every tick is its own readSnapshot call", async () => {
    const readSnapshotCalls: string[] = [];
    const { context } = createFakeCommandContext({
      journal: {
        readSnapshot: runId => {
          readSnapshotCalls.push(runId);
          return {
            run: {
              id: runId,
              createdAt: 0,
              status: "done",
              glob: "*",
              maxCostUsd: FAKE_NULL,
              finishedAt: 0
            },
            totals: ZERO_TOTALS,
            recentItems: []
          };
        }
      }
    });

    await pollUntilTerminal(context, "run-1", 1000, () => Promise.resolve());

    expect(readSnapshotCalls).toEqual(["run-1"]);
  });
});

describe("runStatusCommand — follow", () => {
  it("resolves a missing runId via runner.status(), then follows via journal.readSnapshot", async () => {
    const readSnapshotCalls: string[] = [];
    const { context } = createFakeCommandContext({
      runner: {
        status: () => ({
          runId: "run-resolved",
          status: "active",
          totals: ZERO_TOTALS,
          updatedAt: 0
        })
      },
      journal: {
        readSnapshot: runId => {
          readSnapshotCalls.push(runId);
          return {
            run: {
              id: runId,
              createdAt: 0,
              status: "done",
              glob: "*",
              maxCostUsd: FAKE_NULL,
              finishedAt: 0
            },
            totals: ZERO_TOTALS,
            recentItems: []
          };
        }
      }
    });

    const code = await runStatusCommand(context, { follow: "true" }, []);

    expect(code).toBe(EXIT_CODES.ok);
    expect(readSnapshotCalls).toEqual(["run-resolved"]);
  });
});
