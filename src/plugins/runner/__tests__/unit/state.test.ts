import { describe, expect, it } from "vitest";
import { addActiveRun, createRunnerState, openClaim, removeActiveRun } from "../../state";

describe("createRunnerState", () => {
  it("starts with no active run, no stream consumer and no artifact claim", () => {
    const state = createRunnerState();

    expect(state.active).toEqual(new Map());
    expect(state.subscribers).toEqual(new Set());
    expect(state.claims).toEqual(new Map());
  });

  it("returns a fresh object on each call", () => {
    const first = createRunnerState();
    const second = createRunnerState();

    expect(first).not.toBe(second);
    expect(first.active).not.toBe(second.active);
  });
});

describe("addActiveRun", () => {
  it("registers runs in start order with their signal", () => {
    const state = createRunnerState();
    const controller = new AbortController();

    addActiveRun(state, "run-1", undefined);
    const second = addActiveRun(state, "run-2", controller.signal);

    expect([...state.active.keys()]).toEqual(["run-1", "run-2"]);
    expect(second).toEqual({ runId: "run-2", signal: controller.signal, inFlight: 0 });
    expect(state.active.get("run-2")).toBe(second);
  });
});

describe("removeActiveRun", () => {
  it("deletes only the given run", () => {
    const state = createRunnerState();
    addActiveRun(state, "run-1", undefined);
    addActiveRun(state, "run-2", undefined);

    removeActiveRun(state, "run-1");

    expect([...state.active.keys()]).toEqual(["run-2"]);
  });

  it("is a no-op for a run that is not active", () => {
    const state = createRunnerState();
    addActiveRun(state, "run-1", undefined);

    removeActiveRun(state, "run-9");

    expect([...state.active.keys()]).toEqual(["run-1"]);
  });
});

describe("openClaim", () => {
  it("holds the artifact key for the item until it settles, then hands out the verdict", async () => {
    const state = createRunnerState();

    const settle = openClaim(state, "ak-1", "item-1");
    const claim = state.claims.get("ak-1");
    expect(claim?.itemId).toBe("item-1");

    settle({ kind: "failed", errorClass: "http-4xx" });

    expect(state.claims.has("ak-1")).toBe(false);
    await expect(claim?.settled).resolves.toEqual({ kind: "failed", errorClass: "http-4xx" });
  });

  it("frees the key before followers wake, so the first one to wake can claim it", async () => {
    const state = createRunnerState();
    const settle = openClaim(state, "ak-1", "item-1");
    const claim = state.claims.get("ak-1");

    const seenOnWake = claim?.settled.then(() => state.claims.has("ak-1"));
    settle({ kind: "open" });

    await expect(seenOnWake).resolves.toBe(false);
  });

  it("never deletes a newer claim on the same key", () => {
    const state = createRunnerState();
    const settleOld = openClaim(state, "ak-1", "item-1");
    openClaim(state, "ak-1", "item-2");

    settleOld({ kind: "open" });

    expect(state.claims.get("ak-1")?.itemId).toBe("item-2");
  });
});
