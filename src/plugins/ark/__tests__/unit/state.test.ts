import { describe, expect, it } from "vitest";
import { createArkState } from "../../state";

describe("createArkState", () => {
  it("starts with no group, no account, no active assets and no warning", () => {
    const state = createArkState();
    expect(state.group).toBeNull();
    expect(state.account).toBeNull();
    expect(state.activeAssets).toEqual(new Set());
    expect(state.negativeWarned).toBe(false);
    expect(Object.keys(state)).toEqual(["group", "account", "activeAssets", "negativeWarned"]);
  });

  it("gives each call its own asset cache", () => {
    const first = createArkState();
    first.activeAssets.add("asset-1");
    expect(createArkState().activeAssets.size).toBe(0);
  });
});
