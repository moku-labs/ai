import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoFile, VideoRequest } from "../../../video/contract";
import { RetryableProviderError } from "../../errors";
import { cutString } from "../../log";
import { createVideoHandler } from "../../video/handler";
import type { TempFiles } from "./fixtures";
import {
  callsOf,
  createTempFiles,
  createTestCtx,
  initiateResponse,
  jsonResponse,
  okResponse,
  storageUrlOf,
  stubFetch,
  stubStorageFetch,
  submitResponse,
  TEST_KEY
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in JSONL request log around the video queue POST.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, appendFile: vi.fn(actual.appendFile), mkdir: vi.fn(actual.mkdir) };
});

const PROMPT = "slow push-in on the hero";

let temp: TempFiles;
let image: VideoFile;
let refs: VideoFile[];
let dir: string;
let file: string;

beforeAll(() => {
  temp = createTempFiles();
  image = temp.file("key.png", new Uint8Array([1, 2, 3]), "image/png", "1".repeat(64));
  refs = [2, 3].map(n =>
    temp.file(`ref${n}.png`, new Uint8Array([n]), "image/png", String(n).repeat(64))
  );
});

afterAll(() => {
  temp.cleanup();
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "moku-fal-video-log-"));
  file = path.join(dir, "logs", "fal.jsonl");
  vi.mocked(appendFile).mockClear();
  vi.mocked(mkdir).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** A video request with the keyframe. */
function videoRequest(overrides: Partial<VideoRequest> = {}): VideoRequest {
  return { model: "minimax-h3", prompt: PROMPT, image, ...overrides };
}

/** Every line of the log file, parsed. */
function linesOf(logFile: string): Record<string, unknown>[] {
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("video request log", () => {
  it("writes one line for a video submit: task, model, endpoint, requestId, cut URLs", async () => {
    stubFetch(initiateResponse(1), okResponse(), submitResponse("req-1"));
    const ctx = createTestCtx({ config: { requestLog: file } });

    const { jobId } = await createVideoHandler(ctx).submit(videoRequest({ seconds: 6 }), {});

    expect(JSON.parse(jobId)).toMatchObject({ requestId: "req-1" });
    const lines = linesOf(file);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      task: "video",
      model: "minimax-h3",
      endpoint: "minimax/h3/image-to-video",
      requestId: "req-1",
      prompt: PROMPT,
      body: { image_url: "cdn.fal.test/…/1", duration: 6 }
    });
    expect(line?.body).not.toHaveProperty("prompt");
    expect(ctx.log.info).toHaveBeenCalledWith("fal:video:submitted", {
      model: "minimax-h3",
      endpoint: "minimax/h3/image-to-video",
      requestId: "req-1"
    });
  });

  it("never logs the key, a header or a full URL", async () => {
    stubFetch(initiateResponse(1), okResponse(), submitResponse("req-1"));
    const ctx = createTestCtx({ config: { requestLog: file } });

    await createVideoHandler(ctx).submit(videoRequest(), {});

    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("https://");
  });

  it("cuts a data URI to its MIME type and length", async () => {
    stubFetch(submitResponse("req-2"));
    const ctx = createTestCtx({ config: { requestLog: file, upload: "data-uri" } });

    await createVideoHandler(ctx).submit(videoRequest(), {});

    const [line] = linesOf(file);
    expect(line?.body).toMatchObject({ image_url: "data:image/png;26" });
    expect(readFileSync(file, "utf8")).not.toContain("base64");
  });

  it("names image_urls by their files when the first frame leads them", async () => {
    stubStorageFetch(submitResponse("req-3"));
    const ctx = createTestCtx({ config: { requestLog: file } });

    await createVideoHandler(ctx).submit(
      videoRequest({ model: "seedance-2.0-ref", refs: [refs[0] as VideoFile] }),
      {}
    );

    const [line] = linesOf(file);
    expect(line).toMatchObject({ task: "video", model: "seedance-2.0-ref", requestId: "req-3" });
    expect(line?.body).toMatchObject({ image_urls: ["key.png", "ref2.png"] });
  });

  it("names image_urls by the image refs when they carry the refs only", async () => {
    stubStorageFetch(submitResponse("req-4"));
    const ctx = createTestCtx({ config: { requestLog: file } });

    await createVideoHandler(ctx).submit(videoRequest({ model: "kling-o3-ref", refs }), {});

    const [line] = linesOf(file);
    expect(line?.body).toMatchObject({
      start_image_url: cutString(storageUrlOf(image)),
      image_urls: ["ref2.png", "ref3.png"]
    });
  });

  it("writes one line with the redacted error for a failed submit, then rethrows", async () => {
    stubFetch(
      initiateResponse(1),
      okResponse(),
      jsonResponse(503, { detail: "secret upstream detail" })
    );
    const ctx = createTestCtx({ config: { requestLog: file } });

    await expect(createVideoHandler(ctx).submit(videoRequest(), {})).rejects.toBeInstanceOf(
      RetryableProviderError
    );

    const lines = linesOf(file);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      task: "video",
      model: "minimax-h3",
      endpoint: "minimax/h3/image-to-video",
      error: { errorType: "retryable", status: 503 }
    });
    expect(line).not.toHaveProperty("requestId");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("secret upstream detail");
    expect(text).not.toContain(TEST_KEY);
  });

  it('writes nothing with requestLog "" (the default): same fetches, same log calls', async () => {
    const fetchMock = stubFetch(initiateResponse(1), okResponse(), submitResponse("req-1"));
    const ctx = createTestCtx();

    await createVideoHandler(ctx).submit(videoRequest(), {});

    expect(appendFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(callsOf(fetchMock)).toHaveLength(3);
    expect(ctx.log.info).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it('writes nothing for a failed submit with requestLog "" and throws the same error', async () => {
    stubFetch(initiateResponse(1), okResponse(), jsonResponse(503, {}));
    const ctx = createTestCtx();

    await expect(createVideoHandler(ctx).submit(videoRequest(), {})).rejects.toBeInstanceOf(
      RetryableProviderError
    );

    expect(appendFile).not.toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});
