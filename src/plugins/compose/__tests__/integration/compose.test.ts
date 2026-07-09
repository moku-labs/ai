import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { promptGenPlugin } from "../../../promptGen";
import type { PromptGenHandler, PromptGenRequest, PromptGenResult } from "../../../promptGen/types";
import { registryPlugin } from "../../../registry";
import { composePlugin } from "../../index";
import type { ComposeResult } from "../../types";

// ---------------------------------------------------------------------------
// Integration test: compose plugin through the real createApp lifecycle — a
// fake prompt-gen provider registers a canned YAML response in onInit, and
// app.compose.compose() round-trips through the real registry + promptGen +
// buildfile plugins.
// ---------------------------------------------------------------------------

const CANNED_YAML =
  'version: 1\nname: demo\nitems:\n  - task: prompt-gen\n    input:\n      prompt: "Describe a sunset over the ocean."\n';

/** A canned prompt-gen handler that always returns a fixed, valid build-file YAML string. */
function createCannedHandler(): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest) => ({ usd: request.prompt.length / 10_000 }),
    execute: async (): Promise<PromptGenResult> => ({ text: CANNED_YAML, costUsd: 0.001 })
  };
}

/** A fake prompt-gen provider plugin: registers a canned handler for itself in onInit. */
function createFakeProviderPlugin(name: string) {
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("prompt-gen", name, createCannedHandler());
    }
  });
}

/**
 * Converts a relative filesystem path into a valid relative ES module
 * import specifier (ensures a leading "./" or "../"). Mirrors buildfile's
 * own integration test — a temp-dir-written script can't resolve the
 * published "@moku-labs/ai" package name, so the fixture is patched to
 * import the real source file by relative path instead.
 */
function toImportSpecifier(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

describe("compose integration", () => {
  // The framework coreConfig includes the journal core plugin, whose onStart
  // opens SQLite at its configured path — point it at a temp dir so tests
  // never write .moku/ into the repository root.
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-compose-integration-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Assembles a fresh framework with a fake "openai" prompt-gen provider registered. */
  function buildFramework() {
    return createCore(coreConfig, {
      plugins: [
        registryPlugin,
        buildfilePlugin,
        createFakeProviderPlugin("openai"),
        promptGenPlugin,
        composePlugin
      ],
      pluginConfigs: { journal: { path: path.join(tempDir, "journal.db") } }
    });
  }

  it("exercises the full lifecycle: createApp -> start -> compose(emit: build) -> stop", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const result = await app.compose.compose({
      prompt: "describe a sunset over the ocean",
      emit: "build"
    });

    expect(result.spec.name).toBe("demo");
    expect(result.costUsd).toBe(0.001);

    await app.stop();
  });

  it("compose(emit: build)'s text round-trips through buildfile.compile", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const result = await app.compose.compose({ prompt: "describe a sunset", emit: "build" });
    const recompiled = await app.buildfile.compile({ text: result.text, lang: "yaml" });

    expect(recompiled.spec).toEqual(result.spec);

    await app.stop();
  });

  it("compose(emit: script)'s text compiles through buildfile's TS loader", async () => {
    const { createApp } = buildFramework();
    const app = createApp();
    await app.start();

    const result = await app.compose.compose({ prompt: "describe a sunset", emit: "script" });
    expect(result.text).toContain('import { defineBuild } from "@moku-labs/ai";');

    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const definePath = path.resolve(pluginDir, "../../../buildfile/define.ts");
    const scriptPath = path.join(tempDir, "build.moku.ts");
    const importSpecifier = toImportSpecifier(path.relative(tempDir, definePath));
    const patchedText = result.text.replace(
      'import { defineBuild } from "@moku-labs/ai";',
      `import { defineBuild } from "${importSpecifier}";`
    );
    await writeFile(scriptPath, patchedText);

    const compiled = await app.buildfile.compile({ path: scriptPath });

    expect(compiled.spec).toEqual(result.spec);

    await app.stop();
  });

  it("registers a second provider and honors an explicit config.provider override via pluginConfigs", async () => {
    const { createApp } = createCore(coreConfig, {
      plugins: [
        registryPlugin,
        buildfilePlugin,
        createFakeProviderPlugin("openai"),
        createFakeProviderPlugin("anthropic"),
        promptGenPlugin,
        composePlugin
      ],
      pluginConfigs: { journal: { path: path.join(tempDir, "journal.db") } }
    });
    const app = createApp({
      pluginConfigs: { compose: { provider: "anthropic", maxRepairAttempts: 2 } }
    });
    await app.start();

    const result = await app.compose.compose({ prompt: "describe a sunset", emit: "build" });

    expect(result.spec.name).toBe("demo");

    await app.stop();
  });

  describe("types: app.compose", () => {
    it("compose resolves a ComposeResult", async () => {
      const { createApp } = buildFramework();
      const app = createApp();
      await app.start();

      expectTypeOf(app.compose.compose).returns.resolves.toEqualTypeOf<ComposeResult>();

      await app.stop();
    });

    it("compose()'s options require a prompt field at compile time", async () => {
      const { createApp } = buildFramework();
      const app = createApp();
      await app.start();

      // @ts-expect-error -- prompt is required on compose()'s options
      const result = await app.compose.compose({ emit: "build" });
      expect(result.spec.name).toBe("demo");

      await app.stop();
    });
  });
});
