import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptGenRequest } from "../../../promptGen/contract";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { TerminalProviderError } from "../../errors";
import { createPromptGenHandler } from "../../prompt/handler";
import {
  CODEX_401_STDERR,
  CODEX_SCHEMA_ERROR_STDERR,
  createFakeLog,
  createTestCtx,
  printStderr,
  writeAnswer,
  writeFakeCodex
} from "./fixtures";

const UNSUPPORTED =
  "[ai] Codex prompt-gen does not support messages or tools.\n  Use the fal provider for tool calling.";

/** One request per field codex cannot express. */
const TOOL_REQUESTS: Array<[string, PromptGenRequest]> = [
  ["messages", { prompt: "", messages: [{ role: "user", content: "Check shot 3." }] }],
  [
    "tools",
    {
      prompt: "p",
      tools: [{ name: "read_frame", description: "Return one frame.", inputSchema: {} }]
    }
  ],
  ["toolChoice", { prompt: "p", toolChoice: { name: "read_frame" } }]
];

/**
 * The error a synchronous call throws.
 *
 * @param call - The call expected to throw.
 * @returns The thrown value.
 */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

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

    it.each(TOOL_REQUESTS)("throws unavailable 'unsupported' for %s", (_label, request) => {
      const handler = createPromptGenHandler(createTestCtx());

      const error = thrownBy(() => handler.estimate(request));

      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect((error as PromptGenUnavailableError).reason).toBe("unsupported");
      expect((error as Error).message).toBe(UNSUPPORTED);
    });

    it("rejects tools before it reads params", () => {
      const handler = createPromptGenHandler(createTestCtx());
      const request = { prompt: "p", toolChoice: "none", params: { reasoning: "max" } } as const;

      const error = thrownBy(() => handler.estimate(request));

      expect((error as PromptGenUnavailableError).reason).toBe("unsupported");
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
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
        meta: { provider: "codex", effort: "low" }
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
        effort: "low"
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
        effort: "high",
        ignored: ["temperature"]
      });
    });

    it("puts the schema in the prompt, not --output-schema, and returns the checked JSON", async () => {
      const bin = writeFakeCodex(root, writeAnswer('{ "ok": true }'));
      const ctx = createTestCtx({ config: { bin, workDir } });
      const schema = { type: "object", properties: { ok: { type: "boolean" } } };

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "p", system: "s", params: { responseSchema: schema } },
        {}
      );

      expect(result.text).toBe('{"ok":true}');
      const args = recordedArgs();
      expect(args).not.toContain("--output-schema");
      expect(readFileSync(path.join(root, "ls.txt"), "utf8")).toBe("");
      const prompt = readFileSync(path.join(root, "args.txt"), "utf8").split("--\n").at(-1);
      expect(prompt).toBe(
        `s\n\np\n\nAnswer with one JSON value only, no prose, no code fence. It must match this JSON Schema:\n${JSON.stringify(schema)}\n`
      );
    });

    it("strips one json code fence around a schema answer", async () => {
      const bin = writeFakeCodex(root, writeAnswer('```json\n{"ok":true}\n```'));
      const ctx = createTestCtx({ config: { bin, workDir } });

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "p", params: { responseSchema: { type: "object" } } },
        {}
      );

      expect(result.text).toBe('{"ok":true}');
    });

    it("answers with the studio storyboard.line schema OpenAI strict mode rejects", async () => {
      const answer = '{"add":{},"change":[],"questions":[]}';
      const bin = writeFakeCodex(root, writeAnswer(answer));
      const ctx = createTestCtx({ config: { bin, workDir } });
      const file = path.join(import.meta.dirname, "data", "line-schema.json");
      const schema: unknown = JSON.parse(readFileSync(file, "utf8"));

      const result = await createPromptGenHandler(ctx).execute(
        { prompt: "Answer with an empty add object.", params: { responseSchema: schema } },
        {}
      );

      expect(result.text).toBe(answer);
      expect(recordedArgs()).not.toContain("--output-schema");
      expect(recordedArgs().at(-1)).toContain('"propertyNames"');
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

  describe("execute() — messages and tools", () => {
    it("ignores cacheSystem alone: same argv as without it", async () => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });
      const handler = createPromptGenHandler(ctx);

      await handler.execute({ prompt: "Say ok", system: "Be terse." }, {});
      const plainArgs = recordedArgs().filter(line => !line.includes(workDir));
      const result = await handler.execute(
        { prompt: "Say ok", system: "Be terse.", cacheSystem: true },
        {}
      );

      expect(result.text).toBe("ok");
      expect(recordedArgs().filter(line => !line.includes(workDir))).toEqual(plainArgs);
    });

    it.each(
      TOOL_REQUESTS
    )("throws unavailable 'unsupported' for %s before any temp dir or spawn", async (_label, request) => {
      const bin = writeFakeCodex(root, writeAnswer("ok"));
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createPromptGenHandler(ctx)
        .execute(request, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(PromptGenUnavailableError);
      expect((error as PromptGenUnavailableError).reason).toBe("unsupported");
      expect((error as Error).message).toBe(UNSUPPORTED);
      expect(existsSync(path.join(root, "args.txt"))).toBe(false);
      expect(existsSync(workDir)).toBe(false);
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
        "[ai] Codex answer does not match params.responseSchema.\n  The answer is not valid JSON."
      );
    });

    it("throws a terminal error, not unavailable, when a schema answer is off the schema", async () => {
      const bin = writeFakeCodex(root, writeAnswer('{"ok":"yes"}'));
      const ctx = createTestCtx({ config: { bin, workDir } });
      const schema = { type: "object", properties: { ok: { type: "boolean" } } };

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p", params: { responseSchema: schema } }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect(error).not.toBeInstanceOf(PromptGenUnavailableError);
      expect((error as Error).message).toMatch(
        /^\[ai] Codex answer does not match params\.responseSchema\.\n {2}ok: /
      );
      expect(readdirSync(workDir)).toEqual([]);
    });

    it("throws a terminal error with the API message for an invalid_json_schema 400", async () => {
      const bin = writeFakeCodex(root, `${printStderr(CODEX_SCHEMA_ERROR_STDERR)}\nexit 1`);
      const ctx = createTestCtx({ config: { bin, workDir } });

      const error = await createPromptGenHandler(ctx)
        .execute({ prompt: "p" }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as Error).message).toContain(": Invalid schema for response_format");
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
