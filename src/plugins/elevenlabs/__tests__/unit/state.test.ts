import { describe, expect, it } from "vitest";
import { createElevenlabsState } from "../../state";

describe("createElevenlabsState", () => {
  it("starts with an uncomputed price table (null)", () => {
    // eslint-disable-next-line unicorn/no-null -- State.prices is `X | null`; asserting the exact sentinel
    expect(createElevenlabsState()).toEqual({ prices: null });
  });

  it("returns a fresh object on each call (no shared mutable state across instances)", () => {
    const a = createElevenlabsState();
    const b = createElevenlabsState();

    expect(a).not.toBe(b);
  });
});
