import type { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCliApi, isPlainMode, runWithAbort } from "../../api";
import type { CliApi, CommandTree } from "../../types";
import { EXIT_CODES } from "../../types";
import { createFakeCliContext, createFakeCommandContext } from "./fixtures";

// ---------------------------------------------------------------------------
// dispatch() — argv routing table
// ---------------------------------------------------------------------------

describe("createCliApi().dispatch — routing", () => {
  // "new" writes real files (buildfile.template()'s output + JSON Schema) via
  // node:fs relative to process.cwd() — chdir into a scratch temp dir so this
  // suite never writes into the repo root.
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-cli-api-routing-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["new", ["new", "demo"], EXIT_CODES.ok],
    ["validate", ["validate"], EXIT_CODES.ok],
    ["estimate", ["estimate"], EXIT_CODES.ok],
    ["status", ["status"], EXIT_CODES.ok],
    ["compose", ["compose", "a sunset over the ocean"], EXIT_CODES.ok]
  ])("routes %s to its command handler", async (_label, argv, expectedCode) => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const code = await api.dispatch(argv);

    expect(code).toBe(expectedCode);
  });

  it("returns the usage exit code for an unrecognized command", async () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const code = await api.dispatch(["frobnicate"]);

    expect(code).toBe(EXIT_CODES.usage);
  });

  it("returns the usage exit code for an empty argv", async () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const code = await api.dispatch([]);

    expect(code).toBe(EXIT_CODES.usage);
  });

  it("returns the usage exit code for an unknown flag", async () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const code = await api.dispatch(["validate", "--nope"]);

    expect(code).toBe(EXIT_CODES.usage);
  });

  it("maps an uncaught command error to the generic runtime-failure exit code", async () => {
    const ctx = createFakeCliContext({
      runner: {
        estimate: () => Promise.reject(new Error("boom"))
      }
    });
    const api = createCliApi(ctx);

    const code = await api.dispatch(["estimate"]);

    expect(code).toBe(EXIT_CODES.failure);
  });
});

// ---------------------------------------------------------------------------
// commands() — mountable tree shape
// ---------------------------------------------------------------------------

describe("createCliApi().commands", () => {
  it("returns a stable tree naming all six commands", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const tree = api.commands();

    expect(tree.name).toBe("ai");
    expect(tree.commands.map(command => command.name)).toEqual([
      "new",
      "validate",
      "estimate",
      "run",
      "status",
      "compose"
    ]);
  });

  it("describes run's flags with human descriptions", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const tree = api.commands();
    const runCommand = tree.commands.find(command => command.name === "run");

    expect(runCommand?.flags["max-cost"]).toEqual(expect.any(String));
    expect(runCommand?.flags["dry-run"]).toEqual(expect.any(String));
  });

  it("is stable across repeated calls (no identity-sensitive shared mutation)", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    expect(api.commands()).toEqual(api.commands());
  });
});

// ---------------------------------------------------------------------------
// Type-level: dispatch signature + CommandTree shape
// ---------------------------------------------------------------------------

describe("CliApi types", () => {
  it("dispatch accepts a string[] and returns Promise<number>", () => {
    expectTypeOf<CliApi["dispatch"]>().parameter(0).toEqualTypeOf<string[]>();
    expectTypeOf<CliApi["dispatch"]>().returns.toEqualTypeOf<Promise<number>>();
  });

  it("commands returns the exported CommandTree shape", () => {
    expectTypeOf<CliApi["commands"]>().returns.toEqualTypeOf<CommandTree>();
  });
});

// ---------------------------------------------------------------------------
// Plain-mode rendering — no ANSI when plain/NO_COLOR/!TTY
// ---------------------------------------------------------------------------

describe("isPlainMode", () => {
  it("is plain when config.plain is true", () => {
    const ctx = createFakeCliContext({ config: { plain: true } });
    expect(isPlainMode(ctx)).toBe(true);
  });

  it("is plain when NO_COLOR is set in the environment", () => {
    const ctx = createFakeCliContext({
      env: { get: (key: string) => (key === "NO_COLOR" ? "1" : undefined) }
    });
    expect(isPlainMode(ctx)).toBe(true);
  });

  it("is plain when stdout is not a TTY", () => {
    const stdout = process.stdout as unknown as { isTTY: boolean | undefined };
    const originalIsTty = stdout.isTTY;

    stdout.isTTY = undefined;
    try {
      const ctx = createFakeCliContext();
      expect(isPlainMode(ctx)).toBe(true);
    } finally {
      stdout.isTTY = originalIsTty;
    }
  });
});

describe("plain-mode rendering", () => {
  it("emits no ANSI escape sequences from a plain-mode command's captured output", async () => {
    const { context, lines } = createFakeCommandContext();
    context.ui.info("plain output line");

    expect(lines.some(line => line.includes("["))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SIGINT wiring — first abort = signal, simulated second = immediate
// ---------------------------------------------------------------------------

describe("runWithAbort", () => {
  it("aborts the signal on the first SIGINT and removes its own listener", async () => {
    const emitter = process as unknown as EventEmitter;
    const before = emitter.listenerCount("SIGINT");

    let capturedSignal: AbortSignal | undefined;
    const actionStarted = new Promise<void>(resolve => {
      void runWithAbort(signal => {
        capturedSignal = signal;
        resolve();
        return new Promise<void>(actionResolve => {
          signal.addEventListener("abort", () => actionResolve(), { once: true });
        });
      });
    });

    await actionStarted;
    expect(emitter.listenerCount("SIGINT")).toBe(before + 1);

    process.emit("SIGINT");
    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));

    // The handler was installed with `process.once`, so it self-removed on
    // the first SIGINT — a second SIGINT now has no listener left and would
    // fall through to Node's default (immediate exit) behavior.
    await vi.waitFor(() => expect(emitter.listenerCount("SIGINT")).toBe(before));
  });

  it("resolves with action's value and removes the listener when action never aborts", async () => {
    const emitter = process as unknown as EventEmitter;
    const before = emitter.listenerCount("SIGINT");

    const result = await runWithAbort(async () => "done");

    expect(result).toBe("done");
    expect(emitter.listenerCount("SIGINT")).toBe(before);
  });
});
