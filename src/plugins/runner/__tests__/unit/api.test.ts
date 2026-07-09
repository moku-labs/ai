import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunnerApi, shouldEmitProgress } from "../../api";
import type { RunEvent } from "../../types";
import { type CallLog, createFakeRunnerContext } from "./fixtures";

// ---------------------------------------------------------------------------
// shouldEmitProgress — the ≤1/500ms progress-coalescing throttle rule
// ---------------------------------------------------------------------------

describe("shouldEmitProgress", () => {
  const PROGRESS_COALESCE_MS = 500;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not emit before the coalescing window elapses", () => {
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS - 100);
    expect(shouldEmitProgress(0, Date.now())).toBe(false);
  });

  it("emits once the coalescing window elapses (inclusive boundary)", () => {
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS);
    expect(shouldEmitProgress(0, Date.now())).toBe(true);
  });

  it("emits again only after another full window from the new lastProgressAt", () => {
    vi.advanceTimersByTime(PROGRESS_COALESCE_MS);
    const firstEmitAt = Date.now();

    vi.advanceTimersByTime(PROGRESS_COALESCE_MS - 1);
    expect(shouldEmitProgress(firstEmitAt, Date.now())).toBe(false);

    vi.advanceTimersByTime(1);
    expect(shouldEmitProgress(firstEmitAt, Date.now())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createRunnerApi — status()/events() edge behavior without an active run
// ---------------------------------------------------------------------------

describe("createRunnerApi", () => {
  it("status() throws a two-line error when no run id is given and none can be inferred", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const api = createRunnerApi(ctx);

    expect(() => api.status()).toThrow(/^\[ai\] No run to report status for/);
  });

  it("status() reads the given runId via journal.readSnapshot", () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const api = createRunnerApi(ctx);

    const report = api.status("run-42");

    expect(report.runId).toBe("run-42");
  });

  it("events() returns an already-closed empty stream when no run is active", async () => {
    const log: CallLog = [];
    const ctx = createFakeRunnerContext(log);
    const api = createRunnerApi(ctx);

    const received: RunEvent[] = [];
    for await (const event of api.events()) {
      received.push(event);
    }

    expect(received).toEqual([]);
  });
});
