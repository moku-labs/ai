import { describe, expect, it } from "vitest";
import type { VideoRequest } from "../../../video/contract";
import {
  buildFalBody,
  falAliases,
  modelAudio,
  modelResolution,
  resolveFalModel
} from "../../models";

const URLS = {
  image: "https://cdn/img",
  refs: ["https://cdn/r1", "https://cdn/r2"],
  audioRefs: []
};

/** Builds the body for `model` from a request with the given overrides. */
function bodyFor(model: string, overrides: Partial<VideoRequest> = {}): Record<string, unknown> {
  const request: VideoRequest = { model, prompt: "slow push-in", ...overrides };
  return buildFalBody(resolveFalModel(model), request, URLS);
}

describe("fal model catalog", () => {
  it("lists the thirteen aliases in catalog order", () => {
    expect(falAliases()).toEqual([
      "seedance-2.5",
      "seedance-2.5-ref",
      "minimax-h3",
      "minimax-h3-max-ref",
      "kling-3-pro",
      "kling-o3-ref",
      "seedance-2.0-mini",
      "seedance-2.0-mini-ref",
      "seedance-2.0-ref",
      "wan-3.0-ref",
      "veo-3.1-fast",
      "vidu-q3",
      "vidu-q3-ref"
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
      '[ai] Unknown fal video model "sora-9".\n  Use one of: seedance-2.5, seedance-2.5-ref, minimax-h3, minimax-h3-max-ref, kling-3-pro, kling-o3-ref, seedance-2.0-mini, seedance-2.0-mini-ref, seedance-2.0-ref, wan-3.0-ref, veo-3.1-fast, vidu-q3, vidu-q3-ref.'
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
    expect(modelAudio(resolveFalModel("minimax-h3"), withAudio)).toBe(true);
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

describe("catalog additions: seedance 2.0, wan 3.0, veo 3.1 fast, vidu q3", () => {
  it.each([
    ["seedance-2.0-mini", "bytedance/seedance-2.0/mini/image-to-video", 0, 0],
    ["seedance-2.0-mini-ref", "bytedance/seedance-2.0/mini/reference-to-video", 8, 3],
    ["seedance-2.0-ref", "bytedance/seedance-2.0/reference-to-video", 8, 3],
    ["wan-3.0-ref", "alibaba/wan-3.0/reference-to-video", 9, 5],
    ["veo-3.1-fast", "fal-ai/veo3.1/fast/image-to-video", 0, 0],
    ["vidu-q3", "fal-ai/vidu/q3/image-to-video", 0, 0],
    ["vidu-q3-ref", "fal-ai/vidu/q3/reference-to-video/mix", 3, 0]
  ])("%s resolves to %s, 720p, audio, %i image refs, %i audio refs", (alias, endpoint, maxRefs, maxAudioRefs) => {
    const model = resolveFalModel(alias);
    const request: VideoRequest = { model: alias, prompt: "p", audio: true };

    expect(model).toMatchObject({ alias, endpoint, audio: true, maxRefs, maxAudioRefs });
    expect(modelResolution(model, request)).toBe("720p");
    expect(modelAudio(model, request)).toBe(true);
  });

  it("seedance-2.0-mini: image_url, string duration, aspect_ratio, generate_audio", () => {
    expect(bodyFor("seedance-2.0-mini", { seconds: 6, audio: true })).toEqual({
      prompt: "slow push-in",
      image_url: "https://cdn/img",
      duration: "6",
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: true
    });
    expect(bodyFor("seedance-2.0-mini", { aspect: "16:9" }).aspect_ratio).toBe("16:9");
  });

  it.each([
    "seedance-2.0-mini-ref",
    "seedance-2.0-ref"
  ])("%s: image + refs in image_urls, audio_urls only when there are audio refs", alias => {
    expect(bodyFor(alias, { resolution: "480p" })).toEqual({
      prompt: "slow push-in",
      image_urls: ["https://cdn/img", "https://cdn/r1", "https://cdn/r2"],
      duration: "5",
      resolution: "480p",
      aspect_ratio: "9:16",
      generate_audio: false
    });
    const withVoice = buildFalBody(
      resolveFalModel(alias),
      { model: alias, prompt: "p" },
      { ...URLS, audioRefs: ["https://cdn/voice"] }
    );
    expect(withVoice.audio_urls).toEqual(["https://cdn/voice"]);
  });

  it("wan-3.0-ref: first frame leads reference_image_urls, integer duration, audio flag", () => {
    const body = bodyFor("wan-3.0-ref", { seconds: 8, audio: true });

    expect(body).toEqual({
      prompt: "slow push-in",
      reference_image_urls: ["https://cdn/img", "https://cdn/r1", "https://cdn/r2"],
      duration: 8,
      resolution: "720p",
      aspect_ratio: "9:16",
      audio: true
    });
    expect(body).not.toHaveProperty("reference_audio_urls");
  });

  it("wan-3.0-ref: sends reference_audio_urls when there are audio refs", () => {
    const body = buildFalBody(
      resolveFalModel("wan-3.0-ref"),
      { model: "wan-3.0-ref", prompt: "p" },
      { image: "u0", refs: [], audioRefs: ["a1", "a2"] }
    );
    expect(body.reference_image_urls).toEqual(["u0"]);
    expect(body.reference_audio_urls).toEqual(["a1", "a2"]);
  });

  it("veo-3.1-fast: duration as '<s>s', negative_prompt only when given", () => {
    const body = bodyFor("veo-3.1-fast", { seconds: 8, audio: true });

    expect(body).toEqual({
      prompt: "slow push-in",
      image_url: "https://cdn/img",
      duration: "8s",
      resolution: "720p",
      aspect_ratio: "9:16",
      generate_audio: true
    });
    expect(body).not.toHaveProperty("negative_prompt");
    expect(bodyFor("veo-3.1-fast", { negative: "blur" }).negative_prompt).toBe("blur");
  });

  it("vidu-q3: integer duration, audio flag, no aspect_ratio (the aspect follows the image)", () => {
    const body = bodyFor("vidu-q3", { seconds: 4, aspect: "16:9" });

    expect(body).toEqual({
      prompt: "slow push-in",
      image_url: "https://cdn/img",
      duration: 4,
      resolution: "720p",
      audio: false
    });
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("vidu-q3-ref: first frame leads reference_image_urls, integer duration, aspect_ratio", () => {
    expect(bodyFor("vidu-q3-ref", { audio: true, aspect: "1:1", resolution: "1080p" })).toEqual({
      prompt: "slow push-in",
      reference_image_urls: ["https://cdn/img", "https://cdn/r1", "https://cdn/r2"],
      duration: 5,
      resolution: "1080p",
      aspect_ratio: "1:1",
      audio: true
    });
  });
});
