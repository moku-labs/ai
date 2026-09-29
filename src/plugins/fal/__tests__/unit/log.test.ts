import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestLogEntry } from "../../log";
import { createRequestLog, cutString, withRequestLog } from "../../log";
import { TerminalProviderError } from "../../types";
import { createTestCtx } from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Opt-in JSONL request log: line shape, redaction, write failures.
// ─────────────────────────────────────────────────────────────────────────────

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "moku-fal-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every line of the log file, parsed. */
function linesOf(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

const FACE = { path: "/series/s01/face.png", mimeType: "image/png", hash: "a".repeat(64) };
const PLATE = { path: "/series/s01/plate.jpg", mimeType: "image/jpeg", hash: "b".repeat(64) };

const IMAGE_ENTRY: RequestLogEntry = {
  task: "image",
  model: "gpt-image-2.5",
  endpoint: "openai/gpt-image-2.5/sunburst/edit",
  prompt: "hero shot",
  body: {
    prompt: "hero shot",
    image_size: "portrait_16_9",
    num_images: 1,
    image_urls: ["https://v3.fal.media/files/x/face.png?sig=1", "data:image/jpeg;base64,AAAA"]
  },
  files: [FACE, PLATE]
};

describe("createRequestLog", () => {
  it('is off when config.requestLog is "" (the default)', () => {
    expect(createRequestLog(createTestCtx({ config: { requestLog: "" } }))).toBeUndefined();
  });

  it("appends one line per request: at, task, model, endpoint, requestId, prompt, body", async () => {
    const file = path.join(dir, "nested", "deeper", "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));

    await log?.write(IMAGE_ENTRY, { requestId: "req-1" });
    await log?.write({ ...IMAGE_ENTRY, prompt: "second" }, { requestId: "req-2" });

    const lines = linesOf(file);
    expect(lines).toHaveLength(2);
    const [first] = lines;
    expect(Object.keys(first ?? {})).toEqual([
      "at",
      "task",
      "model",
      "endpoint",
      "requestId",
      "prompt",
      "body"
    ]);
    expect(Number.isNaN(Date.parse(String(first?.at)))).toBe(false);
    expect(first).toMatchObject({
      task: "image",
      model: "gpt-image-2.5",
      endpoint: "openai/gpt-image-2.5/sunburst/edit",
      requestId: "req-1",
      prompt: "hero shot",
      body: { image_size: "portrait_16_9", num_images: 1, image_urls: ["face.png", "plate.jpg"] }
    });
    expect(first?.body).not.toHaveProperty("prompt");
  });

  it("logs the ref URL count when it does not match the files", async () => {
    const file = path.join(dir, "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));

    await log?.write({ ...IMAGE_ENTRY, files: [FACE] }, { requestId: "req-1" });

    expect(linesOf(file)[0]?.body).toMatchObject({ image_urls: { count: 2 } });
  });

  it("cuts URLs and data URIs anywhere in the body", async () => {
    const file = path.join(dir, "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));
    const entry: RequestLogEntry = {
      task: "video",
      model: "minimax-h3",
      endpoint: "minimax/h3/image-to-video",
      prompt: "push-in",
      body: {
        prompt: "push-in",
        image_url: "https://v3.fal.media/files/abc/key.png?token=secret",
        // eslint-disable-next-line unicorn/no-null -- a JSON body may carry null
        nested: { list: ["data:audio/mpeg;base64,QUJD", 3, true, null] }
      },
      files: []
    };

    await log?.write(entry, { requestId: "req-3" });

    expect(linesOf(file)[0]?.body).toEqual({
      image_url: "v3.fal.media/…/key.png",
      // eslint-disable-next-line unicorn/no-null -- JSON null is logged as JSON null
      nested: { list: ["data:audio/mpeg;27", 3, true, null] }
    });
  });

  it("drops the chat messages and logs their image_url parts as file names", async () => {
    const file = path.join(dir, "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));
    const entry: RequestLogEntry = {
      task: "prompt-gen",
      model: "anthropic/claude-opus-5.5",
      endpoint: "openrouter/router/openai/v1/chat/completions",
      prompt: "describe",
      body: {
        model: "anthropic/claude-opus-5.5",
        messages: [
          { role: "system", content: "be brief" },
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: "https://v3.fal.media/files/f/face.png" } }
            ]
          }
        ],
        max_tokens: 32_000
      },
      files: [FACE]
    };

    await log?.write(entry, { requestId: "gen-1" });

    const [line] = linesOf(file);
    expect(line?.body).toEqual({
      model: "anthropic/claude-opus-5.5",
      max_tokens: 32_000,
      image_urls: ["face.png"]
    });
    expect(JSON.stringify(line)).not.toContain("be brief");
  });

  it("logs a failed request as its redacted error class, never its text", async () => {
    const file = path.join(dir, "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));

    await log?.write(IMAGE_ENTRY, {
      error: new TerminalProviderError("[ai] fal rejected the request (HTTP 422): secret", 422)
    });

    const [line] = linesOf(file);
    expect(line?.error).toEqual({ errorType: "terminal", status: 422 });
    expect(line).not.toHaveProperty("requestId");
    expect(JSON.stringify(line)).not.toContain("secret");
  });

  it("warns fal:request-log:failed once and never throws when the file cannot be written", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const file = path.join(blocker, "fal.jsonl");
    const ctx = createTestCtx({ config: { requestLog: file } });
    const log = createRequestLog(ctx);

    await expect(log?.write(IMAGE_ENTRY, { requestId: "req-1" })).resolves.toBeUndefined();
    await expect(log?.write(IMAGE_ENTRY, { requestId: "req-2" })).resolves.toBeUndefined();

    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith("fal:request-log:failed", {
      path: file,
      reason: expect.any(String)
    });
  });

  it("warns once per plugin state, also across two handlers' logs", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const ctx = createTestCtx({ config: { requestLog: path.join(blocker, "fal.jsonl") } });

    await createRequestLog(ctx)?.write(IMAGE_ENTRY, { requestId: "req-1" });
    await createRequestLog(ctx)?.write(IMAGE_ENTRY, { requestId: "req-2" });

    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the warn-once flag on the plugin state", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const ctx = createTestCtx({ config: { requestLog: path.join(blocker, "fal.jsonl") } });
    expect(ctx.state.requestLogWarned).toBe(false);

    await createRequestLog(ctx)?.write(IMAGE_ENTRY, { requestId: "req-1" });

    expect(ctx.state.requestLogWarned).toBe(true);
  });

  it("does not warn when the state already carries the warning", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const ctx = createTestCtx({
      config: { requestLog: path.join(blocker, "fal.jsonl") },
      state: { requestLogWarned: true }
    });

    await createRequestLog(ctx)?.write(IMAGE_ENTRY, { requestId: "req-1" });

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });
});

describe("withRequestLog", () => {
  it("writes the request id after a sent request", async () => {
    const file = path.join(dir, "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));

    const result = await withRequestLog(
      log,
      IMAGE_ENTRY,
      async () => ({ id: "r-7" }),
      sent => sent.id
    );

    expect(result).toEqual({ id: "r-7" });
    expect(linesOf(file)[0]?.requestId).toBe("r-7");
  });

  it("writes the error before rethrowing a rejected request", async () => {
    const file = path.join(dir, "fal.jsonl");
    const log = createRequestLog(createTestCtx({ config: { requestLog: file } }));
    const error = new TerminalProviderError("[ai] fal rejected the request (HTTP 400).", 400);

    await expect(
      withRequestLog(
        log,
        IMAGE_ENTRY,
        async () => {
          throw error;
        },
        () => "never"
      )
    ).rejects.toBe(error);
    expect(linesOf(file)[0]?.error).toEqual({ errorType: "terminal", status: 400 });
  });

  it("only sends when the log is off", async () => {
    expect(
      await withRequestLog(
        undefined,
        IMAGE_ENTRY,
        async () => 5,
        () => "x"
      )
    ).toBe(5);
  });
});

describe("cutString", () => {
  it.each([
    ["https://v3.fal.media/files/abc/x.png?sig=1", "v3.fal.media/…/x.png"],
    ["https://cdn.fal.test/x.png", "cdn.fal.test/x.png"],
    ["https://cdn.fal.test/", "cdn.fal.test"],
    ["http://localhost:8080/a/b/c.mp3", "localhost:8080/…/c.mp3"],
    ["data:image/png;base64,AAAA", "data:image/png;26"],
    ["portrait_16_9", "portrait_16_9"],
    ["ftp://example.com/a/b", "ftp://example.com/a/b"]
  ])("%s → %s", (text, cut) => {
    expect(cutString(text)).toBe(cut);
  });
});
