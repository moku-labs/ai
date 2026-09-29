import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { createPromptGenHandler } from "../../prompt/handler";
import { TerminalProviderError } from "../../types";
import {
  CODEX_401_STDERR,
  createFakeLog,
  createTestCtx,
  printStderr,
  writeAnswer,
  writeFakeCodex
} from "./fixtures";

describe("createPromptGenHandler", () => {
  let root: string;
  let workDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-prompt-"));
    workDir = path.join(root, "work");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The argv the fake codex received, one entry per line.
   *
   * @returns The recorded argv.
   */
  function recordedArgs(): string[] {
    return readFileSync(path.join(root, "args.txt"), "utf8").trimEnd().split("\n");
  }

  describe("estimate()", () => {
    it("returns zero, codex is plan-billed", () => {
      expect(createPromptGenHandler(createTestCtx()).estimate({ prompt: "p" })).toEqual({ usd: 0 });
    });

    it("validates params before answering", () => {
      const handler = createPromptGenHandler(createTestCtx());

      expect(() => handler.estimate({ prompt: "p", params: { reasoning: "max" } })).toThrow(
        "[ai] Codex params.reasoning must be off, low, medium or high."
      );
    });
  });

  describe("execute() — success", () => {
    it("returns the trimmed answer at $0 with meta, and logs without the prompt", async () => {
      const bin = writeFakeCodex(root, writeAnswer("  ok\n"));
      const log = createFakeLog();
      const ctx = createTestCtx({ config: { bin, workDir }, log });

      const result = await createPromptGenHandler(ctx).execute({ prompt: "SECRET BRIEF" }, {});

      expect(result).toEqual({
        text: "ok",
        costUsd: 0,
        meta: { provider: "codex", reasoningEffort: "low" }
      });
      expect(log.info).toHaveBeenCalledWith("codex:prompt-gen:done", {
        model: "default",
        chars: 2
      });
      expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("SECRET BRIEF");
    });

    it("runs read-only, without -m when no model maps, and puts the prompt last", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createPromptGenHandler(ctx).execute({ prompt: "Say ok" }, {});

      const args = recordedArgs();
      expect(args).not.toContain("-m");
      expect(args).toContain("read-only");
      expect(args.slice(-2)).toEqual(["--", "Say ok"]);
    });

    it("maps an OpenRouter model id and reports both ids in meta", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "p", model: "openai/gpt-6-sol" },
        {}
      );

      expect(recordedArgs().slice(0, 3)).toEqual(["exec", "-m", "gpt-6-sol"]);
      expect(result.meta).toEqual({
        provider: "codex",
        model: "gpt-6-sol",
        modelRequested: "openai/gpt-6-sol",
        reasoningEffort: "low"
      });
    });

    it("uses textModel for a foreign model id", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir, textModel: "o4-mini" } });

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "p", model: "anthropic/claude-opus-5.5" },
        {}
      );

      expect(recordedArgs().slice(0, 3)).toEqual(["exec", "-m", "o4-mini"]);
      expect(result.meta).toMatchObject({
        model: "o4-mini",
        modelRequested: "anthropic/claude-opus-5.5"
      });
    });

    it("prepends the system text and a blank line to the prompt", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createPromptGenHandler(ctx).execute({ prompt: "Say ok", system: "Be terse." }, {});

      const args = readFileSync(path.join(root, "args.txt"), "utf8");
      expect(args.endsWith("--\nBe terse.\n\nSay ok\n")).toBe(true);
    });

    it("maps params.reasoning to the effort override and notes temperature as ignored", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "p", temperature: 0.7, params: { reasoning: "high" } },
        {}
      );

      expect(recordedArgs()).toContain('model_reasoning_effort="high"');
      expect(result.meta).toEqual({
        provider: "codex",
        reasoningEffort: "high",
        ignored: ["temperature"]
      });
    });

    it("writes schema.json, passes --output-schema, and returns the JSON answer", async () => {
      const copySchema = `cp "$dir/schema.json" "${root}/schema-copy.json"`;
      const bin = writeFakeCodex(root, `${copySchema}\n${writeAnswer('{"ok":true}')}`);
      const ctx = createTestCtx({ config: { bin, workDir } });
      const schema = { type: "object", properties: { ok: { type: "boolean" } } };

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "p", params: { responseSchema: schema } },
        {}
      );

      expect(result.text).toBe('{"ok":true}');
      expect(JSON.parse(readFileSync(path.join(root, "schema-copy.json"), "utf8"))).toEqual(schema);
      const args = recordedArgs();
      expect(args[args.indexOf("--output-schema") + 1]).toMatch(/schema\.json$/);
    });

    it("copies params.images into the call dir and attaches each with --image", async () => {
      const bin = writeFakeCodex(root, writeAnswer("a cat"));
      const png = path.join(root, "store-aaa");
      const jpg = path.join(root, "store-bbb");
      writeFileSync(png, "png");
      writeFileSync(jpg, "jpg");
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createPromptGenHandler(ctx).execute(
        {
          prompt: "Describe the images.",
          params: {
            images: [
              { path: png, mimeType: "image/png", hash: "h1" },
              { path: jpg, mimeType: "image/jpeg", hash: "h2" }
            ]
          }
        },
        {}
      );

      const listing = readFileSync(path.join(root, "ls.txt"), "utf8").trim().split("\n");
      expect(listing).toEqual(["ref-1.png", "ref-2.jpg"]);
      const args = recordedArgs();
      const images = args.filter((_arg, index) => args[index - 1] === "--image");
      expect(images).toHaveLength(2);
      expect(images.every(image => path.isAbsolute(image))).toBe(true);
      expect(images.map(image => path.basename(image))).toEqual(["ref-1.png", "ref-2.jpg"]);
    });

    it("accepts a single image file in params.images", async () => {
      const bin = writeFakeCodex(root, writeAnswer("a cat"));
      const png = path.join(root, "store-aaa");
      writeFileSync(png, "png");
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createPromptGenHandler(ctx).execute(
        { prompt: "p", params: { images: { path: png, mimeType: "image/png", hash: "h1" } } },
        {}
      );

      expect(recordedArgs().filter(arg => arg === "--image")).toHaveLength(1);
    });

    it('runs in a call dir under os.tmpdir() when workDir is ""', async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir: "" } });

      await createPromptGenHandler(ctx).execute({ prompt: "p" }, {});

      const args = recordedArgs();
      const callDir = args[args.indexOf("-C") + 1] ?? "";
      expect(path.dirname(callDir)).toBe(tmpdir());
      expect(path.basename(callDir)).toMatch(/^codex-/);
      expect(existsSync(callDir)).toBe(false);
    });

    it("removes its temp dir afterwards", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      await createPromptGenHandler(ctx).execute({ prompt: "p" }, {});

      expect(readdirSync(workDir)).toEqual([]);
    });
  });

  describe("execute() — failures", () => {
    it("throws the pinned error for bad params before spawning", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      await expect(
        createPromptGenHandler(ctx).execute({ prompt: "p", params: { images: "cat.png" } }, {})
      ).rejects.toThrow("[ai] Codex params.images must be image files.");
      expect(() => readFileSync(path.join(root, "args.txt"))).toThrow();
    });

    it.each([
      ["an empty answer", writeAnswer("  \n")],
      ["no answer file", "exit 0"]
    ])("throws a terminal error for %s, and cleans up", async (_label, body) => {
      const bin = writeFakeCodex(root, body);
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p" }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toBe(
        "[ai] Codex wrote no answer.\n  Run the same codex exec by hand to see the full output."
      );
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("throws a terminal error when a schema answer is not JSON", async () => {
      const bin = writeFakeCodex(root, writeAnswer("sure, here it is"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p", params: { responseSchema: { type: "object" } } }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toBe(
        "[ai] Codex answer is not valid JSON.\n  Check params.responseSchema; codex needs a strict schema."
      );
    });

    it("returns plain text as is when no schema is set", async () => {
      const bin = writeFakeCodex(root, writeAnswer("sure, here it is"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      const result = await createPromptGenHandler(ctx).execute({ prompt: "p" }, {});

      expect(result.text).toBe("sure, here it is");
    });

    it("throws unavailable 'auth' when codex is not logged in, and cleans up", async () => {
      const bin = writeFakeCodex(root, `${printStderr(CODEX_401_STDERR)}\nexit 1`);
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p" }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect((error as PromptGenUnavailableError).reason).toBe("auth");
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("throws unavailable 'missing' for a missing bin", async () => {
      const ctx = createTestCtx({ config: { bin: path.join(root, "missing-codex"), workDir } });

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p" }, {})
        .catch((error_: unknown) => error_);

      expect((error as PromptGenUnavailableError).reason).toBe("missing");
    });

    it("rethrows the abort reason unchanged and cleans up", async () => {
      const bin = writeFakeCodex(root, "exec sleep 5");
      const ctx = createTestCtx({ config: { bin, workDir } });
      const controller = new AbortController();
      const reason = new DOMException("paused", "AbortError");
      setTimeout(() => controller.abort(reason), 100);

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p" }, { signal: controller.signal })
        .catch((error_: unknown) => error_);

      expect(error).toBe(reason);
      expect(readdirSync(workDir)).toEqual([]);
    });
  });
});
