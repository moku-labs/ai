import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptGenUnavailableError } from "../../../promptGen/contract";
import { buildClaudeArguments, DEFAULT_SYSTEM, isBinResolvable, runClaude } from "../../cli";
import { RetryableProviderError, TerminalProviderError } from "../../errors";
import { printStdout, SUCCESS_STDOUT, writeFakeClaude } from "./fixtures";

const BASE_ARGUMENTS = [
  "-p",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--setting-sources",
  "user",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--system-prompt"
];

describe("buildClaudeArguments", () => {
  it("builds the print argv with the default system prompt and all tools off", () => {
    const args = buildClaudeArguments({ withImages: false });

    expect(args).toEqual([...BASE_ARGUMENTS, DEFAULT_SYSTEM, "--tools", ""]);
    expect(DEFAULT_SYSTEM).toBe("Answer the request directly. Output only the answer.");
  });

  it("allows only the Read tool, inside the call dir, without prompts, when images are attached", () => {
    const args = buildClaudeArguments({ withImages: true, system: "You score frames." });

    expect(args).toEqual([
      ...BASE_ARGUMENTS,
      "You score frames.",
      "--restricted",
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--permission-prompts",
      "none"
    ]);
  });

  it("adds --model and --effort when given, and never --bare", () => {
    const args = buildClaudeArguments({
      withImages: false,
      model: "claude-opus-5-5",
      effort: "high"
    });

    expect(args.slice(-4)).toEqual(["--model", "claude-opus-5-5", "--effort", "high"]);
    expect(args).not.toContain("--bare");
  });
});

describe("isBinResolvable", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-claude-cli-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a bare name in one of the PATH directories", () => {
    writeFakeClaude(root, "exit 0");

    expect(isBinResolvable("fake-claude", ["/nonexistent", root].join(path.delimiter))).toBe(true);
  });

  it("returns false for a bare name absent from PATH or with PATH unset", () => {
    expect(isBinResolvable("fake-claude", root)).toBe(false);
    expect(isBinResolvable("fake-claude", undefined)).toBe(false);
  });

  it("checks a path-like bin directly, ignoring PATH", () => {
    const bin = writeFakeClaude(root, "exit 0");

    expect(isBinResolvable(bin, undefined)).toBe(true);
    expect(isBinResolvable(path.join(root, "missing"), root)).toBe(false);
  });
});

describe("runClaude", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-claude-run-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the prompt to stdin, closes it, and collects stdout in full", async () => {
    const bin = writeFakeClaude(root, printStdout(SUCCESS_STDOUT));

    const run = await runClaude({
      bin,
      args: ["-p"],
      cwd: root,
      stdin: "Score this frame.",
      timeoutMs: 5000
    });

    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(SUCCESS_STDOUT);
    expect(readFileSync(path.join(root, "stdin.txt"), "utf8")).toBe("Score this frame.");
    expect(readFileSync(path.join(root, "cwd.txt"), "utf8").trim()).toBe(realpathSync(root));
  });

  it("resolves with the exit code, stdout and stderr tail on a non-zero exit", async () => {
    const bin = writeFakeClaude(
      root,
      "echo partial\necho first >&2\necho 'last words' >&2\nexit 3"
    );

    const run = await runClaude({ bin, args: [], cwd: root, stdin: "p", timeoutMs: 5000 });

    expect(run.code).toBe(3);
    expect(run.stdout).toBe("partial\n");
    expect(run.stderr).toBe("first\nlast words\n");
  });

  it("rejects unavailable 'missing' when the bin does not exist", async () => {
    const bin = path.join(root, "no-such-claude");

    const error = await runClaude({ bin, args: [], cwd: root, stdin: "p", timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(PromptGenUnavailableError);
    expect((error as PromptGenUnavailableError).reason).toBe("missing");
    expect((error as Error).message).toBe(
      `[ai] Claude CLI not found: ${bin}.\n  Install Claude Code or set claude.bin.`
    );
  });

  it("rejects terminal 'could not start' when the bin is not executable", async () => {
    const bin = path.join(root, "not-executable");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o644);

    const error = await runClaude({ bin, args: [], cwd: root, stdin: "p", timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as Error).message).toBe(
      "[ai] Claude CLI could not start: EACCES.\n  Check that claude.bin is an executable file."
    );
  });

  it("kills the process and rejects retryable with kind 'timeout' after timeoutMs", async () => {
    const bin = writeFakeClaude(root, "exec sleep 5");
    const startedAt = Date.now();

    const error = await runClaude({ bin, args: [], cwd: root, stdin: "p", timeoutMs: 200 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).kind).toBe("timeout");
    expect((error as Error).message).toBe(
      "[ai] Claude timed out after 200 ms.\n  Raise claude.timeoutMs or retry the build."
    );
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("sends SIGKILL after the grace period when the process ignores SIGTERM", async () => {
    const bin = writeFakeClaude(root, "trap '' TERM\nexec sleep 5");
    const startedAt = Date.now();

    const error = await runClaude({
      bin,
      args: [],
      cwd: root,
      stdin: "p",
      timeoutMs: 200,
      killGraceMs: 100
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it("kills the process and rethrows signal.reason unchanged on abort", async () => {
    const bin = writeFakeClaude(root, "exec sleep 5");
    const controller = new AbortController();
    const reason = new DOMException("paused", "AbortError");
    setTimeout(() => controller.abort(reason), 100);

    const error = await runClaude({
      bin,
      args: [],
      cwd: root,
      stdin: "p",
      timeoutMs: 10_000,
      signal: controller.signal
    }).catch((error_: unknown) => error_);

    expect(error).toBe(reason);
  });

  it("rejects with signal.reason without spawning when already aborted", async () => {
    const bin = writeFakeClaude(root, "exit 0");
    const controller = new AbortController();
    const reason = new Error("already paused");
    controller.abort(reason);

    const error = await runClaude({
      bin,
      args: [],
      cwd: root,
      stdin: "p",
      timeoutMs: 5000,
      signal: controller.signal
    }).catch((error_: unknown) => error_);

    expect(error).toBe(reason);
    expect(() => readFileSync(path.join(root, "args.txt"))).toThrow();
  });
});
