import { describe, expect, it } from "vitest";
import type { VideoRequest } from "../../../video/contract";
import {
  buildFalBody,
  falAliases,
  modelAudio,
  modelResolution,
  resolveFalModel
} from "../../models";

const URLS = { image: "https://cdn/img", refs: ["https://cdn/r1", "https://cdn/r2"] };

/** Builds the body for `model` from a request with the given overrides. */
function bodyFor(model: string, overrides: Partial<VideoRequest> = {}): Record<string, unknown> {
  const request: VideoRequest = { model, prompt: "slow push-in", ...overrides };
  return buildFalBody(resolveFalModel(model), request, URLS);
}

describe("fal model catalog", () => {
  it("lists the five aliases in catalog order", () => {
    expect(falAliases()).toEqual([
      "seedance-2.5",
      "seedance-2.5-ref",
      "minimax-h3",
      "kling-3-pro",
      "kling-o3-ref"
    ]);
  });

  it("maps each alias to its fal endpoint", () => {
    expect(resolveFalModel("seedance-2.5").endpoint).toBe("bytedance/seedance-2.5/image-to-video");
    expect(resolveFalModel("seedance-2.5-ref").endpoint).toBe(
      "bytedance/seedance-2.5/reference-to-video"
    );
    expect(resolveFalModel("minimax-h3").endpoint).toBe("minimax/h3/image-to-video");
    expect(resolveFalModel("kling-3-pro").endpoint).toBe(
      "fal-ai/kling-video/v3/pro/image-to-video"
    );
    expect(resolveFalModel("kling-o3-ref").endpoint).toBe(
      "fal-ai/kling-video/o3/pro/reference-to-video"
    );
  });

  it("rejects a model that is not an alias with the pinned two-line error", () => {
    expect(() => resolveFalModel("sora-9")).toThrow(
      '[ai] Unknown fal video model "sora-9".\n  Use one of: seedance-2.5, seedance-2.5-ref, minimax-h3, kling-3-pro, kling-o3-ref.'
    );
  });

  it("does not accept inherited object keys as aliases", () => {
    expect(() => resolveFalModel("toString")).toThrow("Unknown fal video model");
  });
});

describe("modelResolution / modelAudio", () => {
  it("defaults resolution per alias and keeps an explicit one", () => {
    const request: VideoRequest = { model: "x", prompt: "p" };
    expect(modelResolution(resolveFalModel("seedance-2.5"), request)).toBe("720p");
    expect(modelResolution(resolveFalModel("seedance-2.5-ref"), request)).toBe("720p");
    expect(modelResolution(resolveFalModel("minimax-h3"), request)).toBe("768P");
    expect(modelResolution(resolveFalModel("kling-3-pro"), request)).toBeUndefined();
    expect(
      modelResolution(resolveFalModel("seedance-2.5"), { ...request, resolution: "480p" })
    ).toBe("480p");
  });

  it("turns audio on only when requested and the model can make it", () => {
    const withAudio: VideoRequest = { model: "x", prompt: "p", audio: true };
    expect(modelAudio(resolveFalModel("kling-3-pro"), withAudio)).toBe(true);
    expect(modelAudio(resolveFalModel("minimax-h3"), withAudio)).toBe(false);
    expect(modelAudio(resolveFalModel("kling-3-pro"), { model: "x", prompt: "p" })).toBe(false);
  });
});

describe("buildFalBody", () => {
  it("seedance-2.5: image_url, string duration, resolution, generate_audio", () => {
    expect(bodyFor("seedance-2.5", { seconds: 6, audio: true })).toEqual({
      prompt: "slow push-in",
      image_url: "https://cdn/img",
      duration: "6",
      resolution: "720p",
      generate_audio: true
    });
  });

  it("seedance-2.5-ref: image + refs in image_urls, aspect default 9:16", () => {
    expect(bodyFor("seedance-2.5-ref", { resolution: "480p" })).toEqual({
      prompt: "slow push-in",
      image_urls: ["https://cdn/img", "https://cdn/r1", "https://cdn/r2"],
      duration: "5",
      resolution: "480p",
      aspect_ratio: "9:16",
      generate_audio: false
    });
    expect(bodyFor("seedance-2.5-ref", { aspect: "16:9" }).aspect_ratio).toBe("16:9");
  });

  it("minimax-h3: numeric duration, resolution, no audio field", () => {
    expect(bodyFor("minimax-h3", { seconds: 10, audio: true })).toEqual({
      prompt: "slow push-in",
      image_url: "https://cdn/img",
      duration: 10,
      resolution: "768P"
    });
  });

  it("kling-3-pro: start_image_url, negative_prompt only when given", () => {
    expect(bodyFor("kling-3-pro")).toEqual({
      prompt: "slow push-in",
      start_image_url: "https://cdn/img",
      duration: "5",
      generate_audio: false
    });
    expect(bodyFor("kling-3-pro", { negative: "blur" }).negative_prompt).toBe("blur");
  });

  it("kling-o3-ref: start_image_url + refs as image_urls, aspect default 9:16", () => {
    expect(bodyFor("kling-o3-ref", { seconds: 8, audio: true, aspect: "1:1" })).toEqual({
      prompt: "slow push-in",
      start_image_url: "https://cdn/img",
      image_urls: ["https://cdn/r1", "https://cdn/r2"],
      duration: "8",
      aspect_ratio: "1:1",
      generate_audio: true
    });
  });

  it("merges request.params last, so params win", () => {
    const body = bodyFor("minimax-h3", { params: { duration: 6, prompt_expansion_mode: "off" } });
    expect(body.duration).toBe(6);
    expect(body.prompt_expansion_mode).toBe("off");
  });

  it("keeps only the refs a model accepts (kling-o3-ref takes at most 4)", () => {
    const model = resolveFalModel("kling-o3-ref");
    expect(model.maxRefs).toBe(4);
    expect(resolveFalModel("seedance-2.5").maxRefs).toBe(0);
    expect(resolveFalModel("seedance-2.5-ref").maxRefs).toBeGreaterThan(4);
  });
});
