import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeApi } from "../../api";
import { createFakeEnv, createTestCtx, writeFakeClaude } from "./fixtures";

describe("createClaudeApi", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-claude-api-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is configured when a bare bin is found on PATH read through ctx.env", () => {
    writeFakeClaude(root, "exit 0");
    const ctx = createTestCtx({
      config: { bin: "fake-claude" },
      env: createFakeEnv({ PATH: root })
    });

    expect(createClaudeApi(ctx).info()).toEqual({ provider: "claude", configured: true });
  });

  it("is not configured when the bare bin is missing from PATH", () => {
    const ctx = createTestCtx({
      config: { bin: "fake-claude" },
      env: createFakeEnv({ PATH: root })
    });

    expect(createClaudeApi(ctx).info()).toEqual({ provider: "claude", configured: false });
  });

  it("checks a path-like bin directly", () => {
    const bin = writeFakeClaude(root, "exit 0");

    expect(createClaudeApi(createTestCtx({ config: { bin } })).info().configured).toBe(true);
    expect(
      createClaudeApi(createTestCtx({ config: { bin: path.join(root, "nope") } })).info().configured
    ).toBe(false);
  });
});
