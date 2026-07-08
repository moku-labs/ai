import { describe, expect, it } from "vitest";
import { createJournalState } from "../../state";

describe("createJournalState", () => {
  it("starts with a null driver and a null checkpoint timer", () => {
    const state = createJournalState();

    expect(state.driver).toBeNull();
    expect(state.checkpointTimer).toBeNull();
  });

  it("returns a fresh object on every call", () => {
    const first = createJournalState();
    const second = createJournalState();

    expect(first).not.toBe(second);
  });
});
