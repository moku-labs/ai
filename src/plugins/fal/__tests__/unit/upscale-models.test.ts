import { describe, expect, it } from "vitest";
import type { UpscaleEstimateRequest, UpscaleRequest } from "../../../upscale/contract";
import { TerminalProviderError } from "../../errors";
import { checkUpscaleEstimate, checkUpscaleRequest, upscaleAliases } from "../../upscale/models";

// ─────────────────────────────────────────────────────────────────────────────
// fal upscale catalog: zod validation (estimate and full), body builders.
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO = { path: "out/clean.mp4", mimeType: "video/mp4", hash: "ab12" };
const REQUEST: UpscaleRequest = {
  video: VIDEO,
  model: "starlight-fast-2",
  factor: 1.5,
  seconds: 62.4
};

/** The error `check` throws for `request`. */
function errorOf(check: (request: never) => unknown, request: unknown): unknown {
  try {
    check(request as never);
  } catch (error) {
    return error;
  }
  throw new Error("expected the check to throw");
}

describe("catalog", () => {
  it("lists the aliases in catalog order", () => {
    // Bug: models("upscale") lists in another order than the catalog.
    expect(upscaleAliases()).toEqual(["starlight-fast-2", "starlight-precise-2.6", "proteus"]);
  });

  it("rejects an unknown alias with a terminal 400 listing the three", () => {
    // Bug: an unknown alias falls back to another model and bills a different rate.
    expect(errorOf(checkUpscaleEstimate, { ...REQUEST, model: "topaz" })).toMatchObject({
      name: "TerminalProviderError",
      status: 400,
      message:
        '[ai] Unknown fal upscale model "topaz".\n  Use one of: starlight-fast-2, starlight-precise-2.6, proteus.'
    });
  });
});

describe("estimate check", () => {
  it.each([
    ["factor", { ...REQUEST, factor: 0.9 }],
    ["factor", { ...REQUEST, factor: 4.1 }],
    ["seconds", { ...REQUEST, seconds: 0 }],
    ["seconds", { ...REQUEST, seconds: "62" }],
    ["model", { ...REQUEST, model: "" }],
    ["params", { ...REQUEST, params: "sharp" }]
  ])("names %s in the terminal 400", (field, request) => {
    // Bug: a factor of 0.9 or 5 reaches fal and fails after the upload, or a bad field is reported without its name.
    const error = errorOf(checkUpscaleEstimate, request);
    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).toMatchObject({ status: 400 });
    const { message } = error as Error;
    expect(message.startsWith(`[ai] Invalid upscale request: ${field} `)).toBe(true);
    expect(message.endsWith(".\n  Fix the build item that produced it.")).toBe(true);
  });

  it.each([1, 4])("accepts the factor bound %d", factor => {
    // Bug: the range check is exclusive and refuses the documented 1 and 4.
    expect(() => checkUpscaleEstimate({ ...REQUEST, factor })).not.toThrow();
  });

  it.each([
    { $ref: "clean" },
    { $file: "out/clean.mp4" }
  ])("accepts the unresolved video %j", video => {
    // Bug: the runner estimates before references resolve; a video check here fails the plan.
    const request: UpscaleEstimateRequest = { ...REQUEST, video };
    expect(checkUpscaleEstimate(request).model.alias).toBe("starlight-fast-2");
  });
});

describe("full check", () => {
  it("refuses a video whose mimeType is not video/*, naming video.mimeType", () => {
    // Bug: a png upscaled as video is billed by the minute and fails at fal.
    const request = { ...REQUEST, video: { ...VIDEO, mimeType: "image/png" } };
    expect(errorOf(checkUpscaleRequest, request)).toMatchObject({
      status: 400,
      message: expect.stringMatching(/^\[ai\] Invalid upscale request: video\.mimeType /)
    });
  });

  it.each(["path", "hash"])("refuses an empty video.%s", field => {
    const request = { ...REQUEST, video: { ...VIDEO, [field]: "" } };
    expect(errorOf(checkUpscaleRequest, request)).toMatchObject({
      message: expect.stringContaining(`video.${field} `)
    });
  });

  it("still checks the estimate fields", () => {
    expect(errorOf(checkUpscaleRequest, { ...REQUEST, factor: 4.1 })).toMatchObject({
      message: expect.stringContaining("factor ")
    });
  });
});

describe("bodies", () => {
  it("fixed fields and the factor win over params; other params pass through", () => {
    // Bug: a build item flips H264_output or the model through params, or the factor is dropped.
    const request: UpscaleRequest = {
      ...REQUEST,
      params: {
        H264_output: false,
        model: "Proteus",
        upscale_factor: 9,
        target_fps: 30
      }
    };
    const { model } = checkUpscaleRequest(request);
    expect(model.endpoint).toBe("topaz/upscale/video/generative");
    expect(model.body(request)).toEqual({
      model: "Starlight Fast 2",
      H264_output: true,
      target_fps: 30,
      upscale_factor: 1.5
    });
  });

  it.each([
    [
      "starlight-precise-2.6",
      "topaz/upscale/video/generative",
      { model: "Starlight Precise 2.6", H264_output: true, upscale_factor: 2 }
    ],
    ["proteus", "fal-ai/topaz/upscale/video", { H264_output: true, upscale_factor: 2 }]
  ])("%s posts to %s with its own fixed fields", (alias, endpoint, body) => {
    // Bug: two aliases share a row, so Proteus is sent a generative model name or Precise the Fast one.
    const request: UpscaleRequest = { ...REQUEST, model: alias, factor: 2 };
    const checked = checkUpscaleRequest(request).model;
    expect(checked.endpoint).toBe(endpoint);
    expect(checked.body(request)).toEqual(body);
    expect(checked.body(request)).not.toHaveProperty("video_url");
  });
});
