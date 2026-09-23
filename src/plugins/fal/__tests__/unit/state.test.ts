import { describe, expect, it } from "vitest";
import { createFalState } from "../../state";

describe("createFalState", () => {
  it("starts with the price table not yet computed", () => {
    expect(createFalState().prices).toBeNull();
  });

  it("returns a fresh object each call", () => {
    expect(createFalState()).not.toBe(createFalState());
  });
});
