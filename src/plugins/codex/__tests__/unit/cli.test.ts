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
import { buildCodexArguments, isBinResolvable, runCodex } from "../../cli";
import { RetryableProviderError, TerminalProviderError } from "../../types";
import { writeFakeCodex } from "./fixtures";

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

  it("rejects with a terminal 'not found' error when the bin does not exist", async () => {
    const bin = path.join(root, "no-such-codex");

    const error = await runCodex({ bin, args: [], cwd: root, timeoutMs: 5000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(TerminalProviderError);
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
