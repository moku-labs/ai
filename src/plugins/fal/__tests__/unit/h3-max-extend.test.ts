import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { buildFalBody, resolveFalModel } from "../../models";
import { videoCostUsd } from "../../prices";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  jsonBodyOf,
  stubFetch,
  submitResponse
} from "./fixtures";

const MODEL = "minimax-h3-max-extend";
const SECOND_LINE = "\n  Remove refs from input.refs, or use a model that takes more.";

let temp: TempFiles;
let source: VideoFile;
let face: VideoFile;
let voice: VideoFile;
let tail: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  source = temp.file("take.mp4", new Uint8Array([1]), "video/mp4", "1".repeat(64));
  face = temp.file("face.png", new Uint8Array([2]), "image/png", "2".repeat(64));
  voice = temp.file("voice.mp3", new Uint8Array([3]), "audio/mpeg", "3".repeat(64));
  tail = temp.file("tail.mp4", new Uint8Array([4]), "video/mp4", "4".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Submits `request` in data-URI mode and returns the POSTed URL and body. */
async function submitted(
  request: VideoRequest
): Promise<{ url: string; body: Record<string, unknown> }> {
  const fetchMock = stubFetch(submitResponse());
  await createVideoHandler(createTestCtx({ config: { upload: "data-uri" } })).submit(request, {});
  const call = callsOf(fetchMock)[0];
  return { url: call?.url ?? "", body: jsonBodyOf(call) };
}

/** The rejection message of submitting `request`, with the fetch mock it ran against. */
async function rejected(
  request: VideoRequest
): Promise<{ message: string; fetchMock: ReturnType<typeof vi.fn> }> {
  const fetchMock = stubFetch();
  const error = await createVideoHandler(createTestCtx())
    .submit(request, {})
    .catch((error_: unknown) => error_);
  return { message: (error as Error).message, fetchMock };
}

/** Cost of a 5 s extend of the source clip at `resolution`. */
function cost(resolution: string): number {
  return videoCostUsd(createTestCtx(), { model: MODEL, prompt: "p", image: source, resolution });
}

describe("minimax-h3-max-extend body", () => {
  it("sends the source as video_url, continuation only, 768P, prompt expansion off", () => {
    const body = buildFalBody(
      resolveFalModel(MODEL),
      { model: MODEL, prompt: "she turns to the door" },
      { image: "u0", refs: [], audioRefs: [], videoRefs: [] }
    );
    expect(body).toEqual({
      prompt: "she turns to the door",
      video_url: "u0",
      output: "continuation",
      enable_prompt_expansion: false,
      duration: 5,
      resolution: "768P"
    });
  });

  it("sends no aspect_ratio, so the clip keeps the source's aspect", () => {
    const body = buildFalBody(
      resolveFalModel(MODEL),
      { model: MODEL, prompt: "p", aspect: "16:9" },
      { image: "u0", refs: [], audioRefs: [], videoRefs: [] }
    );
    expect(body).not.toHaveProperty("aspect_ratio");
  });

  it("uploads the source clip from input.image and posts it to the extend endpoint", async () => {
    const { url, body } = await submitted({
      model: MODEL,
      prompt: "p",
      image: source,
      seconds: 10
    });

    expect(url).toBe("https://queue.fal.run/minimax/h3-max/extend-video");
    expect(body.video_url).toMatch(/^data:video\/mp4;base64,/);
    expect(body.duration).toBe(10);
  });

  it("lets params switch output back to the source plus the new footage", () => {
    const body = buildFalBody(
      resolveFalModel(MODEL),
      { model: MODEL, prompt: "p", params: { output: "extended" } },
      { image: "u0", refs: [], audioRefs: [], videoRefs: [] }
    );
    expect(body.output).toBe("extended");
  });

  it("needs the source clip", async () => {
    const { message, fetchMock } = await rejected({ model: MODEL, prompt: "p" });
    expect(message).toBe(
      `[ai] fal model "${MODEL}" needs an image.\n  Set input.image to a $ref or $file.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["reference images", () => face],
    ["reference audio", () => voice],
    ["video references", () => tail]
  ])("takes no %s", async (kind, ref) => {
    const { message, fetchMock } = await rejected({
      model: MODEL,
      prompt: "p",
      image: source,
      refs: [ref()]
    });
    expect(message).toBe(`[ai] fal model "${MODEL}" takes no ${kind}, got 1.${SECOND_LINE}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("minimax-h3-max-extend price", () => {
  it("prices the new footage per resolution", () => {
    expect(cost("480P")).toBe(0.25);
    expect(cost("768P")).toBe(0.4);
    expect(cost("1080P")).toBe(0.8);
    expect(cost("2K")).toBe(1.6);
  });

  it("stays inside the 4096 included reference tokens for one source clip", () => {
    expect(videoCostUsd(createTestCtx(), { model: MODEL, prompt: "p", image: source })).toBe(0.4);
  });

  it("estimate and actual cost agree", () => {
    const request: VideoRequest = { model: MODEL, prompt: "p", image: source, seconds: 15 };
    const handler = createVideoHandler(createTestCtx());
    expect(handler.estimate(request).usd).toBe(videoCostUsd(createTestCtx(), request));
    expect(handler.estimate(request).usd).toBe(1.2);
  });
});
