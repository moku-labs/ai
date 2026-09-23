/**
 * @file codex CLI boundary — builds the `codex exec` argv, runs the process
 * with stdin closed, and turns its outcome into the plugin's error classes.
 * The only file that spawns anything.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { RetryableProviderError, TerminalProviderError } from "./types";

/** Inputs for {@link buildCodexArguments}. */
export type CodexArgumentsOptions = {
  /** Codex model id. */
  model: string;
  /** Reasoning effort, passed as a TOML string override. */
  reasoningEffort: string;
  /** Per-call working directory (`-C`); codex writes the image here. */
  dir: string;
  /** Absolute paths of the reference images to attach. */
  refPaths: string[];
  /** Full prompt text. */
  prompt: string;
};

/** Inputs for {@link runCodex}. */
export type RunCodexOptions = {
  /** Executable to spawn. */
  bin: string;
  /** Argument vector. */
  args: string[];
  /** Working directory of the child process. */
  cwd: string;
  /** Kill the process after this long, ms. */
  timeoutMs: number;
  /** Caller signal; aborting kills the process and rethrows `signal.reason`. */
  signal?: AbortSignal;
};

/** How many trailing stderr characters are kept for error messages. */
const STDERR_TAIL_CHARS = 4096;

/**
 * Builds the `codex exec` argv. `--` always precedes the prompt, because
 * `--image` is greedy and would swallow it otherwise.
 *
 * @param options - Model, effort, dir, ref paths and prompt.
 * @returns The argv, without the executable.
 * @example
 * ```ts
 * buildCodexArguments({ model: "gpt-6-astra", reasoningEffort: "low", dir, refPaths: [], prompt });
 * ```
 */
export function buildCodexArguments(options: CodexArgumentsOptions): string[] {
  const imageArguments = options.refPaths.flatMap(refPath => ["--image", refPath]);
  return [
    "exec",
    "-m",
    options.model,
    "-c",
    `model_reasoning_effort="${options.reasoningEffort}"`,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    "-C",
    options.dir,
    "-o",
    path.join(options.dir, "last-message.txt"),
    ...imageArguments,
    "--",
    options.prompt
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
 * isBinResolvable("codex", ctx.env.get("PATH"));
 * ```
 */
export function isBinResolvable(bin: string, pathValue: string | undefined): boolean {
  const isPathLike = bin.includes("/") || bin.includes(path.sep);
  if (isPathLike) return existsSync(bin);

  const directories = (pathValue ?? "").split(path.delimiter).filter(directory => directory !== "");
  return directories.some(directory => existsSync(path.join(directory, bin)));
}

/**
 * Last non-empty line of the captured stderr.
 *
 * @param stderr - Captured stderr tail.
 * @returns The last line, trimmed, or "" when there is none.
 * @example
 * ```ts
 * lastLineOf("a\nb\n"); // => "b"
 * ```
 */
function lastLineOf(stderr: string): string {
  const lines = stderr.split("\n").map(line => line.trim());
  return lines.findLast(line => line !== "") ?? "";
}

/**
 * Error for a process that ended without success.
 *
 * @param code - Exit code, or null when killed by a signal.
 * @param exitSignal - Terminating signal name, when any.
 * @param stderr - Captured stderr tail.
 * @returns The terminal error to throw.
 * @example
 * ```ts
 * exitError(1, null, "boom");
 * ```
 */
function exitError(
  code: number | null,
  exitSignal: NodeJS.Signals | null,
  stderr: string
): TerminalProviderError {
  const how = code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`;
  const lastLine = lastLineOf(stderr).replace(/\.$/, "");
  const detail = lastLine === "" ? "" : `: ${lastLine}`;
  return new TerminalProviderError(
    `[ai] Codex exited with ${how}${detail}.\n  Run the same codex exec by hand to see the full output.`
  );
}

/**
 * Error for a process that could not be started.
 *
 * @param error - The spawn error.
 * @param bin - The executable that failed.
 * @returns The terminal error to throw.
 * @example
 * ```ts
 * spawnError(error, "codex");
 * ```
 */
function spawnError(error: NodeJS.ErrnoException, bin: string): TerminalProviderError {
  if (error.code === "ENOENT") {
    return new TerminalProviderError(
      `[ai] Codex CLI not found: ${bin}.\n  Install codex or set codex.bin.`
    );
  }
  return new TerminalProviderError(
    `[ai] Codex CLI could not start: ${error.code ?? error.message}.\n  Check that codex.bin is an executable file.`
  );
}

/**
 * Runs the codex CLI once, with stdin closed (an open stdin makes codex
 * wait forever). Kills it with SIGTERM on timeout or caller abort.
 *
 * @param options - Executable, argv, cwd, timeout and signal.
 * @returns Resolves when the process exits 0.
 * @throws {TerminalProviderError} When the CLI is missing or exits non-zero.
 * @throws {RetryableProviderError} With kind "timeout" after `timeoutMs`.
 * @throws {unknown} The caller's `signal.reason`, unchanged, on abort.
 * @example
 * ```ts
 * await runCodex({ bin: "codex", args, cwd: dir, timeoutMs: 600_000, signal });
 * ```
 */
export function runCodex(options: RunCodexOptions): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let killedFor: "timeout" | "abort" | undefined;
    let settled = false;

    /**
     * Records why the process is being killed, then sends SIGTERM.
     *
     * @param reason - Why the process is killed.
     * @example
     * ```ts
     * kill("timeout");
     * ```
     */
    const kill = (reason: "timeout" | "abort"): void => {
      killedFor = reason;
      child.kill("SIGTERM");
    };
    /**
     * Kills the process when the caller aborts.
     *
     * @returns Nothing.
     * @example
     * ```ts
     * signal.addEventListener("abort", onAbort);
     * ```
     */
    const onAbort = (): void => kill("abort");
    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });

    /**
     * Settles the promise once and releases the timer and abort listener.
     *
     * @param error - Rejection reason; undefined resolves.
     * @example
     * ```ts
     * settle(new TerminalProviderError("[ai] Codex exited with code 1.\n  Retry."));
     * ```
     */
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };

    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });

    child.on("error", error => settle(spawnError(error, options.bin)));
    // A killed process may leave grandchildren holding the pipes open, so
    // kills settle on "exit"; normal runs wait for "close" to get all stderr.
    child.on("exit", () => {
      if (killedFor === "abort")
        settle(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (killedFor === "timeout") {
        settle(
          new RetryableProviderError(
            `[ai] Codex timed out after ${options.timeoutMs} ms.\n  Raise codex.timeoutMs or retry the build.`,
            "timeout"
          )
        );
      }
    });
    child.on("close", (code, exitSignal) => {
      settle(code === 0 ? undefined : exitError(code, exitSignal, stderr));
    });
  });
}
