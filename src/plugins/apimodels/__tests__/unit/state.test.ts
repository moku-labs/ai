import { describe, expect, it } from "vitest";
import { createApimodelsState } from "../../state";

describe("createApimodelsState", () => {
  it("starts with the price table not yet computed", () => {
    expect(createApimodelsState().prices).toBeNull();
  });

  it("starts with empty upload, asset and group caches", () => {
    const state = createApimodelsState();
    expect(state.uploads).toEqual(new Map());
    expect(state.assets).toEqual(new Map());
    expect(state.groups).toEqual(new Map());
  });

  it("starts with no group, registration or upload in flight", () => {
    const state = createApimodelsState();
    expect(state.groupsInFlight).toEqual(new Map());
    expect(state.assetsInFlight).toEqual(new Map());
    expect(state.uploadsInFlight).toEqual(new Map());
  });

  it("has not logged a journal skip yet", () => {
    expect(createApimodelsState().journalSkipLogged).toBe(false);
  });

  it("returns a fresh object with fresh maps each call", () => {
    const first = createApimodelsState();
    const second = createApimodelsState();
    expect(first).not.toBe(second);
    expect(first.assets).not.toBe(second.assets);
  });
});
