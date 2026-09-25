import { describe, expect, it } from "vitest";
import { createFalState } from "../../state";

describe("createFalState", () => {
  it("starts with the price table not yet computed", () => {
    expect(createFalState().prices).toBeNull();
  });

  it("starts with an empty upload cache", () => {
    expect(createFalState().uploads).toEqual(new Map());
  });

  it("returns a fresh object each call", () => {
    expect(createFalState()).not.toBe(createFalState());
  });
});
