import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Integration test: registry plugin through the real createApp lifecycle,
// proving the onInit-registration ordering that the "never core" constraint
// depends on — providers register via ctx.require(registryPlugin) in their
// own onInit, and task plugins resolve what was registered.
// ---------------------------------------------------------------------------

/** A fake provider plugin: registers a "voiceover" handler for itself in onInit. */
function createFakeProviderPlugin(name: string) {
  return coreConfig.createPlugin(name, {
    depends: [registryPlugin],
    onInit: ctx => {
      const speak = (text: string): string => `${name}:${text}`;
      ctx.require(registryPlugin).register("voiceover", name, speak);
    }
  });
}

/** A fake task plugin: resolves a provider's handler and performs the one audited cast. */
const fakeTaskPlugin = coreConfig.createPlugin("fakeTask", {
  depends: [registryPlugin],
  api: ctx => ({
    providers: (): string[] => ctx.require(registryPlugin).providers("voiceover"),
    run: (provider: string, text: string): string => {
      const handler = ctx.require(registryPlugin).resolve("voiceover", provider);
      if (typeof handler !== "function") {
        throw new TypeError(`no handler registered for voiceover/${provider}`);
      }
      // ONE audited cast at the task plugin's own boundary (spec/09 R9).
      return (handler as (input: string) => string)(text);
    }
  })
});

describe("registry plugin integration", () => {
  // The framework coreConfig includes the journal core plugin, whose onStart
  // opens SQLite at its configured path — point it at a temp dir so tests
  // never write .moku/ into the repository root.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "registry-integration-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const journalOverride = () => ({ journal: { path: path.join(dir, "journal.db") } });

  it("lets a provider register in onInit and a task plugin resolve it through the real lifecycle", async () => {
    const fakeProviderPlugin = createFakeProviderPlugin("fakeProvider");
    const { createApp } = createCore(coreConfig, {
      plugins: [registryPlugin, fakeProviderPlugin, fakeTaskPlugin],
      pluginConfigs: journalOverride()
    });

    const app = createApp();
    await app.start();

    expect(app.fakeTask.providers()).toEqual(["fakeProvider"]);
    expect(app.fakeTask.run("fakeProvider", "hello")).toBe("fakeProvider:hello");

    await app.stop();
  });

  it("preserves onInit registration order across multiple provider plugins", async () => {
    const providerA = createFakeProviderPlugin("providerA");
    const providerB = createFakeProviderPlugin("providerB");
    const { createApp } = createCore(coreConfig, {
      plugins: [registryPlugin, providerA, providerB, fakeTaskPlugin],
      pluginConfigs: journalOverride()
    });

    const app = createApp();
    await app.start();

    expect(app.fakeTask.providers()).toEqual(["providerA", "providerB"]);

    await app.stop();
  });

  it("exposes the registry API directly on the app surface, independent of any provider", async () => {
    const { createApp } = createCore(coreConfig, {
      plugins: [registryPlugin],
      pluginConfigs: journalOverride()
    });

    const app = createApp();
    await app.start();

    expect(app.registry.tasks()).toEqual([]);
    app.registry.register("translate", "openai", () => {});
    expect(app.registry.tasks()).toEqual(["translate"]);

    await app.stop();
  });
});
