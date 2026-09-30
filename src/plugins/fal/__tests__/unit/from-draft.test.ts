import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import type { EstimateRequest } from "../../types";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import { createTempFiles, createTestCtx, stubFetch } from "./fixtures";

const MODEL = "seedance-2.5";

const DRAFT_REFUSAL =
  "[ai] fal takes no draft render (input.fromDraft).\n  Use provider ark with a Seedance 2.5 draft.";

let temp: TempFiles;
let start: VideoFile;
let draft: VideoFile;

beforeAll(() => {
  temp = createTempFiles();
  start = temp.file("start.png", new Uint8Array([1, 2, 3]), "image/png", "1".repeat(64));
  draft = temp.file("draft.mp4", new Uint8Array([4, 5, 6]), "video/mp4", "4".repeat(64));
});

afterAll(() => {
  temp.cleanup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fal video — fromDraft", () => {
  it("estimate refuses a resolved draft", () => {
    const request: VideoRequest = { model: MODEL, prompt: "", image: start, fromDraft: draft };

    expect(() => createVideoHandler(createTestCtx()).estimate(request)).toThrow(DRAFT_REFUSAL);
  });

  it("estimate refuses a draft that is still an unresolved $ref", () => {
    const request: EstimateRequest = {
      model: MODEL,
      prompt: "",
      image: { $ref: "shot.start" },
      fromDraft: { $ref: "shot.draft" }
    };
    const handler: { estimate(request: EstimateRequest): { usd: number } } = createVideoHandler(
      createTestCtx()
    );

    expect(() => handler.estimate(request)).toThrow(DRAFT_REFUSAL);
  });

  it("submit refuses a draft with a plain error before any upload or call", async () => {
    const fetchMock = stubFetch();
    const request: VideoRequest = { model: MODEL, prompt: "", image: start, fromDraft: draft };

    const error = await createVideoHandler(createTestCtx())
      .submit(request, {})
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(DRAFT_REFUSAL);
    expect((error as Error).name).toBe("Error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
