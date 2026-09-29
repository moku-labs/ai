import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { imagePlugin } from "../../../image";
import { promptGenPlugin } from "../../../promptGen";
import { registryPlugin } from "../../../registry";
import { codexPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Integration: codex as a prompt-gen provider through the real createApp
// lifecycle, consumed through app.promptGen. The CLI is a fake shell script
// that writes its answer to <-C dir>/last-message.txt.
// ---------------------------------------------------------------------------

/**
 * Writes a fake `codex` that records its argv to `<root>/args.txt` and
 * answers "ok" in `<-C dir>/last-message.txt`.
 *
 * @param root - Directory to write the script into.
 * @returns Absolute path of the script.
 */
function writeFakeCodexBin(root: string): string {
  const bin = path.join(root, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "-C" ]; then dir="$arg"; fi',
      '  prev="$arg"',
      "done",
      String.raw`printf '%s\n' "$@" > "${root}/args.txt"`,
      String.raw`printf 'ok\n' > "$dir/last-message.txt"`,
      ""
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Assembles registry + image + promptGen + codex, with journal and env
 * pinned to fixtures and the documented local-CLI lane.
 *
 * @param root - Test temp dir (journal database, PATH).
 * @returns The framework (`createApp`).
 */
function buildFramework(root: string) {
  const envProvider: EnvProvider = {
    name: "codex-prompt-gen-fixture",
    load: () => ({ PATH: root })
  };
  return createCore(coreConfig, {
    plugins: [registryPlugin, imagePlugin, promptGenPlugin, codexPlugin],
    pluginConfigs: {
      journal: { path: path.join(root, "journal.db") },
      env: { providers: [envProvider] },
      limits: { lanes: { "prompt-gen/codex": { concurrency: 2 } } }
    }
  });
}

describe("codex prompt-gen integration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-prompt-gen-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registers as a prompt-gen provider next to the image provider", async () => {
    const { createApp } = buildFramework(root);
    const app = createApp();
    await app.start();

    expect(app.promptGen.providers()).toContain("codex");
    expect(app.image.providers()).toContain("codex");

    await app.stop();
  });

  it("answers end-to-end through app.promptGen.generate() at $0", async () => {
    const bin = writeFakeCodexBin(root);
    const { createApp } = buildFramework(root);
    const app = createApp({
      pluginConfigs: { codex: { bin, workDir: path.join(root, "work"), textModel: "gpt-6-sol" } }
    });
    await app.start();

    const result = await app.promptGen.generate(
      { prompt: "Say ok", system: "Be terse." },
      { provider: "codex" }
    );

    expect(result).toEqual({
      text: "ok",
      costUsd: 0,
      meta: { provider: "codex", model: "gpt-6-sol", reasoningEffort: "low" }
    });
    const args = readFileSync(path.join(root, "args.txt"), "utf8");
    expect(args).toContain("--sandbox\nread-only\n");
    expect(args.endsWith("--\nBe terse.\n\nSay ok\n")).toBe(true);
    expect(app.promptGen.estimate({ prompt: "p" }, { provider: "codex" })).toEqual({ usd: 0 });

    await app.stop();
  });
});
