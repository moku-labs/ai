import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSET_MIME } from "../../../asset/contract";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { resolveArkModel } from "../../models";
import {
  ARK_PARAMS,
  ARK_RATIOS,
  assetRecordsOf,
  buildArkBody,
  checkVideoRequest,
  hasLocalImage,
  hasVideoReferenceUrl,
  readInputs,
  warnNegativeOnce
} from "../../video/body";
import type { TempFiles } from "../fixtures";
import {
  ASSET_ID,
  arkRecord,
  CREATE_TASK_REQUEST_ASSET_FIRST_FRAME,
  CREATE_TASK_REQUEST_FIRST_FRAME,
  CREATE_TASK_REQUEST_FIRST_LAST_FRAME,
  CREATE_TASK_REQUEST_REFERENCES,
  CREATE_TASK_REQUEST_TEXT_PARAMS,
  createTempFiles,
  createTestCtx,
  LOCAL_IMAGE_BYTES,
  LOCAL_IMAGE_DATA_URI
} from "../fixtures";

const MODEL_ID = "dreamina-seedance-2-0-260128";
const MODEL = resolveArkModel(MODEL_ID, "intl");

let temp: TempFiles;
let image: VideoFile;
let asset: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", LOCAL_IMAGE_BYTES, "image/png");
  asset = temp.asset("mira.asset.json", arkRecord());
});

afterAll(() => {
  temp.cleanup();
});

/** Checks, reads and builds a request the way submit does. */
async function bodyOf(request: VideoRequest): Promise<unknown> {
  const checked = checkVideoRequest(MODEL, request);
  const inputs = await readInputs(request);
  return buildArkBody(MODEL, request.prompt, checked, inputs);
}

/** A request with defaults for everything but the given fields. */
function request(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { model: MODEL_ID, prompt: "p", ...overrides };
}

describe("documented request bodies (toEqual)", () => {
  it("image to video, first frame", async () => {
    const body = await bodyOf(
      request({ prompt: "A girl walks into the rain, the camera follows her", image })
    );
    expect(body).toEqual(CREATE_TASK_REQUEST_FIRST_FRAME);
  });

  it("first and last frame", async () => {
    const body = await bodyOf(
      request({
        prompt: "The girl turns around and smiles",
        image,
        endImage: image,
        aspect: "adaptive"
      })
    );
    expect(body).toEqual(CREATE_TASK_REQUEST_FIRST_LAST_FRAME);
  });

  it("asset as the first frame", async () => {
    const body = await bodyOf(request({ prompt: "image 1 walks into the rain", image: asset }));
    expect(body).toEqual(CREATE_TASK_REQUEST_ASSET_FIRST_FRAME);
  });

  it("multimodal references: asset, image, video URL, audio URL", async () => {
    const body = await bodyOf(
      request({
        prompt: "image 1 walks down the street of image 2 to the beat of audio 1",
        refs: [asset, image],
        seconds: 10,
        audio: true,
        params: {
          refUrls: ["https://cdn.example/motion/walk.mp4", "https://cdn.example/audio/rain.mp3"]
        }
      })
    );
    expect(body).toEqual(CREATE_TASK_REQUEST_REFERENCES);
  });

  it("text to video with the optional params", async () => {
    const body = await bodyOf(
      request({
        prompt: "A city skyline at dusk, slow aerial push-in",
        aspect: "16:9",
        seconds: 8,
        resolution: "1080p",
        audio: true,
        params: {
          watermark: true,
          return_last_frame: true,
          camera_fixed: false,
          execution_expires_after: 3600
        }
      })
    );
    expect(body).toEqual(CREATE_TASK_REQUEST_TEXT_PARAMS);
  });
});

describe("mapping rows", () => {
  it("maps the prompt to content[0] and never rewrites it", async () => {
    const body = (await bodyOf(request({ prompt: "image 1 and image 2 dance", image }))) as {
      content: unknown[];
    };
    expect(body.content[0]).toEqual({ type: "text", text: "image 1 and image 2 dance" });
  });

  it("maps an asset end frame to asset:// as the last frame", async () => {
    const body = (await bodyOf(request({ image, endImage: asset }))) as { content: unknown[] };
    expect(body.content[2]).toEqual({
      type: "image_url",
      image_url: { url: `asset://${ASSET_ID}` },
      role: "last_frame"
    });
  });

  it("keeps the refs in request order, then the refUrls in array order", async () => {
    const second = temp.file("second.jpg", new Uint8Array([9]), "image/jpeg");
    const body = (await bodyOf(
      request({
        refs: [image, asset, second],
        params: { refUrls: ["https://cdn.example/b.wav", "https://cdn.example/a.mov"] }
      })
    )) as { content: Array<{ type: string; role?: string }> };

    expect(body.content.map(item => [item.type, item.role])).toEqual([
      ["text", undefined],
      ["image_url", "reference_image"],
      ["image_url", "reference_image"],
      ["image_url", "reference_image"],
      ["audio_url", "reference_audio"],
      ["video_url", "reference_video"]
    ]);
    expect(body.content[1]).toMatchObject({ image_url: { url: LOCAL_IMAGE_DATA_URI } });
    expect(body.content[2]).toMatchObject({ image_url: { url: `asset://${ASSET_ID}` } });
    expect(body.content[3]).toMatchObject({ image_url: { url: "data:image/jpeg;base64,CQ==" } });
  });

  it("takes each supported ratio", async () => {
    expect(ARK_RATIOS).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"]);
    for (const aspect of ARK_RATIOS) {
      expect(checkVideoRequest(MODEL, request({ aspect })).ratio).toBe(aspect);
    }
  });

  it("maps audio to generate_audio, off by default", async () => {
    expect(checkVideoRequest(MODEL, request()).audio).toBe(false);
    expect(checkVideoRequest(MODEL, request({ audio: true })).audio).toBe(true);
  });

  it("passes priority through", async () => {
    const body = (await bodyOf(request({ params: { priority: 1 } }))) as Record<string, unknown>;
    expect(body.priority).toBe(1);
    expect(body.watermark).toBe(false);
  });

  it("drops negative from the body", async () => {
    const body = (await bodyOf(request({ negative: "blur" }))) as Record<string, unknown>;
    expect(body).not.toHaveProperty("negative");
    expect(JSON.stringify(body)).not.toContain("blur");
  });

  it("lists the allowed params", () => {
    expect(ARK_PARAMS).toEqual([
      "refUrls",
      "watermark",
      "seed",
      "return_last_frame",
      "camera_fixed",
      "execution_expires_after",
      "priority"
    ]);
  });
});

describe("checkVideoRequest rejections", () => {
  it("rejects a ratio ark does not take", () => {
    expect(() => checkVideoRequest(MODEL, request({ aspect: "5:4" }))).toThrow(
      '[ai] ark ratio "5:4" is not supported.\n  Use one of: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, adaptive.'
    );
  });

  it("rejects seconds and resolution outside the model's limits", () => {
    expect(() => checkVideoRequest(MODEL, request({ seconds: 20 }))).toThrow(
      `[ai] Model ${MODEL_ID} takes 4 to 15 seconds.\n  Got 20; set input.seconds in that range.`
    );
    expect(() => checkVideoRequest(MODEL, request({ resolution: "2k" }))).toThrow(
      `[ai] Model ${MODEL_ID} does not take resolution "2k".`
    );
  });

  it("rejects an unknown param", () => {
    expect(() => checkVideoRequest(MODEL, request({ params: { cfg_scale: 7 } }))).toThrow(
      '[ai] Unknown ark param "cfg_scale".\n  Allowed: refUrls, watermark, seed, return_last_frame, camera_fixed, execution_expires_after, priority.'
    );
  });

  it("rejects a seed on a model without seed support", () => {
    expect(() => checkVideoRequest(MODEL, request({ params: { seed: 42 } }))).toThrow(
      `[ai] Model ${MODEL_ID} takes no seed.\n  Remove params.seed.`
    );
  });

  it("passes a seed on a model with seed support", () => {
    const seeded = { ...MODEL, supportsSeed: true };
    expect(checkVideoRequest(seeded, request({ params: { seed: 42 } })).params).toEqual({
      seed: 42
    });
  });

  it("rejects a local video or audio ref with the refUrls hint", () => {
    const video = { path: "clip.mp4", mimeType: "video/mp4", hash: "h" };
    const audio = { path: "beat.mp3", mimeType: "audio/mpeg", hash: "h" };
    const message =
      "[ai] ark takes video and audio references by public URL only.\n  Pass them in params.refUrls.";
    expect(() => checkVideoRequest(MODEL, request({ refs: [video] }))).toThrow(message);
    expect(() => checkVideoRequest(MODEL, request({ refs: [audio] }))).toThrow(message);
  });

  it("counts image refs and asset refs against maxRefImages", () => {
    const refs = [
      ...Array.from({ length: 5 }, () => image),
      ...Array.from({ length: 4 }, () => asset)
    ];
    expect(() => checkVideoRequest(MODEL, request({ refs }))).not.toThrow();
    expect(() => checkVideoRequest(MODEL, request({ refs: [...refs, asset] }))).toThrow(
      `[ai] Model ${MODEL_ID} takes at most 9 reference images.\n  Got 10; drop some refs.`
    );
  });

  it("rejects a refUrls entry that is not a https .mp4, .mov, .mp3 or .wav URL", () => {
    for (const url of [
      "http://cdn.example/a.mp4",
      "https://cdn.example/a.gif",
      "https://cdn.example/a",
      "not a url",
      "file:///tmp/a.mp4"
    ]) {
      expect(() => checkVideoRequest(MODEL, request({ params: { refUrls: [url] } }))).toThrow(
        `[ai] ark refUrls entry "${url}" is not a https .mp4, .mov, .mp3 or .wav URL.\n  Host the file and pass its public link.`
      );
    }
  });

  it("reads the extension from the URL path, any case, ignoring the query", () => {
    const checked = checkVideoRequest(
      MODEL,
      request({
        params: { refUrls: ["https://cdn.example/A.MOV?sig=1", "https://cdn.example/b.WAV"] }
      })
    );
    expect(checked.media.map(item => item.type)).toEqual(["video_url", "audio_url"]);
  });

  it("rejects refUrls that is not a list of strings", () => {
    const message =
      '[ai] ark params.refUrls must be a list of URLs.\n  Pass refUrls: ["https://.../clip.mp4"].';
    expect(() =>
      checkVideoRequest(MODEL, request({ params: { refUrls: "https://a/b.mp4" } }))
    ).toThrow(message);
    expect(() => checkVideoRequest(MODEL, request({ params: { refUrls: [1] } }))).toThrow(message);
  });

  it("counts refUrls against maxRefVideos and maxRefAudios", () => {
    const videos = ["1", "2", "3", "4"].map(n => `https://cdn.example/${n}.mp4`);
    const audios = ["1", "2", "3", "4"].map(n => `https://cdn.example/${n}.mp3`);
    expect(() => checkVideoRequest(MODEL, request({ params: { refUrls: videos } }))).toThrow(
      `[ai] Model ${MODEL_ID} takes at most 3 reference videos.\n  Got 4; drop some refUrls.`
    );
    expect(() => checkVideoRequest(MODEL, request({ params: { refUrls: audios } }))).toThrow(
      `[ai] Model ${MODEL_ID} takes at most 3 reference audios.\n  Got 4; drop some refUrls.`
    );
  });
});

describe("readInputs", () => {
  it("reads a local image as a data URI and an asset ref as its record", async () => {
    const inputs = await readInputs(request({ image, endImage: asset, refs: [image] }));

    expect(inputs).toEqual({
      image: { kind: "image", url: LOCAL_IMAGE_DATA_URI },
      endImage: { kind: "asset", record: arkRecord() },
      refs: [{ kind: "image", url: LOCAL_IMAGE_DATA_URI }]
    });
    expect(assetRecordsOf(inputs)).toEqual([arkRecord()]);
  });

  it("reads nothing for a text-only request", async () => {
    expect(await readInputs(request())).toEqual({
      image: undefined,
      endImage: undefined,
      refs: []
    });
  });

  it("throws a two-line error for a file it cannot read", async () => {
    const missing = { path: `${temp.dir}/gone.png`, mimeType: "image/png", hash: "h" };
    await expect(readInputs(request({ image: missing }))).rejects.toThrow(
      `[ai] Cannot read ark input file "${missing.path}".\n  Check that the $ref or $file it came from still exists.`
    );
  });

  it("throws the contract error for an asset ref that is not a record", async () => {
    const broken = temp.file("broken.asset.json", new TextEncoder().encode("{}"), ASSET_MIME);
    await expect(readInputs(request({ refs: [broken] }))).rejects.toThrow(
      '[ai] Not an asset record: missing "assetId".'
    );
  });
});

describe("request predicates", () => {
  it("hasLocalImage is true for a plain image as image, endImage or ref", () => {
    expect(hasLocalImage(request({ image }))).toBe(true);
    expect(hasLocalImage(request({ image: asset, endImage: image }))).toBe(true);
    expect(hasLocalImage(request({ refs: [asset, image] }))).toBe(true);
  });

  it("hasLocalImage is false for asset refs only, or no images", () => {
    expect(hasLocalImage(request({ image: asset, refs: [asset] }))).toBe(false);
    expect(hasLocalImage(request())).toBe(false);
  });

  it("hasVideoReferenceUrl is true only when refUrls holds a video URL", () => {
    expect(
      hasVideoReferenceUrl(request({ params: { refUrls: ["https://c.example/a.mp4"] } }))
    ).toBe(true);
    expect(
      hasVideoReferenceUrl(request({ params: { refUrls: ["https://c.example/a.mp3"] } }))
    ).toBe(false);
    expect(hasVideoReferenceUrl(request({ params: { refUrls: "https://c.example/a.mp4" } }))).toBe(
      false
    );
    expect(hasVideoReferenceUrl(request())).toBe(false);
    expect(hasVideoReferenceUrl(request({ params: { refUrls: [1] } }))).toBe(false);
  });
});

describe("warnNegativeOnce", () => {
  it("logs ark:negative:ignored once per process", () => {
    const ctx = createTestCtx();

    warnNegativeOnce(ctx, request({ negative: "blur" }));
    warnNegativeOnce(ctx, request({ negative: "noise" }));

    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:negative:ignored", { model: MODEL_ID });
    expect(ctx.state.negativeWarned).toBe(true);
  });

  it("does not log for a request without negative", () => {
    const ctx = createTestCtx();
    warnNegativeOnce(ctx, request());
    warnNegativeOnce(ctx, request({ negative: "" }));
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});
