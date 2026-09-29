/**
 * @file claude CLI boundary — builds the `claude -p` argv, runs the process
 * with the prompt on stdin, and maps spawn failures, timeout and abort to
 * errors. Exit codes and stdout are interpreted by `prompt/result.ts`.
 * The only file that spawns anything.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PromptGenUnavailableError } from "../promptGen/contract";
import type { Effort } from "./types";
import { RetryableProviderError, TerminalProviderError } from "./types";

/** Inputs for {@link buildClaudeArguments}. */
export type ClaudeArgumentsOptions = {
  /** System prompt; {@link DEFAULT_SYSTEM} when absent. */
  system?: string | undefined;
  /** True when images are attached: only the Read tool is allowed, without prompts. */
  withImages: boolean;
  /** Mapped claude model; no `--model` when absent. */
  model?: string | undefined;
  /** Effort level; no `--effort` when absent. */
  effort?: Effort | undefined;
};

/** Inputs for {@link runClaude}. */
export type RunClaudeOptions = {
  /** Executable to spawn. */
  bin: string;
  /** Argument vector. */
  args: string[];
  /** Working directory of the child process (the per-call temp dir). */
  cwd: string;
  /** Prompt text, written to stdin, which is then closed. */
  stdin: string;
  /** Kill the process after this long, ms. */
  timeoutMs: number;
  /** Caller signal; aborting kills the process and rethrows `signal.reason`. */
  signal?: AbortSignal;
  /** Wait this long after SIGTERM, then SIGKILL, ms. Default: 5000. */
  killGraceMs?: number;
};

/** Outcome of a finished `claude` process, whatever its exit code. */
export type ClaudeRun = {
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null;
  /** Terminating signal name, or null. */
  exitSignal: string | null;
  /** Full stdout: the JSON result. */
  stdout: string;
  /** Trailing stderr, at most 4096 characters. */
  stderr: string;
};

/** System prompt replacing Claude Code's coding-agent prompt when a request has none. */
export const DEFAULT_SYSTEM = "Answer the request directly. Output only the answer.";

/** How many trailing stderr characters are kept for error messages. */
const STDERR_TAIL_CHARS = 4096;

/** How long a killed process gets to exit after SIGTERM before SIGKILL, ms. */
const KILL_GRACE_MS = 5000;

/** Name of the only tool a call with images may use. */
const READ_TOOL = "Read";

/**
 * Builds the `claude -p` argv. The prompt is not in it: it goes on stdin.
 * Never `--bare`, which disables OAuth and so breaks plan billing.
 *
 * @param options - System prompt, images flag, model and effort.
 * @returns The argv, without the executable.
 * @example
 * ```ts
 * buildClaudeArguments({ withImages: false }).slice(-2); // => ["--tools", ""]
 * ```
 */
export function buildClaudeArguments(options: ClaudeArgumentsOptions): string[] {
  const toolArguments = options.withImages
    ? [
        // --restricted confines the file tools to the cwd (the per-call dir):
        // an allow rule alone does not stop Read outside it (checked live 2026-09-29).
        "--restricted",
        "--tools",
        READ_TOOL,
        "--allowedTools",
        READ_TOOL,
        "--permission-prompts",
        "none"
      ]
    : ["--tools", ""];
  const modelArguments = options.model === undefined ? [] : ["--model", options.model];
  const effortArguments = options.effort === undefined ? [] : ["--effort", options.effort];

  return [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt",
    options.system ?? DEFAULT_SYSTEM,
    ...toolArguments,
    ...modelArguments,
    ...effortArguments
  ];
}

/**
 * Whether `bin` points at an existing file: a path-like bin is checked
 * directly, a bare name is searched in the PATH directories.
 *
 * @param bin - Configured executable.
 * @param pathValue - The PATH value (read via `ctx.env` by the caller).
 * @returns True when the executable file exists.
 * @example
 * ```ts
 * isBinResolvable("claude", "/usr/bin:/opt/homebrew/bin"); // => true when claude is installed there
 * ```
 */
export function isBinResolvable(bin: string, pathValue: string | undefined): boolean {
  const isPathLike = bin.includes("/") || bin.includes(path.sep);
  if (isPathLike) return existsSync(bin);

  const directories = (pathValue ?? "").split(path.delimiter).filter(directory => directory !== "");
  return directories.some(directory => existsSync(path.join(directory, bin)));
}

/**
 * Error for a process that could not be started: a missing binary means
 * "unavailable", so promptGen can fall back; anything else is terminal.
 *
 * @param error - The spawn error.
 * @param bin - The executable that failed.
 * @returns The error to throw.
 * @example
 * ```ts
 * spawnError(Object.assign(new Error("spawn"), { code: "EACCES" }), "claude"); // => TerminalProviderError
 * ```
 */
function spawnError(error: NodeJS.ErrnoException, bin: string): Error {
  if (error.code === "ENOENT") {
    return new PromptGenUnavailableError(
      `[ai] Claude CLI not found: ${bin}.\n  Install Claude Code or set claude.bin.`,
      "missing"
    );
  }
  return new TerminalProviderError(
    `[ai] Claude CLI could not start: ${error.code ?? error.message}.\n  Check that claude.bin is an executable file.`
  );
}

/**
 * Runs the claude CLI once: writes the prompt to stdin and closes it,
 * collects stdout in full and the stderr tail. Resolves on any exit code,
 * because claude prints a JSON result even when it exits 1. Kills it with
 * SIGTERM on timeout or caller abort.
 *
 * @param options - Executable, argv, cwd, stdin text, timeout and signal.
 * @returns The exit code, signal, stdout and stderr tail.
 * @throws {PromptGenUnavailableError} With reason "missing" when the binary does not exist.
 * @throws {TerminalProviderError} When the binary exists but cannot start.
 * @throws {RetryableProviderError} With kind "timeout" after `timeoutMs`.
 * @throws {unknown} The caller's `signal.reason`, unchanged, on abort.
 * @example
 * ```ts
 * const run = await runClaude({ bin: "claude", args: ["-p"], cwd: "/tmp/moku-claude-x", stdin: "Say ok.", timeoutMs: 60_000 });
 * ```
 */
export function runClaude(options: RunClaudeOptions): Promise<ClaudeRun> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<ClaudeRun>((resolve, reject) => {
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let killedFor: "timeout" | "abort" | undefined;
    let settled = false;

    /**
     * Records why the process is being killed, sends SIGTERM, and sends
     * SIGKILL after the grace period in case the process ignores it.
     *
     * @param reason - Why the process is killed.
     */
    const kill = (reason: "timeout" | "abort"): void => {
      killedFor = reason;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS).unref();
    };
    /**
     * Kills the process when the caller aborts.
     *
     * @returns Nothing.
     */
    const onAbort = (): void => kill("abort");
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    /**
     * Settles the promise once and releases the timer and abort listener.
     *
     * @param outcome - The finished run, or the rejection reason.
     */
    const settle = (outcome: { run: ClaudeRun } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if ("run" in outcome) resolve(outcome.run);
      else reject(outcome.error);
    };

    // A child that dies before reading stdin makes the write fail with EPIPE;
    // the exit or spawn error that follows carries the real cause.
    child.stdin.on("error", () => {
      // Ignored: see above.
    });
    child.stdin.end(options.stdin);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });

    child.on("error", error => settle({ error: spawnError(error, options.bin) }));
    // A killed process may leave grandchildren holding the pipes open, so
    // kills settle on "exit"; normal runs wait for "close" to get all output.
    child.on("exit", () => {
      if (killedFor === "abort") {
        settle({ error: signal?.reason ?? new DOMException("Aborted", "AbortError") });
      }
      if (killedFor === "timeout") {
        const message = `[ai] Claude timed out after ${options.timeoutMs} ms.\n  Raise claude.timeoutMs or retry the build.`;
        settle({ error: new RetryableProviderError(message, "timeout") });
      }
    });
    child.on("close", (code, exitSignal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      settle({ run: { code, exitSignal, stdout, stderr } });
    });
  });
}
