import { describe, expect, it } from "vitest";
import { clearActiveRun, createRunnerState } from "../../state";
import type { ActiveRun } from "../../types";

// eslint-disable-next-line unicorn/no-null -- State.active is typed `ActiveRun | null`; the single source of the null literal for this file
const NO_ACTIVE_RUN = null;

describe("createRunnerState", () => {
  it("starts with no active run", () => {
    expect(createRunnerState()).toEqual({ active: NO_ACTIVE_RUN });
  });

  it("returns a fresh object on each call", () => {
    expect(createRunnerState()).not.toBe(createRunnerState());
  });
});

describe("clearActiveRun", () => {
  it("resets an active run back to null", () => {
    const active: ActiveRun = {
      runId: "run-1",
      signal: undefined,
      subscribers: new Set(),
      inFlight: 0
    };
    const state = { active };

    clearActiveRun(state);

    expect(state.active).toBeNull();
  });

  it("is a no-op when already null", () => {
    const state = createRunnerState();

    clearActiveRun(state);

    expect(state.active).toBeNull();
  });
});
