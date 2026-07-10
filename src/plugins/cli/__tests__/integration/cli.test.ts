import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { composePlugin } from "../../../compose";
import { promptGenPlugin } from "../../../promptGen";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import type { ExecutableHandler } from "../../../runner/types";
import { cliPlugin } from "../../index";
import { EXIT_CODES } from "../../types";

/** A fake `voiceover`/`fake` handler that always succeeds with a fixed cost. */
function createFakeVoiceoverHandler(): ExecutableHandler {
  return {
    estimate: (): { usd: number } => ({ usd: 0.1 }),
    execute: async (): Promise<{ body: Uint8Array; mimeType: string; costUsd: number }> => ({
      body: new TextEncoder().encode("artifact"),
      mimeType: "text/plain",
      costUsd: 0.1
    })
  };
}

/** A fixture plugin that registers a fake `voiceover`/`fake` handler during `onInit`. */
function createFakeVoiceoverProviderPlugin() {
  return createPlugin("fakeVoiceoverProvider", {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("voiceover", "fake", createFakeVoiceoverHandler());
    }
  });
}

describe("cli plugin integration", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-integration-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Assembles a fresh framework wiring every M0 plugin plus the fake voiceover provider. */
  function buildFramework() {
    return createCore(coreConfig, {
      plugins: [
        registryPlugin,
        buildfilePlugin,
        promptGenPlugin,
        runnerPlugin,
        composePlugin,
        createFakeVoiceoverProviderPlugin(),
        cliPlugin
      ],
      pluginConfigs: {
        journal: { path: path.join(tempDir, "journal.db") },
        store: { dir: path.join(tempDir, "store") }
      }
    });
  }

  it("new -> validate -> run --dry-run: files created, exit codes correct, no process.exit called", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const exitSpy = process.exit;
    let processExitCalled = false;
    // biome-ignore lint/suspicious/noExplicitAny: swapping process.exit for the duration of this assertion
    (process as any).exit = (): never => {
      processExitCalled = true;
      throw new Error("process.exit must never be called by dispatch()");
    };

    try {
      const newCode = await app.cli.dispatch(["new", "demo"]);
      expect(newCode).toBe(EXIT_CODES.ok);
      const buildText = await readFile(path.join(tempDir, "demo.moku.yaml"), "utf8");
      expect(buildText).toContain('name: "demo"');

      const validateCode = await app.cli.dispatch(["validate"]);
      expect(validateCode).toBe(EXIT_CODES.ok);

      // Dry-run must render its estimate summary, not just exit 0 — the real
      // runner never emits stream events for a dry run (regression guard).
      const renderedLines: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((line: unknown) => renderedLines.push(String(line)));
      let runCode: number;
      let rendered: string;
      try {
        runCode = await app.cli.dispatch(["run", "--dry-run"]);
        rendered = renderedLines.join("\n");
      } finally {
        logSpy.mockRestore();
      }
      expect(runCode).toBe(EXIT_CODES.ok);
      expect(rendered).toContain("item(s) planned");
      expect(rendered).toContain("estimate $");

      expect(processExitCalled).toBe(false);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restoring process.exit
      (process as any).exit = exitSpy;
      await app.stop();
    }
  });

  it("new refuses to overwrite an existing build file", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    await app.cli.dispatch(["new", "demo"]);
    const secondCode = await app.cli.dispatch(["new", "demo"]);

    expect(secondCode).toBe(EXIT_CODES.failure);

    await app.stop();
  });

  it("status renders totals after a seeded (non-dry-run) run completes", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const buildFileText = [
      "version: 1",
      'name: "seeded"',
      "items:",
      "  - task: voiceover",
      "    provider: fake",
      "    input:",
      '      text: "hello"',
      '      voice: "en-US-1"',
      ""
    ].join("\n");
    await writeFile(path.join(tempDir, "seeded.moku.yaml"), buildFileText, "utf8");

    // Seed a completed run directly through the runner (bypassing "moku
    // run") so its runId is known — a finished run is no longer
    // `latestResumableRun()` (only active/paused/budget-stopped qualify), so
    // `moku status` with no positional cannot resolve it implicitly; the
    // real CLI usage here is `moku status <runId>`.
    const seededResult = await app.runner.run({ files: "seeded.moku.yaml" });
    expect(seededResult.status).toBe("done");

    const statusCode = await app.cli.dispatch(["status", seededResult.runId]);
    expect(statusCode).toBe(EXIT_CODES.ok);

    const report = app.runner.status(seededResult.runId);
    expect(report.totals.done).toBe(1);
    expect(report.totals.spendUsd).toBeCloseTo(0.1);

    await app.stop();
  });

  it("commands() exposes the same six-command tree outside dispatch", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const tree = app.cli.commands();
    expect(tree.commands.map(command => command.name)).toEqual([
      "new",
      "validate",
      "estimate",
      "run",
      "status",
      "compose"
    ]);

    await app.stop();
  });
});
