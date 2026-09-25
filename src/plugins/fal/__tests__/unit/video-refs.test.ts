import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { resolveFalModel } from "../../models";
import { createVideoHandler, splitReferences } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  jsonBodyOf,
  pngHeader,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  submitResponse
} from "./fixtures";

const SECOND_LINE = "\n  Remove refs from input.refs, or use a model that takes more.";

let temp: TempFiles;
let image: VideoFile;
let face: VideoFile;
let voice: VideoFile;
let tail: VideoFile;
let pan: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", pngHeader(64, 64), "image/png", "1".repeat(64));
  face = temp.file("face.png", new Uint8Array([2]), "image/png", "2".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "3".repeat(64));
  tail = temp.file("tail.mp4", new Uint8Array([4]), "video/mp4", "4".repeat(64));
  pan = temp.file("pan.webm", new Uint8Array([5]), "video/webm", "5".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The error message of submitting `request`, with the fetch mock it ran against. */
async function rejected(
  request: VideoRequest
): Promise<{ message: string; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch();
  const error = await createVideoHandler(createTestCtx())
    .submit(request, {})
    .catch((error_: unknown) => error_);
  return { message: (error as Error).message, fetchMock };
}

describe("splitReferences — video refs", () => {
  it("splits refs into images, audio and videos by MIME type, in request order", () => {
    const split = splitReferences(resolveFalModel("minimax-h3-max-ref"), [tail, face, voice, pan]);
    expect(split).toEqual({ images: [face], audio: [voice], videos: [tail, pan] });
  });

  it("does not count a video ref against the image limit", () => {
    const eight = Array.from({ length: 8 }, () => face);
    const split = splitReferences(resolveFalModel("minimax-h3-max-ref"), [...eight, tail]);
    expect(split.images).toHaveLength(8);
    expect(split.videos).toEqual([tail]);
  });
});

describe("video ref limits", () => {
  it("rejects a video ref on a model that takes none, before any fetch", async () => {
    const { message, fetchMock } = await rejected({
      model: "kling-o3-ref",
      prompt: "p",
      image,
      refs: [tail]
    });
    expect(message).toBe(
      `[ai] fal model "kling-o3-ref" takes no video references, got 1.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a 4th video ref on minimax-h3-max-ref", async () => {
    const { message, fetchMock } = await rejected({
      model: "minimax-h3-max-ref",
      prompt: "p",
      image,
      refs: [tail, pan, tail, pan]
    });
    expect(message).toBe(
      `[ai] fal model "minimax-h3-max-ref" takes at most 3 video references, got 4.${SECOND_LINE}`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an 11th video ref on seedance-2.5-ref", async () => {
    const { message } = await rejected({
      model: "seedance-2.5-ref",
      prompt: "p",
      image,
      refs: Array.from({ length: 11 }, () => tail)
    });
    expect(message).toBe(
      `[ai] fal model "seedance-2.5-ref" takes at most 10 video references, got 11.${SECOND_LINE}`
    );
  });
});

describe("submit with video refs", () => {
  it("uploads video refs and posts them as reference_video_urls to minimax-h3-max-ref", async () => {
    const fetchMock = stubStorageFetch(submitResponse());

    await createVideoHandler(createTestCtx()).submit(
      { model: "minimax-h3-max-ref", prompt: "p", image, refs: [face, voice, tail] },
      {}
    );

    const calls = callsOf(fetchMock);
    const submitCall = calls.find(call => call.url.endsWith("/h3-max/reference-to-video"));
    const body = jsonBodyOf(submitCall);
    expect(body.reference_image_urls).toEqual([storageUrlOf(image), storageUrlOf(face)]);
    expect(body.reference_audio_urls).toEqual([storageUrlOf(voice)]);
    expect(body.reference_video_urls).toEqual([storageUrlOf(tail)]);
    const initiates = calls.filter(call => call.method === "POST" && call !== submitCall);
    expect(initiates.map(call => jsonBodyOf(call))).toContainEqual({
      file_name: `${"4".repeat(16)}.mp4`,
      content_type: "video/mp4"
    });
  });

  it("posts video refs as video_urls to seedance-2.5-ref", async () => {
    const fetchMock = stubFetch(submitResponse());

    await createVideoHandler(createTestCtx({ config: { upload: "data-uri" } })).submit(
      { model: "seedance-2.5-ref", prompt: "p", image, refs: [pan] },
      {}
    );

    const body = jsonBodyOf(callsOf(fetchMock)[0]);
    expect(body.image_urls).toEqual([expect.stringMatching(/^data:image\/png;base64,/)]);
    expect(body.video_urls).toEqual([expect.stringMatching(/^data:video\/webm;base64,/)]);
  });

  it("prices a video ref like a worst-case image on minimax-h3-max-ref", () => {
    const handler = createVideoHandler(createTestCtx());
    const request: VideoRequest = { model: "minimax-h3-max-ref", prompt: "p", image };

    expect(handler.estimate(request).usd).toBe(0.4);
    // 1024 (square first frame) + 2 x 2560 (videos) = 6144 tokens, 2048 over the 4096 included.
    expect(handler.estimate({ ...request, refs: [tail, pan] }).usd).toBe(0.440_96);
  });
});
