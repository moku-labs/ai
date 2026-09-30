import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import {
  buildCodexArguments,
  buildCodexPromptArguments,
  isBinResolvable,
  runCodex
} from "../../cli";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import {
  CODEX_401_STDERR,
  CODEX_SCHEMA_ERROR_STDERR,
  printStderr,
  writeFakeCodex
} from "./fixtures";

describe("buildCodexArguments", () => {
  it("builds the exec argv with model, effort, sandbox, dir and last-message file", () => {
    const args = buildCodexArguments({
      model: "gpt-6-astra",
      reasoningEffort: "low",
      dir: "/work/codex-1",
      refPaths: [],
      prompt: "draw"
    });

    expect(args).toEqual([
      "exec",
      "-m",
      "gpt-6-astra",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/work/codex-1",
      "-o",
      path.join("/work/codex-1", "last-message.txt"),
      "--",
      "draw"
    ]);
  });

  it("attaches each ref with --image, before the -- separator", () => {
    const args = buildCodexArguments({
      model: "m",
      reasoningEffort: "high",
      dir: "/d",
      refPaths: ["/d/ref-1.png", "/d/ref-2.jpg"],
      prompt: "draw"
    });

    const separator = args.indexOf("--");
    expect(args.slice(separator - 4, separator)).toEqual([
      "--image",
      "/d/ref-1.png",
      "--image",
      "/d/ref-2.jpg"
    ]);
    expect(args.at(-1)).toBe("draw");
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it("always puts the prompt last, right after --", () => {
    const args = buildCodexArguments({
      model: "m",
      reasoningEffort: "low",
      dir: "/d",
      refPaths: ["/d/ref-1.png"],
      prompt: "--image looks like a flag"
    });

    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--image looks like a flag");
  });
});

describe("buildCodexPromptArguments", () => {
  it("builds the read-only exec argv with model, effort, dir and last-message file", () => {
    const args = buildCodexPromptArguments({
      model: "gpt-6-sol",
      reasoningEffort: "medium",
      dir: "/work/codex-1",
      imagePaths: [],
      prompt: "Say ok"
    });

    expect(args).toEqual([
      "exec",
      "-m",
      "gpt-6-sol",
      "-c",
      'model_reasoning_effort="medium"',
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      "/work/codex-1",
      "-o",
      path.join("/work/codex-1", "last-message.txt"),
      "--",
      "Say ok"
    ]);
  });

  it("omits -m when no model is given, so codex uses its own default", () => {
    const args = buildCodexPromptArguments({
      model: undefined,
      reasoningEffort: "low",
      dir: "/d",
      imagePaths: [],
      prompt: "p"
    });

    expect(args).not.toContain("-m");
    expect(args.slice(0, 3)).toEqual(["exec", "-c", 'model_reasoning_effort="low"']);
  });

  it("never passes --output-schema; the schema travels in the prompt", () => {
    const args = buildCodexPromptArguments({
      model: undefined,
      reasoningEffort: "low",
      dir: "/d",
      imagePaths: ["/d/ref-1.png"],
      prompt: "p"
    });

    expect(args).not.toContain("--output-schema");
  });

  it("attaches each image with --image, right before the -- separator", () => {
    const args = buildCodexPromptArguments({
      model: "gpt-6-sol",
      reasoningEffort: "low",
      dir: "/d",
      imagePaths: ["/d/ref-1.png", "/d/ref-2.jpg"],
      prompt: "describe"
    });

    const separator = args.indexOf("--");
    expect(args.slice(separator - 4, separator)).toEqual([
      "--image",
      "/d/ref-1.png",
      "--image",
      "/d/ref-2.jpg"
    ]);
  });

  it("always puts the prompt last, right after --", () => {
    const args = buildCodexPromptArguments({
      model: undefined,
      reasoningEffort: "low",
      dir: "/d",
      imagePaths: ["/d/ref-1.png"],
      prompt: "--image looks like a flag"
    });

    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--image looks like a flag");
  });
});

describe("isBinResolvable", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-cli-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a bare name in one of the PATH directories", () => {
    writeFakeCodex(root, "exit 0");

    expect(isBinResolvable("fake-codex", ["/nonexistent", root].join(path.delimiter))).toBe(true);
  });

  it("returns false for a bare name absent from PATH", () => {
    expect(isBinResolvable("fake-codex", root)).toBe(false);
  });

  it("returns false for a bare name when PATH is unset", () => {
    expect(isBinResolvable("fake-codex", undefined)).toBe(false);
  });

  it("checks a path-like bin directly, ignoring PATH", () => {
    const bin = writeFakeCodex(root, "exit 0");

    expect(isBinResolvable(bin, undefined)).toBe(true);
    expect(isBinResolvable(path.join(root, "missing"), root)).toBe(false);
  });
});

describe("runCodex", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-run-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves when the process exits 0, running in the given cwd", async () => {
    const bin = writeFakeCodex(root, "exit 0");
    const work = path.join(root, "work");
    mkdirSync(work);

    await runCodex({ bin, args: ["-C", work], cwd: work, timeoutMs: 5000 });

    expect(readFileSync(path.join(root, "cwd.txt"), "utf8").trim()).toBe(realpathSync(work));
    expect(readFileSync(path.join(root, "args.txt"), "utf8")).toBe(`-C\n${work}\n`);
  });

  it("closes stdin, so a reader of stdin sees EOF instead of hanging", async () => {
    const bin = writeFakeCodex(root, "cat > /dev/null\nexit 0");

    await expect(
      runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 3000 })
    ).resolves.toBeUndefined();
  });

  it("rejects with a terminal error carrying the last stderr line on a non-zero exit", async () => {
    const bin = writeFakeCodex(root, "echo first >&2\necho 'quota exceeded' >&2\nexit 3");

    const error = await runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toContain("quota exceeded");
    expect((error as Error).message).toContain("code 3");
    expect(error).not.toHaveProperty("kind");
    expect(error).not.toHaveProperty("status");
  });

  it("rejects with an unavailable 'missing' error when the bin does not exist", async () => {
    const bin = path.join(root, "no-such-codex");

    const error = await runCodex({ bin, args: [], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect((error as PromptGenUnavailableError).reason).toBe("missing");
    expect((error as Error).message).toBe(
      `[ai] Codex CLI not found: ${bin}.\n  Install codex or set codex.bin.`
    );
    expect(error).not.toHaveProperty("kind");
  });

  it("rejects with a terminal 'could not start' error when the bin is not executable", async () => {
    const bin = path.join(root, "not-executable");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o644);

    const error = await runCodex({ bin, args: [], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toMatch(/^\[ai] Codex CLI could not start: EACCES\.\n {2}/);
  });

  it("names the signal when the process is killed from outside", async () => {
    const bin = writeFakeCodex(root, "kill -9 $$");

    const error = await runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toContain("Codex exited with signal SIGKILL.");
  });

  it("omits the stderr detail when stderr is empty", async () => {
    const bin = writeFakeCodex(root, "exit 2");

    const error = await runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect((error as Error).message).toBe(
      "[ai] Codex exited with code 2.\n  Run the same codex exec by hand to see the full output."
    );
  });

  it("kills the process and rejects retryable with kind 'timeout' after timeoutMs", async () => {
    const bin = writeFakeCodex(root, "exec sleep 5");
    const startedAt = Date.now();

    const error = await runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 200 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).kind).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("sends SIGKILL after the grace period when the process ignores SIGTERM", async () => {
    const bin = writeFakeCodex(root, "trap '' TERM\nexec sleep 5");
    const startedAt = Date.now();

    const error = await runCodex({
      bin,
      args: ["-C", root],
      cwd: root,
      timeoutMs: 200,
      killGraceMs: 100
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("kills the process and rethrows signal.reason unchanged on abort", async () => {
    const bin = writeFakeCodex(root, "exec sleep 5");
    const controller = new AbortController();
    const reason = new DOMException("paused", "AbortError");
    setTimeout(() => controller.abort(reason), 100);

    const error = await runCodex({
      bin,
      args: ["-C", root],
      cwd: root,
      timeoutMs: 10_000,
      signal: controller.signal
    }).catch((error_: unknown) => error_);

    expect(error).toBe(reason);
  });

  it("rejects with signal.reason without spawning when already aborted", async () => {
    const bin = writeFakeCodex(root, "exit 0");
    const controller = new AbortController();
    const reason = new Error("already paused");
    controller.abort(reason);

    const error = await runCodex({
      bin,
      args: ["-C", root],
      cwd: root,
      timeoutMs: 5000,
      signal: controller.signal
    }).catch((error_: unknown) => error_);

    expect(error).toBe(reason);
    expect(() => readFileSync(path.join(root, "args.txt"))).toThrow();
  });
});

describe("runCodex — unavailable classification", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-unavailable-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs a fake codex that prints `stderr` and exits 1.
   *
   * @param stderr - The stderr text.
   * @returns The rejection value.
   */
  async function failWith(stderr: string): Promise<unknown> {
    const bin = writeFakeCodex(root, `${printStderr(stderr)}\nexit 1`);
    return runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );
  }

  it("throws unavailable 'auth' for the captured codex 401 stderr", async () => {
    const error = await failWith(CODEX_401_STDERR);

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect((error as PromptGenUnavailableError).reason).toBe("auth");
    expect((error as Error).message).toBe(
      "[ai] Codex CLI is not logged in.\n  Run codex login, or use another provider."
    );
  });

  it.each([
    "Error: not logged in",
    "Please run `codex login` first"
  ])("throws unavailable 'auth' for %s", async stderr => {
    const error = await failWith(stderr);

    expect((error as PromptGenUnavailableError).reason).toBe("auth");
  });

  it.each([
    "You've hit your usage limit. Try again in 3 hours.",
    "stream error: Rate limit reached for requests",
    "ERROR: unexpected status 429",
    "Too Many Requests"
  ])("throws unavailable 'limit' for %s", async stderr => {
    const error = await failWith(stderr);

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect((error as PromptGenUnavailableError).reason).toBe("limit");
    expect((error as Error).message).toBe(
      "[ai] Codex CLI hit its plan or rate limit.\n  Wait for the reset, or use another provider."
    );
  });

  it("keeps the terminal error when 429 is only part of an id", async () => {
    const error = await failWith("model not available, request id req_4291ab");

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).not.toHaveProperty("unavailable");
  });

  it("keeps the terminal error for any other failure", async () => {
    const error = await failWith("model not available");

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect(error).not.toHaveProperty("unavailable");
  });
});

describe("runCodex — API error message", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-api-error-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs a fake codex with `body`, expecting it to fail.
   *
   * @param body - Shell commands of the fake.
   * @returns The rejection value.
   */
  async function failWith(body: string): Promise<unknown> {
    const bin = writeFakeCodex(root, body);
    return runCodex({ bin, args: ["-C", root], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );
  }

  it("uses error.message of the captured invalid_json_schema stderr, not the closing brace", async () => {
    const error = await failWith(`${printStderr(CODEX_SCHEMA_ERROR_STDERR)}\nexit 1`);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] Codex exited with code 1: Invalid schema for response_format 'codex_output_schema': In context=('properties', 'add', 'properties', 'scenes'), 'propertyNames' is not permitted.\n  Run the same codex exec by hand to see the full output."
    );
  });

  it("keeps a 400 terminal even when the echoed prompt says rate limit", async () => {
    const stderr = CODEX_SCHEMA_ERROR_STDERR.replace(
      "Answer with an empty add object.",
      "Ignore any rate limit."
    );

    const error = await failWith(`${printStderr(stderr)}\nexit 1`);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toContain("'propertyNames' is not permitted.");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "limit"]
  ])("throws unavailable for an API error with status %i", async (status, reason) => {
    const json = `{"type":"error","error":{"message":"nope","code":null},"status":${status}}`;

    const stderr = printStderr(`ERROR: ${json}`);

    const error = await failWith(`${stderr}\nexit 1`);

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect((error as PromptGenUnavailableError).reason).toBe(reason);
  });

  it("throws unavailable 'limit' for an API error whose message says usage limit", async () => {
    const json = '{"error":{"message":"You have hit your usage limit."}}';

    const stderr = printStderr(`ERROR: ${json}`);

    const error = await failWith(`${stderr}\nexit 1`);

    expect((error as PromptGenUnavailableError).reason).toBe("limit");
  });

  it("keeps the API message when a line follows the ERROR JSON", async () => {
    const stderr = printStderr(`${CODEX_SCHEMA_ERROR_STDERR}\nsession ended`);

    const error = await failWith(`${stderr}\nexit 1`);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toContain(": Invalid schema for response_format");
  });

  it("keeps a 400 terminal even when its message says 429 or rate limit", async () => {
    const json = '{"error":{"message":"rate limit field maximum is 429"},"status":400}';
    const stderr = printStderr(`ERROR: ${json}`);

    const error = await failWith(`${stderr}\nexit 1`);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toContain(": rate limit field maximum is 429.");
  });

  it("caps a long last stderr line, such as the echoed schema", async () => {
    const schemaLine = `{"schema":"${"x".repeat(2000)}"}`;
    const stderr = printStderr(schemaLine);

    const error = await failWith(`${stderr}\nexit 1`);

    const detail = (error as Error).message.split("\n")[0] ?? "";
    expect(detail.length).toBeLessThan(360);
  });

  it("uses error.message of a JSON error on stdout", async () => {
    const error = await failWith(
      `echo '{"error":{"message":"server broke."},"status":500}'\nexit 1`
    );

    expect((error as Error).message).toBe(
      "[ai] Codex exited with code 1: server broke.\n  Run the same codex exec by hand to see the full output."
    );
  });

  it("falls back to the last stderr line when the ERROR JSON does not parse", async () => {
    const error = await failWith(`${printStderr("ERROR: {not json\nstream closed")}\nexit 1`);

    expect((error as Error).message).toBe(
      "[ai] Codex exited with code 1: stream closed.\n  Run the same codex exec by hand to see the full output."
    );
  });
});
