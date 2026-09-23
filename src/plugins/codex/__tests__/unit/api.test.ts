import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexApi } from "../../api";
import { createFakeEnv, createTestCtx, writeFakeCodex } from "./fixtures";

describe("createCodexApi", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-api-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports provider "codex" and the bundled models', () => {
    const info = createCodexApi(createTestCtx()).info();

    expect(info.provider).toBe("codex");
    expect(info.models).toEqual(["gpt-6-astra"]);
  });

  it("includes price-override-only models", () => {
    const info = createCodexApi(createTestCtx({ config: { priceOverrides: { extra: 0 } } })).info();

    expect(info.models).toContain("extra");
  });

  it("is configured when a bare bin is found on PATH read through ctx.env", () => {
    writeFakeCodex(root, "exit 0");
    const ctx = createTestCtx({
      config: { bin: "fake-codex" },
      env: createFakeEnv({ PATH: root })
    });

    expect(createCodexApi(ctx).info().configured).toBe(true);
  });

  it("is not configured when the bare bin is missing from PATH", () => {
    const ctx = createTestCtx({
      config: { bin: "fake-codex" },
      env: createFakeEnv({ PATH: root })
    });

    expect(createCodexApi(ctx).info().configured).toBe(false);
  });

  it("checks a path-like bin directly", () => {
    const bin = writeFakeCodex(root, "exit 0");

    expect(createCodexApi(createTestCtx({ config: { bin } })).info().configured).toBe(true);
  });
});
