import { describe, expect, it } from "vitest";
import type { RunEvent, RunResult, RunResultStatus } from "../../../../runner/types";
import { runRunCommand } from "../../../commands/run";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext, ZERO_TOTALS } from "../fixtures";

/** Builds a `runner.run` fake resolving with the given terminal status. */
function fakeRunResult(status: RunResultStatus): () => Promise<RunResult> {
  return () => Promise.resolve({ runId: "run-1", status, totals: ZERO_TOTALS });
}

describe("runRunCommand — exit-code mapping", () => {
  it.each<[RunResultStatus, number]>([
    ["done", EXIT_CODES.ok],
    ["failed", EXIT_CODES.failure],
    ["paused", EXIT_CODES.paused],
    ["budget-stopped", EXIT_CODES.budgetStop]
  ])("maps run status %s to exit code %i", async (status, expectedCode) => {
    const { context } = createFakeCommandContext({
      runner: { run: fakeRunResult(status) }
    });

    const code = await runRunCommand(context, {}, []);

    expect(code).toBe(expectedCode);
  });
});

describe("runRunCommand — flag parsing", () => {
  it("rejects a non-numeric --max-cost with the usage exit code", async () => {
    const { context, errorLines } = createFakeCommandContext();

    const code = await runRunCommand(context, { maxCost: "not-a-number" }, []);

    expect(code).toBe(EXIT_CODES.usage);
    expect(errorLines.some(line => line.includes("invalid --max-cost"))).toBe(true);
  });

  it("rejects a negative --max-cost with the usage exit code", async () => {
    const { context } = createFakeCommandContext();

    const code = await runRunCommand(context, { maxCost: "-5" }, []);

    expect(code).toBe(EXIT_CODES.usage);
  });

  it("forwards a valid --max-cost and --dry-run to runner.run", async () => {
    let receivedOptions: unknown;
    const { context } = createFakeCommandContext({
      runner: {
        run: options => {
          receivedOptions = options;
          return Promise.resolve({ runId: "run-1", status: "done", totals: ZERO_TOTALS });
        }
      }
    });

    await runRunCommand(context, { maxCost: "5.5", dryRun: "true" }, ["voice/*.moku.yaml"]);

    expect(receivedOptions).toEqual({ files: "voice/*.moku.yaml", maxCostUsd: 5.5, dryRun: true });
  });

  it("omits maxCostUsd/dryRun/files entirely when not given", async () => {
    let receivedOptions: unknown;
    const { context } = createFakeCommandContext({
      runner: {
        run: options => {
          receivedOptions = options;
          return Promise.resolve({ runId: "run-1", status: "done", totals: ZERO_TOTALS });
        }
      }
    });

    await runRunCommand(context, {}, []);

    expect(receivedOptions).toEqual({});
  });
});

describe("runRunCommand — progress rendering", () => {
  it("renders progress and terminal events from runner.events()", async () => {
    const events: RunEvent[] = [
      { type: "progress", runId: "run-1", totals: { ...ZERO_TOTALS, done: 1, total: 2 } },
      {
        type: "terminal",
        runId: "run-1",
        status: "done",
        totals: { ...ZERO_TOTALS, done: 1, flagged: 1, total: 2 }
      }
    ];
    const { context, lines } = createFakeCommandContext({
      runner: {
        run: () => Promise.resolve({ runId: "run-1", status: "done", totals: ZERO_TOTALS }),

        events: async function* (): AsyncIterable<RunEvent> {
          for (const event of events) yield event;
        }
      }
    });

    await runRunCommand(context, {}, []);

    expect(lines.some(line => line.includes("1/2"))).toBe(true);
    expect(lines.some(line => line.includes("done"))).toBe(true);
    expect(lines.some(line => /flagged\s+1/.test(line))).toBe(true);
  });
});

describe("runRunCommand — dry-run rendering", () => {
  it("renders the estimate summary even though the event stream stays empty", async () => {
    // The fixture's default runner.events() is an empty generator — exactly
    // the real runner's dry-run behavior (no active run, no terminal event).
    const { context, lines } = createFakeCommandContext({
      runner: {
        run: () =>
          Promise.resolve({
            runId: "dry-run",
            status: "done",
            totals: { ...ZERO_TOTALS, total: 3, estimatedRemainingUsd: 1.25 }
          })
      }
    });

    const code = await runRunCommand(context, { dryRun: "true" }, []);

    expect(code).toBe(EXIT_CODES.ok);
    expect(lines.some(line => line.includes("3 item(s) planned"))).toBe(true);
    expect(lines.some(line => line.includes("$1.2500"))).toBe(true);
  });
});

describe("runRunCommand — SIGINT wiring", () => {
  it("runs the operation through context.runWithAbort", async () => {
    let wasCalled = false;
    const { context } = createFakeCommandContext({
      runWithAbort: async action => {
        wasCalled = true;
        return action(new AbortController().signal);
      }
    });

    await runRunCommand(context, {}, []);

    expect(wasCalled).toBe(true);
  });
});
