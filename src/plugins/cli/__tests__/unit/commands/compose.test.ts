import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runComposeCommand } from "../../../commands/compose";
import { EXIT_CODES } from "../../../types";
import { createFakeCommandContext } from "../fixtures";

describe("runComposeCommand", () => {
  it("returns the usage exit code when the prompt argument is missing", async () => {
    const { context, errorLines } = createFakeCommandContext();

    const code = await runComposeCommand(context, {}, []);

    expect(code).toBe(EXIT_CODES.usage);
    expect(errorLines.some(line => line.includes("requires a"))).toBe(true);
  });

  it("returns the usage exit code for an invalid --emit value", async () => {
    const { context } = createFakeCommandContext();

    const code = await runComposeCommand(context, { emit: "pdf" }, ["a sunset"]);

    expect(code).toBe(EXIT_CODES.usage);
  });

  it("prints the emitted text to stdout when no --out is given", async () => {
    const { context, lines } = createFakeCommandContext({
      compose: {
        compose: () =>
          Promise.resolve({
            spec: { version: 1, name: "demo", items: [] },
            text: "version: 1\nname: demo\nitems: []\n",
            costUsd: 0.001
          })
      }
    });

    const code = await runComposeCommand(context, {}, ["a sunset"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(lines.some(line => line.includes("name: demo"))).toBe(true);
  });

  describe("with --out", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-compose-"));
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("writes the emitted text to the given path", async () => {
      const outPath = path.join(tempDir, "demo.moku.yaml");
      const { context } = createFakeCommandContext({
        compose: {
          compose: () =>
            Promise.resolve({
              spec: { version: 1, name: "demo", items: [] },
              text: "version: 1\nname: demo\nitems: []\n",
              costUsd: 0.001
            })
        }
      });

      const code = await runComposeCommand(context, { out: outPath }, ["a sunset"]);

      expect(code).toBe(EXIT_CODES.ok);
      const written = await readFile(outPath, "utf8");
      expect(written).toContain("name: demo");
    });
  });

  it("maps a repair-exhausted failure to the validation exit code", async () => {
    const { context } = createFakeCommandContext({
      compose: {
        compose: () =>
          Promise.reject(
            new Error(
              "[ai] Compose could not produce a valid build file after 3 attempts.\n  Refine the prompt."
            )
          )
      }
    });

    const code = await runComposeCommand(context, {}, ["a sunset"]);

    expect(code).toBe(EXIT_CODES.validation);
  });

  it("maps a generic compose failure to the runtime-failure exit code", async () => {
    const { context } = createFakeCommandContext({
      compose: {
        compose: () => Promise.reject(new Error("network unreachable"))
      }
    });

    const code = await runComposeCommand(context, {}, ["a sunset"]);

    expect(code).toBe(EXIT_CODES.failure);
  });

  it("runs compose through context.runWithAbort", async () => {
    let wasCalled = false;
    const { context } = createFakeCommandContext({
      runWithAbort: async action => {
        wasCalled = true;
        return action(new AbortController().signal);
      }
    });

    await runComposeCommand(context, {}, ["a sunset"]);

    expect(wasCalled).toBe(true);
  });
});
