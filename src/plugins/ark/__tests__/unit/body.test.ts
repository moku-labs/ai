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
  warnNegativeOnce,
  warnRatioOnce
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
const MODEL_25_ID = "dreamina-seedance-2-5-260628";
const MODEL_25 = resolveArkModel(MODEL_25_ID, "intl");
const ALLOWED =
  "Allowed: refUrls, watermark, seed, return_last_frame, execution_expires_after, priority, omni_reference_task_type, draft, generation.";

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

/** Checks, reads and builds a request on the 2.5 row. */
async function body25Of(request: VideoRequest): Promise<unknown> {
  const checked = checkVideoRequest(MODEL_25, request);
  const inputs = await readInputs(request);
  return buildArkBody(MODEL_25, request.prompt, checked, inputs);
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
      "execution_expires_after",
      "priority",
      "omni_reference_task_type",
      "draft",
      "generation"
    ]);
  });

  it("never sends params.generation", async () => {
    const body = (await bodyOf(request({ params: { generation: 3 } }))) as Record<string, unknown>;
    expect(body).not.toHaveProperty("generation");
  });
});

describe("ratio follows the image (Seedance 2.5)", () => {
  it("leaves ratio out for 2.5 with a first frame (exact body)", async () => {
    const body = await body25Of(
      request({ model: MODEL_25_ID, prompt: "Akari lifts the lid", image, seconds: 5 })
    );
    expect(body).toEqual({
      model: MODEL_25_ID,
      content: [
        { type: "text", text: "Akari lifts the lid" },
        { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "first_frame" }
      ],
      duration: 5,
      resolution: "720p",
      generate_audio: false,
      watermark: false
    });
  });

  it("leaves ratio out for 2.5 with only a last frame", async () => {
    const body = (await body25Of(request({ model: MODEL_25_ID, endImage: image }))) as object;
    expect(body).not.toHaveProperty("ratio");
  });

  it("keeps ratio for 2.5 with reference images only, and for 2.0 with a first frame", async () => {
    const references = (await body25Of(request({ model: MODEL_25_ID, refs: [image] }))) as object;
    const first = (await bodyOf(request({ image, aspect: "16:9" }))) as object;
    expect(references).toHaveProperty("ratio", "9:16");
    expect(first).toHaveProperty("ratio", "16:9");
  });

  it("still checks an explicit aspect", () => {
    expect(() =>
      checkVideoRequest(MODEL_25, request({ model: MODEL_25_ID, image, aspect: "5:4" }))
    ).toThrow('[ai] ark ratio "5:4" is not supported.');
  });

  it("logs ark:ratio:ignored once for an explicit aspect on 2.5 with a frame", () => {
    const ctx = createTestCtx();

    warnRatioOnce(ctx, MODEL_25, request({ model: MODEL_25_ID, image, aspect: "9:16" }));
    warnRatioOnce(ctx, MODEL_25, request({ model: MODEL_25_ID, image, aspect: "16:9" }));

    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("ark:ratio:ignored", { model: MODEL_25_ID });
    expect(ctx.state.ratioWarned).toBe(true);
  });

  it("does not log when the aspect is honoured or absent", () => {
    const ctx = createTestCtx();

    warnRatioOnce(ctx, MODEL, request({ image, aspect: "9:16" }));
    warnRatioOnce(ctx, MODEL_25, request({ model: MODEL_25_ID, image }));
    warnRatioOnce(ctx, MODEL_25, request({ model: MODEL_25_ID, refs: [image], aspect: "1:1" }));

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});

describe("draft render (params.draft)", () => {
  it("builds the draft body: draft true, 480p, no ratio with a first frame", async () => {
    const body = await body25Of(
      request({
        model: MODEL_25_ID,
        prompt: "Akari lifts the lid of a cake box",
        image,
        seconds: 5,
        audio: true,
        params: { draft: true }
      })
    );
    expect(body).toEqual({
      model: MODEL_25_ID,
      content: [
        { type: "text", text: "Akari lifts the lid of a cake box" },
        { type: "image_url", image_url: { url: LOCAL_IMAGE_DATA_URI }, role: "first_frame" }
      ],
      duration: 5,
      resolution: "480p",
      generate_audio: true,
      watermark: false,
      draft: true
    });
  });

  it("uses 480p when no resolution is given, and takes an explicit 480p", () => {
    const draft = { model: MODEL_25_ID, params: { draft: true } };
    expect(checkVideoRequest(MODEL_25, request(draft))).toMatchObject({
      resolution: "480p",
      draft: true,
      params: {}
    });
    expect(checkVideoRequest(MODEL_25, request({ ...draft, resolution: "480p" })).resolution).toBe(
      "480p"
    );
  });

  it("is not a draft without params.draft", () => {
    expect(checkVideoRequest(MODEL_25, request({ model: MODEL_25_ID })).draft).toBe(false);
  });

  it("refuses a draft on a model without a draft mode", () => {
    expect(() => checkVideoRequest(MODEL, request({ params: { draft: true } }))).toThrow(
      `[ai] Model ${MODEL_ID} has no draft mode.\n  Use dreamina-seedance-2-5-260628 for drafts.`
    );
  });

  it("refuses a draft at 720p", () => {
    expect(() =>
      checkVideoRequest(
        MODEL_25,
        request({ model: MODEL_25_ID, resolution: "720p", params: { draft: true } })
      )
    ).toThrow("[ai] ark drafts are 480p only.\n  Remove input.resolution or set it to 480p.");
  });

  it("refuses a params.draft other than true", () => {
    expect(() =>
      checkVideoRequest(MODEL_25, request({ model: MODEL_25_ID, params: { draft: false } }))
    ).toThrow("[ai] ark params.draft takes only true.\n  Remove params.draft for a full render.");
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
      `[ai] Unknown ark param "cfg_scale".\n  ${ALLOWED}`
    );
  });

  it("rejects camera_fixed as an unknown param", () => {
    expect(() => checkVideoRequest(MODEL, request({ params: { camera_fixed: true } }))).toThrow(
      `[ai] Unknown ark param "camera_fixed".\n  ${ALLOWED}`
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

  it("sends omni_reference_task_type as given, for each value ark takes", async () => {
    for (const type of ["auto", "reference", "edit", "extend"]) {
      const body = await bodyOf(request({ params: { omni_reference_task_type: type } }));
      expect(body).toMatchObject({ omni_reference_task_type: type });
    }
  });

  it("leaves omni_reference_task_type out when the caller does not pass it", async () => {
    const body = await bodyOf(request({ params: { watermark: true } }));
    expect(body).not.toHaveProperty("omni_reference_task_type");
    expect(await bodyOf(request())).not.toHaveProperty("omni_reference_task_type");
  });

  it("rejects an omni_reference_task_type ark does not take", () => {
    for (const [value, shown] of [
      ["editing", "editing"],
      ["Edit", "Edit"],
      [true, "true"]
    ] as const) {
      expect(() =>
        checkVideoRequest(MODEL_25, request({ params: { omni_reference_task_type: value } }))
      ).toThrow(
        `[ai] ark params.omni_reference_task_type "${shown}" is not supported.\n  Use one of: auto, reference, edit, extend.`
      );
    }
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
