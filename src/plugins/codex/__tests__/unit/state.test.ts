import { describe, expect, it } from "vitest";
import { createCodexState } from "../../state";

describe("createCodexState", () => {
  it("starts with an uncomputed price table (null)", () => {
    // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; asserting the exact sentinel
    expect(createCodexState()).toEqual({ prices: null });
  });

  it("returns a fresh object on each call", () => {
    expect(createCodexState()).not.toBe(createCodexState());
  });
});
