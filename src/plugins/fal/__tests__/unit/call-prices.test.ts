import { describe, expect, it } from "vitest";
import {
  callCannotPriceError,
  callCostUsd,
  callNoPriceError,
  callRate,
  callUnitOf,
  frameBlocksOf,
  megapixelsOf
} from "../../call/prices";
import { TerminalProviderError } from "../../errors";
import { mergePrices } from "../../prices";

const GPT_IMAGE_EDIT = "openai/gpt-image-2.5/sunburst/edit";

describe("call price rows in the merged table", () => {
  it("merges the bundled rows under the call: prefix", () => {
    const prices = mergePrices({});

    // A missing prefixKeys("call", …) in mergePrices leaves every call endpoint unpriced.
    expect(callRate(prices, "fal-ai/sam-3/image")).toBe(0.005);
  });

  it("lets config.priceOverrides win and add an endpoint", () => {
    const prices = mergePrices({ "call:fal-ai/sam-3/image": 0.007, "call:x/y": 0.01 });

    expect(callRate(prices, "fal-ai/sam-3/image")).toBe(0.007);
    expect(callRate(prices, "x/y")).toBe(0.01);
  });

  it("has no row for gpt-image: it is billed per token and runs as the image task", () => {
    // A per-request row here would book a wrong cost for a call fal bills per token.
    expect(() => callRate(mergePrices({}), GPT_IMAGE_EDIT)).toThrow(
      `No price for fal endpoint "${GPT_IMAGE_EDIT}"`
    );
  });
});

describe("callRate", () => {
  it("throws the two-line no-price error as a terminal 400 for an endpoint with no row", () => {
    // Bug: an unpriced endpoint runs at cost 0.
    expect(() => callRate({}, "x/y")).toThrow(TerminalProviderError);
    expect(() => callRate({}, "x/y")).toThrow(
      '[ai] No price for fal endpoint "x/y".\n  Add "call:x/y" to fal.priceOverrides (USD per request).'
    );
    expect(callNoPriceError("x/y").status).toBe(400);
  });

  it("reads only the call: key, never another task's row of the same name", () => {
    // Bug: video rows are unprefixed; an endpoint named like a video alias must not hit them.
    expect(() =>
      callRate({ "kling-3-pro": 0.112, "image:kling-3-pro": 0.1 }, "kling-3-pro")
    ).toThrow("No price for fal endpoint");
  });
});

describe("callCannotPriceError", () => {
  it("is the two-line terminal 400 for a megapixel endpoint without a readable local image", () => {
    const error = callCannotPriceError("microsoft/moge-2");

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      '[ai] Cannot price fal endpoint "microsoft/moge-2".\n  It is billed per megapixel of input.image_url: pass that image as a local PNG, JPEG or WebP file.'
    );
  });
});

describe("callUnitOf", () => {
  it("maps the two endpoints with a bundled unit and defaults every other to request", () => {
    expect(callUnitOf("fal-ai/sam-3/video-rle")).toBe("16-frames");
    expect(callUnitOf("microsoft/moge-2")).toBe("megapixel");
    expect(callUnitOf("fal-ai/sam-3/image")).toBe("request");
    expect(callUnitOf("never/heard-of-it")).toBe("request");
  });

  it("ignores inherited object keys", () => {
    // Bug: `callUnits[endpoint]` on a plain object answers a function for "constructor".
    expect(callUnitOf("constructor")).toBe("request");
    expect(callUnitOf("toString")).toBe("request");
    expect(callUnitOf("__proto__")).toBe("request");
  });
});

describe("megapixelsOf", () => {
  it("rounds up to the next whole megapixel", () => {
    // Bug: every megapixel call counted as one unit, or rounded down.
    expect(megapixelsOf({ width: 1080, height: 1920 })).toBe(3);
    expect(megapixelsOf({ width: 1001, height: 1000 })).toBe(2);
  });

  it("does not round an exact megapixel up", () => {
    expect(megapixelsOf({ width: 1000, height: 1000 })).toBe(1);
    expect(megapixelsOf({ width: 100, height: 100 })).toBe(1);
  });
});

describe("frameBlocksOf", () => {
  it("counts one block per started 16 frames of the rle array", () => {
    // Bug: a long shot billed as one block.
    expect(frameBlocksOf({ rle: Array.from({ length: 49 }, () => "r") })).toBe(4);
    expect(frameBlocksOf({ rle: Array.from({ length: 48 }, () => "r") })).toBe(3);
    expect(frameBlocksOf({ rle: Array.from({ length: 16 }, () => "r") })).toBe(1);
    expect(frameBlocksOf({ rle: Array.from({ length: 17 }, () => "r") })).toBe(2);
  });

  it("is undefined when the answer has no rle array", () => {
    expect(frameBlocksOf({})).toBeUndefined();
    expect(frameBlocksOf({ rle: "x" })).toBeUndefined();
    expect(frameBlocksOf({ rle: { length: 49 } })).toBeUndefined();
    expect(frameBlocksOf("text")).toBeUndefined();
    expect(frameBlocksOf(undefined)).toBeUndefined();
  });
});

describe("callCostUsd", () => {
  it("is rate times units, rounded to micro-dollars", () => {
    // Bug: float noise (0.1 * 3 = 0.30000000000000004) lands in the journal's cost.
    expect(callCostUsd(0.1, 3)).toBe(0.3);
    expect(callCostUsd(0.005, 4)).toBe(0.02);
    expect(callCostUsd(0.01, 3)).toBe(0.03);
  });
});
