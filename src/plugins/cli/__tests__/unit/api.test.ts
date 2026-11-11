import type { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { BuildfileSource } from "../../../buildfile/types";
import { createCliApi, isPlainMode, runWithAbort } from "../../api";
import type { CallOutput, CliApi, CommandTree } from "../../types";
import { EXIT_CODES } from "../../types";
import { createFakeCliContext, createFakeCommandContext, createItemRow } from "./fixtures";

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
  it("returns a stable tree naming all eight commands, call last", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const tree = api.commands();

    expect(tree.name).toBe("ai");
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
  });

  it("describes run's flags with human descriptions", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const tree = api.commands();
    const runCommand = tree.commands.find(command => command.name === "run");

    expect(runCommand?.flags["max-cost"]).toEqual(expect.any(String));
    expect(runCommand?.flags["dry-run"]).toEqual(expect.any(String));
  });

  it("declares --flat on run and export", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    const tree = api.commands();
    const flagsOf = (name: string) => tree.commands.find(command => command.name === name)?.flags;

    expect(flagsOf("run")?.flat).toBe("Write files to --out directly, without the <build>/ folder");
    expect(flagsOf("export")?.flat).toBe(
      "Write files to --out directly, without the <build>/ folder"
    );
    expect(tree.commands.find(command => command.name === "export")?.description).toBe(
      "Copy a run's artifacts to out/<build>/<label>.<ext> (or out/<label>.<ext> with --flat)"
    );
  });

  it("is stable across repeated calls (no identity-sensitive shared mutation)", () => {
    const ctx = createFakeCliContext();
    const api = createCliApi(ctx);

    expect(api.commands()).toEqual(api.commands());
  });
});

// ---------------------------------------------------------------------------
// call — the real stdin reader, stdout writer and store wiring
// ---------------------------------------------------------------------------

describe("createCliApi().dispatch — call wiring", () => {
  const answer = JSON.stringify({ masks: ["x".repeat(100)] });
  let compiledText: string | undefined;

  /** A cli context whose journal and store play one done call item. */
  function createCallCliContext() {
    return createFakeCliContext({
      buildfile: {
        compile: (source: BuildfileSource) => {
          compiledText = "text" in source ? source.text : undefined;
          return Promise.resolve({ file: "<inline>", spec: JSON.parse(compiledText ?? "{}") });
        }
      },
      journal: { listItems: () => [createItemRow()] },
      store: { read: () => Promise.resolve(new TextEncoder().encode(answer)) }
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    compiledText = undefined;
  });

  it("writes the answer line to process.stdout and resolves only after the write flushed", async () => {
    const written: string[] = [];
    let flushed = false;
    vi.spyOn(process.stdout, "write").mockImplementation(((
      text: string,
      callback: (error?: Error | null) => void
    ) => {
      written.push(text);
      setTimeout(() => {
        flushed = true;
        callback();
      }, 10);
      return true;
    }) as typeof process.stdout.write);
    const api = createCliApi(createCallCliContext());

    const code = await api.dispatch(["call", "ep", "--input", "{}"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(flushed).toBe(true);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "")).toMatchObject({
      ok: true,
      endpoint: "ep",
      result: JSON.parse(answer)
    });
  });

  it("rejects when stdout reports a write error", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _text: string,
      callback: (error?: Error | null) => void
    ) => {
      callback(new Error("EPIPE"));
      return true;
    }) as typeof process.stdout.write);
    const api = createCliApi(createCallCliContext());

    // dispatchCommand maps the rejected write to the generic failure code
    expect(await api.dispatch(["call", "ep", "--input", "{}"])).toBe(EXIT_CODES.failure);
  });

  it("reads --input - from the whole of stdin as UTF-8", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _text: string,
      callback: (error?: Error | null) => void
    ) => {
      callback();
      return true;
    }) as typeof process.stdout.write);
    // A multi-byte character split across two chunks must survive.
    const bytes = new TextEncoder().encode('{"prompt":"стена"}');
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([bytes.slice(0, 13), bytes.slice(13)]),
      configurable: true
    });
    try {
      const api = createCliApi(createCallCliContext());

      await api.dispatch(["call", "ep", "--input", "-"]);
    } finally {
      if (original) Object.defineProperty(process, "stdin", original);
    }

    expect(JSON.parse(compiledText ?? "{}").items[0].input.input).toEqual({ prompt: "стена" });
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

  it("a failed call output costs exactly 0", () => {
    expectTypeOf<Extract<CallOutput, { ok: false }>["costUsd"]>().toEqualTypeOf<0>();
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
