/**
 * @file codex CLI boundary — builds the `codex exec` argv (image and
 * prompt-gen), runs the process with stdin closed, and turns its outcome into
 * the plugin's error classes: missing binary, not logged in and plan or rate
 * limit become `PromptGenUnavailableError`. An `ERROR: {…}` API error in the
 * output gives the message. The only file that spawns anything.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PromptGenUnavailableError } from "../promptGen/contract";
import { RetryableProviderError, TerminalProviderError } from "./errors";

/** File codex writes its final answer to (`-o`), inside the call dir. */
export const LAST_MESSAGE_FILE = "last-message.txt";

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

/** Inputs for {@link buildCodexPromptArguments}. */
export type CodexPromptArgumentsOptions = {
  /** Codex model id; undefined leaves `-m` out, so codex uses its own default. */
  model: string | undefined;
  /** Reasoning effort, passed as a TOML string override. */
  reasoningEffort: string;
  /** Per-call working directory (`-C`); holds the answer and images. */
  dir: string;
  /** Absolute paths of the images to attach. */
  imagePaths: string[];
  /** Full prompt text, system text already prepended. */
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
  /** Wait this long after SIGTERM, then SIGKILL, ms. Default: 5000. */
  killGraceMs?: number;
};

/** How many trailing stderr and stdout characters are kept for error messages. */
const OUTPUT_TAIL_CHARS = 4096;

/** How long a killed process gets to exit after SIGTERM before SIGKILL, ms. */
const KILL_GRACE_MS = 5000;

/** stderr that means the CLI is not logged in. */
const AUTH_PATTERN = /401 Unauthorized|not logged in|codex login/i;

/** stderr that means the ChatGPT plan or the API rate limit is used up. */
const LIMIT_PATTERN = /usage limit|rate limit|\b429\b|too many requests/i;

/** HTTP statuses of an auth failure. */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** HTTP status of a rate limit. */
const LIMIT_STATUS = 429;

/** Where codex prints an API error as JSON: `ERROR: {` on stderr. */
const API_ERROR_MARKER = "ERROR: {";

/** Longest API error message kept in the error text. */
const ERROR_EXCERPT_CHARS = 300;

/** Second line of every "look at it by hand" error. */
const BY_HAND = "Run the same codex exec by hand to see the full output.";

/** Message per unavailable reason; two lines, never the prompt. */
const UNAVAILABLE_MESSAGES = {
  auth: "[ai] Codex CLI is not logged in.\n  Run codex login, or use another provider.",
  limit:
    "[ai] Codex CLI hit its plan or rate limit.\n  Wait for the reset, or use another provider."
} as const;

/** The fields of a codex API error this plugin reads; the rest is ignored. */
const apiErrorSchema = z.object({
  error: z.object({ message: z.string(), code: z.string().nullish() }),
  status: z.number().optional()
});

/** A codex API error, as read. */
type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Builds the `codex exec` argv. `--` always precedes the prompt, because
 * `--image` is greedy and would swallow it otherwise.
 *
 * @param options - Model, effort, dir, ref paths and prompt.
 * @returns The argv, without the executable.
 * @example
 * ```ts
 * buildCodexArguments({ model: "gpt-6-astra", reasoningEffort: "low", dir: "/d", refPaths: [], prompt: "a cat" }).slice(-2); // => ["--", "a cat"]
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
    path.join(options.dir, LAST_MESSAGE_FILE),
    ...imageArguments,
    "--",
    options.prompt
  ];
}

/**
 * Builds the prompt-gen `codex exec` argv: read-only sandbox, optional
 * model, one `--image` per image. Never `--output-schema`: codex sends it as
 * an OpenAI strict schema, which rejects most zod-made schemas, so the
 * schema travels in the prompt. `--` always precedes the prompt, because
 * `--image` is greedy.
 *
 * @param options - Model, effort, dir, image paths and prompt.
 * @returns The argv, without the executable.
 * @example
 * ```ts
 * buildCodexPromptArguments({ model: undefined, reasoningEffort: "low", dir: "/d", imagePaths: [], prompt: "Say ok" }).slice(0, 5); // => ["exec", "-c", 'model_reasoning_effort="low"', "--sandbox", "read-only"]
 * ```
 */
export function buildCodexPromptArguments(options: CodexPromptArgumentsOptions): string[] {
  const modelArguments = options.model === undefined ? [] : ["-m", options.model];
  const imageArguments = options.imagePaths.flatMap(imagePath => ["--image", imagePath]);

  return [
    "exec",
    ...modelArguments,
    "-c",
    `model_reasoning_effort="${options.reasoningEffort}"`,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    options.dir,
    "-o",
    path.join(options.dir, LAST_MESSAGE_FILE),
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
 * isBinResolvable("/no/such/codex", undefined); // => false
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
 * Drops trailing periods, so a message line ends with exactly one.
 *
 * @param text - A message fragment.
 * @returns The fragment without trailing periods.
 * @example
 * ```ts
 * withoutPeriod("is not permitted."); // => "is not permitted"
 * ```
 */
function withoutPeriod(text: string): string {
  let result = text;
  while (result.endsWith(".")) result = result.slice(0, -1);
  return result;
}

/**
 * The API error codex printed, if any: the JSON after the last `ERROR: {`,
 * or the whole text when it is one JSON error (stdout).
 *
 * @param text - Captured stderr or stdout tail.
 * @returns The parsed API error, or undefined when there is none.
 * @example
 * ```ts
 * apiErrorOf('ERROR: {"error":{"message":"bad schema"},"status":400}')?.status; // => 400
 * ```
 */
function apiErrorOf(text: string): ApiError | undefined {
  const marker = text.lastIndexOf(API_ERROR_MARKER);
  const json = marker === -1 ? text.trim() : text.slice(marker + API_ERROR_MARKER.length - 1);

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = apiErrorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The unavailable reason of an API error, if any: 401/403 or auth wording
 * is "auth", 429 or limit wording is "limit". Anything else, a 400
 * `invalid_json_schema` included, is an ordinary failure.
 *
 * @param apiError - The parsed API error.
 * @returns "auth", "limit", or undefined.
 * @example
 * ```ts
 * apiUnavailableReason({ error: { message: "slow down" }, status: 429 }); // => "limit"
 * ```
 */
function apiUnavailableReason(apiError: ApiError): "auth" | "limit" | undefined {
  const { message } = apiError.error;
  const status = apiError.status ?? 0;
  if (AUTH_STATUSES.has(status) || AUTH_PATTERN.test(message)) return "auth";
  if (status === LIMIT_STATUS || LIMIT_PATTERN.test(message)) return "limit";
  return undefined;
}

/**
 * Error for a process that ended without success. An API error in stderr
 * or stdout decides by its status and gives its message. Without one, a
 * stderr tail that says "not logged in" or "limit reached" makes the
 * provider unavailable, so promptGen can fall back, and the last stderr
 * line is the detail. Anything else is terminal.
 *
 * @param code - Exit code, or null when killed by a signal.
 * @param exitSignal - Terminating signal name, when any.
 * @param output - Captured stderr and stdout tails.
 * @param output.stderr - Captured stderr tail.
 * @param output.stdout - Captured stdout tail.
 * @returns The unavailable or terminal error to throw.
 * @example
 * ```ts
 * exitError(1, null, { stderr: "boom", stdout: "" }).message; // => "[ai] Codex exited with code 1: boom.\n  Run the same ..."
 * ```
 */
function exitError(
  code: number | null,
  exitSignal: NodeJS.Signals | null,
  output: { stderr: string; stdout: string }
): TerminalProviderError | PromptGenUnavailableError {
  // An API error decides by its own status and message
  const apiError = apiErrorOf(output.stderr) ?? apiErrorOf(output.stdout);
  const reason =
    apiError === undefined ? unavailableReasonOf(output.stderr) : apiUnavailableReason(apiError);
  if (reason !== undefined)
    return new PromptGenUnavailableError(UNAVAILABLE_MESSAGES[reason], reason);

  // Otherwise terminal, with the API message or the last stderr line
  const how = code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`;
  const message =
    apiError?.error.message.trim().slice(0, ERROR_EXCERPT_CHARS) ?? lastLineOf(output.stderr);
  const detail = message === "" ? "" : `: ${withoutPeriod(message)}`;
  return new TerminalProviderError(`[ai] Codex exited with ${how}${detail}.\n  ${BY_HAND}`);
}

/**
 * The unavailable reason a plain stderr tail shows, if any.
 *
 * @param stderr - Captured stderr tail.
 * @returns "auth", "limit", or undefined.
 * @example
 * ```ts
 * unavailableReasonOf("stream error: Rate limit reached"); // => "limit"
 * ```
 */
function unavailableReasonOf(stderr: string): "auth" | "limit" | undefined {
  if (AUTH_PATTERN.test(stderr)) return "auth";
  if (LIMIT_PATTERN.test(stderr)) return "limit";
  return undefined;
}

/**
 * Error for a process that could not be started.
 *
 * @param error - The spawn error.
 * @param bin - The executable that failed.
 * @returns Unavailable ("missing") for ENOENT, else the terminal error.
 * @example
 * ```ts
 * spawnError(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }), "codex").reason; // => "missing"
 * ```
 */
function spawnError(
  error: NodeJS.ErrnoException,
  bin: string
): TerminalProviderError | PromptGenUnavailableError {
  if (error.code === "ENOENT") {
    return new PromptGenUnavailableError(
      `[ai] Codex CLI not found: ${bin}.\n  Install codex or set codex.bin.`,
      "missing"
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
 * @throws {PromptGenUnavailableError} When the CLI is missing ("missing"), not logged in ("auth") or out of plan or rate limit ("limit").
 * @throws {TerminalProviderError} When the CLI cannot start or exits non-zero for any other reason.
 * @throws {RetryableProviderError} With kind "timeout" after `timeoutMs`.
 * @throws {unknown} The caller's `signal.reason`, unchanged, on abort.
 * @example
 * ```ts
 * await runCodex({ bin: "true", args: [], cwd: "/tmp", timeoutMs: 1000 }); // => undefined
 * ```
 */
export function runCodex(options: RunCodexOptions): Promise<void> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise<void>((resolve, reject) => {
    // Spawn and track why we kill
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdout = "";
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

    // Settle exactly once, releasing timer and listener
    /**
     * Settles the promise once and releases the timer and abort listener.
     *
     * @param error - Rejection reason; undefined resolves.
     */
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };

    // Wire stream and exit events
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
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
      settle(code === 0 ? undefined : exitError(code, exitSignal, { stderr, stdout }));
    });
  });
}
