import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { promptGenPlugin } from "../../../promptGen";
import { registryPlugin } from "../../../registry";
import { claudePlugin } from "../../index";
import type { ClaudeInfo } from "../../types";

// ---------------------------------------------------------------------------
// Integration: claude through the real createCore/createApp lifecycle —
// registered in onInit, consumed through app.promptGen. The CLI is a fake
// shell script; the real claude is never called.
// ---------------------------------------------------------------------------

/** A successful `claude -p --output-format json` result. */
const SUCCESS_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  total_cost_usd: 0.114_22,
  usage: { input_tokens: 12, output_tokens: 3 }
});

/**
 * Writes a fake `claude` that drains stdin and prints the success JSON.
 *
 * @param root - Directory to write the script into.
 * @returns Absolute path of the script.
 */
function writeFakeClaudeBin(root: string): string {
  const bin = path.join(root, "claude");
  writeFileSync(
    bin,
    ["#!/bin/sh", "cat > /dev/null", `cat <<'EOF'\n${SUCCESS_STDOUT}\nEOF`, ""].join("\n")
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** A fake prompt-gen provider that echoes the prompt, registered as "backup". */
const backupPlugin = coreConfig.createPlugin("backup", {
  depends: [registryPlugin],
  onInit: ctx => {
    ctx.require(registryPlugin).register("prompt-gen", "backup", {
      estimate: () => ({ usd: 0 }),
      execute: async (request: { prompt: string }) => ({
        text: `backup:${request.prompt}`,
        costUsd: 0
      })
    });
  }
});

/**
 * Assembles registry + promptGen + claude + backup, with journal and env
 * pinned to fixtures.
 *
 * @param dbPath - Journal database path inside the test temp dir.
 * @param pathValue - PATH value the env fixture exposes.
 * @returns The framework (`createApp`).
 */
function buildFramework(dbPath: string, pathValue: string) {
  const envProvider: EnvProvider = {
    name: "claude-integration-fixture",
    load: () => ({ PATH: pathValue })
  };
  return createCore(coreConfig, {
    plugins: [registryPlugin, promptGenPlugin, claudePlugin, backupPlugin],
    pluginConfigs: { journal: { path: dbPath }, env: { providers: [envProvider] } }
  });
}

describe("claude integration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-claude-integration-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registers as a prompt-gen provider in onInit", async () => {
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp();
    await app.start();

    expect(app.promptGen.providers()).toContain("claude");
    expect(app.promptGen.estimate({ prompt: "p" }, { provider: "claude" })).toEqual({ usd: 0 });

    await app.stop();
  });

  it("answers end-to-end through app.promptGen.generate() and removes its temp dir", async () => {
    const bin = writeFakeClaudeBin(root);
    const work = path.join(root, "work");
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp({ pluginConfigs: { claude: { bin, workDir: work } } });
    await app.start();

    const result = await app.promptGen.generate(
      { prompt: "Say ok.", model: "anthropic/claude-opus-5.5" },
      { provider: "claude" }
    );

    expect(result.text).toBe("ok");
    expect(result.costUsd).toBe(0);
    expect(result.usage).toStrictEqual({
      promptTokens: 12,
      completionTokens: 3,
      cachedTokens: 0,
      cacheWriteTokens: 0
    });
    expect(result.meta).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      listCostUsd: 0.114_22,
      usage: { inputTokens: 12, outputTokens: 3 }
    });
    expect(readdirSync(work)).toEqual([]);

    await app.stop();
  });

  it("falls back to the next provider when the claude bin is missing", async () => {
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp({
      pluginConfigs: {
        claude: { bin: path.join(root, "nope", "claude"), workDir: path.join(root, "work") },
        promptGen: { defaultProvider: "claude", fallback: ["backup"] }
      }
    });
    await app.start();

    const result = await app.promptGen.generate({ prompt: "hi" });

    expect(result.text).toBe("backup:hi");
    expect(result.meta).toMatchObject({ provider: "backup" });

    await app.stop();
  });

  it("falls back to the next provider when the request has messages", async () => {
    const bin = writeFakeClaudeBin(root);
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp({
      pluginConfigs: {
        claude: { bin, workDir: path.join(root, "work") },
        promptGen: { defaultProvider: "claude", fallback: ["backup"] }
      }
    });
    await app.start();

    const result = await app.promptGen.generate({
      prompt: "hi",
      messages: [{ role: "user", content: "Check shot 3." }]
    });

    expect(result.text).toBe("backup:hi");

    await app.stop();
  });

  it("reports configured through a typed app.claude.info(), resolving the bare bin via env PATH", async () => {
    writeFakeClaudeBin(root);
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp();
    await app.start();

    const info = app.claude.info();

    expect(info).toEqual({ provider: "claude", configured: true });
    expectTypeOf(info).toEqualTypeOf<ClaudeInfo>();

    await app.stop();
  });
});
