import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EnvProvider } from "@moku-labs/common";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { imagePlugin } from "../../../image";
import { registryPlugin } from "../../../registry";
import { codexPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Integration: codex through the real createCore/createApp lifecycle —
// registered in onInit, consumed through the image task facade. The CLI is
// a fake shell script; the real codex is never called.
// ---------------------------------------------------------------------------

/**
 * Writes a fake `codex` that saves a PNG signature as `<-C dir>/output.png`.
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
      String.raw`printf '\211PNG' > "$dir/output.png"`,
      ""
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Assembles registry + image + codex, with journal and env pinned to fixtures.
 *
 * @param dbPath - Journal database path inside the test temp dir.
 * @param pathValue - PATH value the env fixture exposes.
 * @returns The framework (`createApp`).
 */
function buildFramework(dbPath: string, pathValue: string) {
  const envProvider: EnvProvider = {
    name: "codex-integration-fixture",
    load: () => ({ PATH: pathValue })
  };
  return createCore(coreConfig, {
    plugins: [registryPlugin, imagePlugin, codexPlugin],
    pluginConfigs: { journal: { path: dbPath }, env: { providers: [envProvider] } }
  });
}

describe("codex integration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "moku-codex-integration-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registers as an image provider in onInit", async () => {
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp();
    await app.start();

    expect(app.image.providers()).toContain("codex");

    await app.stop();
  });

  it("generates an image end-to-end through app.image.generate()", async () => {
    const bin = writeFakeCodexBin(root);
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp({
      pluginConfigs: { codex: { bin, workDir: path.join(root, "work") } }
    });
    await app.start();

    const result = await app.image.generate(
      { prompt: "cream-walled patisserie, night", aspect: "9:16" },
      { provider: "codex" }
    );

    expect(result.image).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(result.mimeType).toBe("image/png");
    expect(result.costUsd).toBe(0);
    expect(app.image.estimate({ prompt: "p" }, { provider: "codex" })).toEqual({ usd: 0 });

    await app.stop();
  });

  it("reports configured through app.codex.info(), resolving the bare bin via env PATH", async () => {
    writeFakeCodexBin(root);
    const { createApp } = buildFramework(path.join(root, "journal.db"), root);
    const app = createApp();
    await app.start();

    const info = app.codex.info();

    expect(info).toEqual({ provider: "codex", configured: true, models: ["gpt-6-astra"] });
    expectTypeOf(info.provider).toEqualTypeOf<"codex">();

    await app.stop();
  });
});
