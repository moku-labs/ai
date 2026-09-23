import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageHandler } from "../../image/handler";
import { RetryableProviderError, TerminalProviderError } from "../../types";
import { createFakeLog, createTestCtx, WRITE_OUTPUT_PNG, writeFakeCodex } from "./fixtures";

/** The eight PNG signature bytes the fake codex writes. */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("createImageHandler", () => {
  let root: string;
  let workDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-handler-"));
    workDir = path.join(root, "work");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("estimate()", () => {
    it("returns the explicit zero price of the default model", () => {
      expect(createImageHandler(createTestCtx()).estimate({ prompt: "p" })).toEqual({ usd: 0 });
    });

    it("prices request.model over config.model", () => {
      const ctx = createTestCtx({ config: { priceOverrides: { pro: 0.25 } } });

      expect(createImageHandler(ctx).estimate({ prompt: "p", model: "pro" })).toEqual({
        usd: 0.25
      });
    });

    it("throws the pinned error for an unknown model", () => {
      const handler = createImageHandler(createTestCtx({ config: { model: "mystery" } }));

      expect(() => handler.estimate({ prompt: "p" })).toThrow(
        '[ai] No price for codex model "mystery".\n  Add it to codex priceOverrides.'
      );
    });
  });

  describe("execute() — success", () => {
    it("returns the output.png bytes, mime, price and meta, and logs without the prompt", async () => {
      const bin = writeFakeCodex(root, WRITE_OUTPUT_PNG);
      const log = createFakeLog();
      const ctx = createTestCtx({ config: { bin, workDir }, log });

      const result = await createImageHandler(ctx).execute({ prompt: "SECRET BRIEF" }, {});

      expect(result.image).toEqual(PNG_SIGNATURE);
      expect(result.mimeType).toBe("image/png");
      expect(result.costUsd).toBe(0);
      expect(result.meta).toEqual({ model: "gpt-6-astra", bytes: PNG_SIGNATURE.length });
      expect(log.info).toHaveBeenCalledWith("codex:image:done", {
        model: "gpt-6-astra",
        bytes: PNG_SIGNATURE.length
      });
      expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("SECRET BRIEF");
    });

    it("passes the model, effort, -- separator and built prompt to the CLI", async () => {
      const bin = writeFakeCodex(root, WRITE_OUTPUT_PNG);
      const ctx = createTestCtx({
        config: { bin, workDir, reasoningEffort: "medium", priceOverrides: { pro: 0 } }
      });

      await createImageHandler(ctx).execute(
        { prompt: "a cat", model: "pro", aspect: "16:9", negative: "text" },
        {}
      );

      const args = readFileSync(path.join(root, "args.txt"), "utf8");
      expect(args).toContain('exec\n-m\npro\n-c\nmodel_reasoning_effort="medium"\n');
      expect(args).toContain("--\nGenerate exactly one image");
      expect(args).toContain("a cat\nAvoid: text.\nLandscape, 1536x1024.");
    });

    it("copies refs into the temp dir with extensions and attaches them with --image", async () => {
      const bin = writeFakeCodex(root, WRITE_OUTPUT_PNG);
      const refPng = path.join(root, "store-aaa");
      const refJpg = path.join(root, "store-bbb");
      const refWebp = path.join(root, "store-ccc");
      const refOther = path.join(root, "store-ddd");
      for (const file of [refPng, refJpg, refWebp, refOther]) writeFileSync(file, "ref");
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createImageHandler(ctx).execute(
        {
          prompt: "p",
          refs: [
            { path: refPng, mimeType: "image/png", hash: "h1" },
            { path: refJpg, mimeType: "image/jpeg", hash: "h2" },
            { path: refWebp, mimeType: "image/webp", hash: "h3" },
            { path: refOther, mimeType: "image/gif", hash: "h4" }
          ]
        },
        {}
      );

      const listing = readFileSync(path.join(root, "ls.txt"), "utf8").trim().split("\n");
      expect(listing).toEqual(["ref-1.png", "ref-2.jpg", "ref-3.webp", "ref-4.png"]);
      const args = readFileSync(path.join(root, "args.txt"), "utf8");
      expect(args).toMatch(/--image\n\S+ref-1\.png\n--image\n\S+ref-2\.jpg\n/);
      expect(args).toContain("(ref-1.png, ref-2.jpg, ref-3.webp, ref-4.png)");
    });

    it("falls back to the newest non-ref image when output.png is absent", async () => {
      const bin = writeFakeCodex(root, `printf 'RIFF' > "$dir/result.webp"`);
      const ref = path.join(root, "store-ref");
      writeFileSync(ref, "ref");
      const ctx = createTestCtx({ config: { bin, workDir } });

      const result = await createImageHandler(ctx).execute(
        { prompt: "p", refs: [{ path: ref, mimeType: "image/png", hash: "h" }] },
        {}
      );

      expect(result.mimeType).toBe("image/webp");
      expect(new TextDecoder().decode(result.image)).toBe("RIFF");
    });

    it("maps a .jpeg result to image/jpeg", async () => {
      const bin = writeFakeCodex(root, `printf 'JPEG' > "$dir/out.jpeg"`);
      const ctx = createTestCtx({ config: { bin, workDir } });

      const result = await createImageHandler(ctx).execute({ prompt: "p" }, {});

      expect(result.mimeType).toBe("image/jpeg");
    });

    it("removes its temp dir afterwards", async () => {
      const bin = writeFakeCodex(root, WRITE_OUTPUT_PNG);
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createImageHandler(ctx).execute({ prompt: "p" }, {});

      expect(readdirSync(workDir)).toEqual([]);
    });
  });

  describe("execute() — failures", () => {
    it("throws the unknown-price error before spawning", async () => {
      const bin = writeFakeCodex(root, WRITE_OUTPUT_PNG);
      const ctx = createTestCtx({ config: { bin, workDir } });

      await expect(
        createImageHandler(ctx).execute({ prompt: "p", model: "mystery" }, {})
      ).rejects.toThrow('[ai] No price for codex model "mystery".');
      expect(() => readFileSync(path.join(root, "args.txt"))).toThrow();
    });

    it("throws a terminal error with the last stderr line on a non-zero exit, and cleans up", async () => {
      const bin = writeFakeCodex(root, "echo 'model not available' >&2\nexit 1");
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createImageHandler(ctx)
        .execute({ prompt: "p" }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toContain("model not available");
      expect(error).not.toHaveProperty("kind");
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("throws a terminal error when codex exits 0 without writing an image", async () => {
      const bin = writeFakeCodex(root, "exit 0");
      const ref = path.join(root, "store-ref");
      writeFileSync(ref, "ref");
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createImageHandler(ctx)
        .execute({ prompt: "p", refs: [{ path: ref, mimeType: "image/png", hash: "h" }] }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toMatch(
        /^\[ai] Codex finished without writing an image\.\n {2}\S.*\.$/
      );
      expect(error).not.toHaveProperty("kind");
    });

    it("throws a retryable timeout error and cleans up", async () => {
      const bin = writeFakeCodex(root, "exec sleep 5");
      const ctx = createTestCtx({ config: { bin, workDir, timeoutMs: 200 } });

      const error = await createImageHandler(ctx)
        .execute({ prompt: "p" }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(RetryableProviderError);
      expect((error as RetryableProviderError).kind).toBe("timeout");
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("rethrows the abort reason unchanged and cleans up", async () => {
      const bin = writeFakeCodex(root, "exec sleep 5");
      const ctx = createTestCtx({ config: { bin, workDir } });
      const controller = new AbortController();
      const reason = new DOMException("paused", "AbortError");
      setTimeout(() => controller.abort(reason), 100);

      const error = await createImageHandler(ctx)
        .execute({ prompt: "p" }, { signal: controller.signal })
        .catch((error_: unknown) => error_);

      expect(error).toBe(reason);
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("throws the terminal not-found error for a missing bin", async () => {
      const bin = path.join(root, "missing-codex");
      const ctx = createTestCtx({ config: { bin, workDir } });

      await expect(createImageHandler(ctx).execute({ prompt: "p" }, {})).rejects.toThrow(
        `[ai] Codex CLI not found: ${bin}.\n  Install codex or set codex.bin.`
      );
      expect(readdirSync(workDir)).toEqual([]);
    });
  });
});
