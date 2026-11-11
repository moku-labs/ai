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
import type { ExecutableHandler, HandlerRequest } from "../../../runner/types";
import { cliPlugin } from "../../index";
import type { CallOutput } from "../../types";
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

// eslint-disable-next-line unicorn/no-null -- a usage error prints `runId: null`
const NO_RUN = null;

/** What the fake `call` handler saw: the requests it was asked to submit. */
type FakeCall = { submitted: HandlerRequest[]; handler: ExecutableHandler };

/**
 * A fake `("call", "fake")` job handler: one submit per paid call, then a done poll that echoes the
 * input as JSON at $0.5. `demo/unpriced` has no price (estimate throws); `demo/reject` fails with a 422.
 */
function createFakeCallHandler(): FakeCall {
  const submitted: HandlerRequest[] = [];
  const handler: ExecutableHandler = {
    estimate: request => {
      if (request.endpoint === "demo/unpriced") {
        throw new Error(
          '[ai] No price for fal endpoint "demo/unpriced".\n  Add "call:demo/unpriced".'
        );
      }
      return { usd: 0.5 };
    },
    submit: request => {
      submitted.push(request);
      return Promise.resolve({ jobId: `job-${submitted.length}` });
    },
    poll: (_jobId, request) => {
      if (request.endpoint === "demo/reject") {
        const error = Object.assign(new Error("[ai] fal rejected the request (HTTP 422)."), {
          status: 422
        });
        return Promise.resolve({ state: "failed", error });
      }
      return Promise.resolve({
        state: "done",
        text: JSON.stringify({ echo: request.input }),
        mimeType: "application/json",
        costUsd: 0.5
      });
    }
  };
  return { submitted, handler };
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

  it("commands() exposes the same eight-command tree outside dispatch", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const tree = app.cli.commands();
    expect(tree.commands.map(command => command.name)).toEqual([
      "new",
      "validate",
      "estimate",
      "run",
      "export",
      "status",
      "compose",
      "call"
    ]);

    await app.stop();
  });
});

describe("cli plugin integration — moku call", () => {
  let tempDir: string;
  let originalCwd: string;
  let fake: FakeCall;
  const written: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-call-integration-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    fake = createFakeCallHandler();
    written.length = 0;
    const realWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((
      text: string,
      callback?: (error?: Error | null) => void
    ) => {
      if (text.startsWith('{"ok"')) {
        written.push(text);
        callback?.();
        return true;
      }
      return realWrite(text, callback);
    }) as typeof process.stdout.write);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Assembles a framework with the fake `call` provider registered. */
  function buildCallFramework() {
    const fakeCallProvider = createPlugin("fakeCallProvider", {
      depends: [registryPlugin],
      onInit: ctx => {
        ctx.require(registryPlugin).register("call", "fake", fake.handler);
      }
    });
    return createCore(coreConfig, {
      plugins: [
        registryPlugin,
        buildfilePlugin,
        promptGenPlugin,
        runnerPlugin,
        composePlugin,
        fakeCallProvider,
        cliPlugin
      ],
      pluginConfigs: {
        journal: { path: path.join(tempDir, "journal.db") },
        store: { dir: path.join(tempDir, "store") }
      }
    });
  }

  /** The one parsed stdout line written since the last call. */
  function takeLine(): CallOutput {
    expect(written).toHaveLength(1);
    const line = written.pop() ?? "";
    expect(line.endsWith("\n")).toBe(true);
    return JSON.parse(line);
  }

  it("the same call twice: paid once, then reused at cost 0, both journaled as inline runs", async () => {
    const app = buildCallFramework().createApp();
    await app.start();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const argv = ["call", "demo/echo", "--input", '{"x":1}'];

    expect(await app.cli.dispatch(argv)).toBe(EXIT_CODES.ok);
    const first = takeLine();
    expect(await app.cli.dispatch(argv)).toBe(EXIT_CODES.ok);
    const second = takeLine();

    expect(first).toMatchObject({
      ok: true,
      endpoint: "demo/echo",
      costUsd: 0.5,
      reused: false,
      result: { echo: { x: 1 } }
    });
    expect(second).toMatchObject({
      ok: true,
      costUsd: 0,
      reused: true,
      result: { echo: { x: 1 } }
    });
    expect(fake.submitted).toHaveLength(1);
    expect(consoleSpy).not.toHaveBeenCalled();
    for (const output of [first, second]) {
      expect(output.ok && app.journal.getRun(output.runId)?.glob).toBe("(inline)");
      const items = output.ok ? app.journal.listItems(output.runId) : [];
      expect(items.map(item => item.label)).toEqual(["demo/echo"]);
    }
    await app.stop();
  });

  it("--input @file with --out writes fal's stored bytes to the file", async () => {
    await writeFile(path.join(tempDir, "body.json"), '{"x":2}', "utf8");
    const app = buildCallFramework().createApp();
    await app.start();

    const code = await app.cli.dispatch([
      "call",
      "demo/echo",
      "--input",
      "@body.json",
      "--out",
      "answer.json"
    ]);

    expect(code).toBe(EXIT_CODES.ok);
    const output = takeLine();
    expect(output).toMatchObject({ ok: true, out: path.join(process.cwd(), "answer.json") });
    expect(output).not.toHaveProperty("result");
    expect(await readFile(path.join(tempDir, "answer.json"), "utf8")).toBe('{"echo":{"x":2}}');
    await app.stop();
  });

  it("an endpoint the handler cannot price ends exit 1, class run, with the handler's message", async () => {
    const app = buildCallFramework().createApp();
    await app.start();

    const code = await app.cli.dispatch(["call", "demo/unpriced", "--input", "{}"]);

    expect(code).toBe(EXIT_CODES.failure);
    const output = takeLine();
    expect(output).toMatchObject({ ok: false, error: { class: "run" } });
    expect(output.ok ? "" : output.error.message).toContain("call:demo/unpriced");
    expect(fake.submitted).toHaveLength(0);
    await app.stop();
  });

  it("a provider rejection ends exit 1 with the journal error class and costs nothing", async () => {
    const app = buildCallFramework().createApp();
    await app.start();

    const code = await app.cli.dispatch(["call", "demo/reject", "--input", "{}"]);

    expect(code).toBe(EXIT_CODES.failure);
    expect(takeLine()).toMatchObject({
      ok: false,
      costUsd: 0,
      error: { class: "http-4xx", message: "[ai] fal rejected the request (HTTP 422)." }
    });
    await app.stop();
  });

  it("a usage error starts no run and still prints one line", async () => {
    const app = buildCallFramework().createApp();
    await app.start();

    const code = await app.cli.dispatch(["call", "demo/echo"]);

    expect(code).toBe(EXIT_CODES.usage);
    expect(takeLine()).toMatchObject({ ok: false, runId: NO_RUN, error: { class: "usage" } });
    expect(app.journal.latestRun()).toBeUndefined();
    await app.stop();
  });
});
