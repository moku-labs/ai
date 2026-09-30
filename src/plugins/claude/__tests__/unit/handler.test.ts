import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { TerminalProviderError } from "../../errors";
import { createPromptGenHandler } from "../../prompt/handler";
import {
  claudeJson,
  createFakeLog,
  createTestCtx,
  NOT_LOGGED_IN_STDOUT,
  printStdout,
  SUCCESS_STDOUT,
  writeFakeClaude
} from "./fixtures";

const SCORE_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" } },
  required: ["score"]
};

describe("createPromptGenHandler", () => {
  let root: string;
  let work: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-claude-handler-"));
    work = path.join(root, "work");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Lines of the argv the fake claude was called with.
   *
   * @returns The recorded argv.
   */
  function recordedArgs(): string[] {
    return readFileSync(path.join(root, "args.txt"), "utf8").split("\n").slice(0, -1);
  }

  describe("estimate", () => {
    it("is always $0", () => {
      const handler = createPromptGenHandler(createTestCtx());

      expect(handler.estimate({ prompt: "p", model: "anthropic/claude-opus-5.5" })).toEqual({
        usd: 0
      });
    });

    it("validates params", () => {
      const handler = createPromptGenHandler(createTestCtx());

      expect(() => handler.estimate({ prompt: "p", params: { reasoning: "max" } })).toThrow(
        "params.reasoning must be off, low, medium or high"
      );
    });
  });

  describe("execute", () => {
    it("answers at $0 with the list price, usage and mapped model in meta", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const log = createFakeLog();
      const handler = createPromptGenHandler(
        createTestCtx({ config: { bin, workDir: work }, log })
      );

      const result = await handler.execute(
        { prompt: "Say ok.", model: "anthropic/claude-opus-5.5", temperature: 0.2 },
        {}
      );

      expect(result).toEqual({
        text: "ok",
        costUsd: 0,
        meta: {
          provider: "claude",
          model: "claude-opus-5-5",
          modelRequested: "anthropic/claude-opus-5.5",
          listCostUsd: 0.114_22,
          usage: { inputTokens: 12, outputTokens: 3 },
          ignored: ["temperature"]
        }
      });
      expect(readFileSync(path.join(root, "stdin.txt"), "utf8")).toBe("Say ok.");
      expect(recordedArgs()).toContain("claude-opus-5-5");
      expect(log.info).toHaveBeenCalledWith("claude:prompt-gen:done", {
        model: "claude-opus-5-5",
        chars: 2
      });
      expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain("Say ok.");
    });

    it("omits model and modelRequested when no model is requested or mapped", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const result = await handler.execute({ prompt: "p", system: "Be brief." }, {});

      expect(result.meta).toEqual({
        provider: "claude",
        listCostUsd: 0.114_22,
        usage: { inputTokens: 12, outputTokens: 3 }
      });
      expect(recordedArgs()).not.toContain("--model");
      expect(recordedArgs()).toContain("Be brief.");
    });

    it("keeps the requested id even when it passes through unchanged", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const result = await handler.execute({ prompt: "p", model: "opus" }, {});

      expect(result.meta).toMatchObject({ model: "opus", modelRequested: "opus" });
    });

    it("keeps the requested id when a foreign model falls back to textModel", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(
        createTestCtx({ config: { bin, workDir: work, textModel: "sonnet" } })
      );

      const result = await handler.execute(
        { prompt: "p", model: "openai/gpt-6-sol", params: { reasoning: "off" } },
        {}
      );

      expect(result.meta).toMatchObject({ model: "sonnet", modelRequested: "openai/gpt-6-sol" });
      expect(recordedArgs().slice(-4)).toEqual(["--model", "sonnet", "--effort", "low"]);
    });

    it("records the --effort it passed in meta.effort", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const result = await handler.execute({ prompt: "p", params: { reasoning: "off" } }, {});

      expect(result.meta).toMatchObject({ effort: "low" });
      expect(recordedArgs().slice(-2)).toEqual(["--effort", "low"]);
    });

    it("leaves meta.effort out when no reasoning is requested", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const result = await handler.execute({ prompt: "p" }, {});

      expect(result.meta).not.toHaveProperty("effort");
      expect(recordedArgs()).not.toContain("--effort");
    });

    it("copies images into the call dir and asks for them with the Read tool", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const frame = path.join(root, "frame");
      writeFileSync(frame, "bytes");
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      await handler.execute(
        {
          prompt: "Score this frame.",
          params: { images: { path: frame, mimeType: "image/jpeg", hash: "h" } }
        },
        {}
      );

      expect(readFileSync(path.join(root, "ls.txt"), "utf8").trim()).toBe("image-1.jpg");
      expect(readFileSync(path.join(root, "stdin.txt"), "utf8")).toContain("./image-1.jpg.");
      expect(recordedArgs()).toContain("--allowedTools");
    });

    it("passes the schema as --json-schema, not in the prompt, and returns structured_output", async () => {
      const answer = claudeJson({ result: '{"score": 7}', structured_output: { score: 7 } });
      const bin = writeFakeClaude(root, printStdout(answer));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const result = await handler.execute(
        { prompt: "Score.", params: { responseSchema: SCORE_SCHEMA } },
        {}
      );

      expect(result.text).toBe('{"score":7}');
      expect(recordedArgs().slice(-2)).toEqual(["--json-schema", JSON.stringify(SCORE_SCHEMA)]);
      expect(readFileSync(path.join(root, "stdin.txt"), "utf8")).toBe("Score.");
    });

    it("falls back to the validated answer text when there is no structured_output", async () => {
      const answer = claudeJson({ result: '```json\n{ "score": 7 }\n```' });
      const bin = writeFakeClaude(root, printStdout(answer));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const result = await handler.execute(
        { prompt: "Score.", params: { responseSchema: SCORE_SCHEMA } },
        {}
      );

      expect(result.text).toBe('{"score":7}');
    });

    it("throws terminal, never unavailable, on an off-schema answer and removes the dir", async () => {
      const bin = writeFakeClaude(root, printStdout(claudeJson({ result: '{"score":"high"}' })));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const error = await handler
        .execute({ prompt: "Score.", params: { responseSchema: SCORE_SCHEMA } }, {})
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect(error).not.toBeInstanceOf(PromptGenUnavailableError);
      expect(readdirSync(work)).toEqual([]);
    });

    it("throws unavailable 'auth' on the not-logged-in sample and removes the dir", async () => {
      const bin = writeFakeClaude(root, `${printStdout(NOT_LOGGED_IN_STDOUT)}\nexit 1`);
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      const error = await handler.execute({ prompt: "p" }, {}).catch((error_: unknown) => error_);

      expect((error as PromptGenUnavailableError).reason).toBe("auth");
      expect(readdirSync(work)).toEqual([]);
    });

    it("throws unavailable 'missing' when the bin does not exist", async () => {
      const handler = createPromptGenHandler(
        createTestCtx({ config: { bin: path.join(root, "nope"), workDir: work } })
      );

      const error = await handler.execute({ prompt: "p" }, {}).catch((error_: unknown) => error_);

      expect((error as PromptGenUnavailableError).reason).toBe("missing");
      expect(readdirSync(work)).toEqual([]);
    });

    it("rejects bad params before spawning", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: work } }));

      await expect(handler.execute({ prompt: "p", params: { images: ["x"] } }, {})).rejects.toThrow(
        "params.images must be image files"
      );
      expect(existsSync(path.join(root, "args.txt"))).toBe(false);
    });

    it("runs in a moku-claude-* dir under os.tmpdir() when workDir is empty, then removes it", async () => {
      const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));
      const handler = createPromptGenHandler(createTestCtx({ config: { bin, workDir: "" } }));

      await handler.execute({ prompt: "p" }, {});

      const callDir = readFileSync(path.join(root, "cwd.txt"), "utf8").trim();
      expect(path.dirname(callDir)).toBe(realpathSync(tmpdir()));
      expect(path.basename(callDir)).toMatch(/^moku-claude-/);
      expect(existsSync(callDir)).toBe(false);
    });
  });
});
