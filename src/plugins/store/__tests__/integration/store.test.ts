import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCoreConfig } from "@moku-labs/core";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { storePlugin } from "../../index";
import type { PutResult } from "../../types";

/**
 * Builds a fresh `createApp` for the given CAS root, wiring a probe regular
 * plugin so tests can exercise `ctx.store` exactly as any other plugin would.
 */
function buildProbeApp(storeDir: string) {
  const coreConfig = createCoreConfig("storeIntegrationApp", {
    config: {},
    plugins: [storePlugin],
    pluginConfigs: { store: { dir: storeDir, algo: "sha256" } }
  });

  const probePlugin = coreConfig.createPlugin("probe", {
    api: ctx => ({
      write: (content: Uint8Array) => ctx.store.put(content),
      read: (hash: string) => ctx.store.read(hash),
      has: (hash: string) => ctx.store.has(hash)
    })
  });

  const framework = coreConfig.createCore(coreConfig, { plugins: [probePlugin] });
  return framework.createApp();
}

describe("store integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-store-integration-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exposes ctx.store on a regular plugin's context", async () => {
    const app = buildProbeApp(path.join(tempDir, "store"));
    const content = new TextEncoder().encode("hello via probe plugin");

    const result = await app.probe.write(content);
    expect(result.existed).toBe(false);

    const readBack = await app.probe.read(result.hash);
    expect(readBack).toEqual(content);
  });

  it("dedupes concurrent put of identical content from two callers into a single file", async () => {
    const app = buildProbeApp(path.join(tempDir, "store"));
    const content = new TextEncoder().encode("concurrent identical payload");

    const [first, second] = await Promise.all([app.probe.write(content), app.probe.write(content)]);

    expect(first.hash).toBe(second.hash);
    expect(first.path).toBe(second.path);

    const shardDir = path.dirname(first.path);
    const entries = await readdir(shardDir);
    const finalEntries = entries.filter(entry => entry === path.basename(first.path));
    expect(finalEntries).toHaveLength(1);
  });

  it("leaves no tmp files behind after a successful put", async () => {
    const app = buildProbeApp(path.join(tempDir, "store"));
    const content = new TextEncoder().encode("no tmp leftovers");

    const result = await app.probe.write(content);
    const shardDir = path.dirname(result.path);
    const entries = await readdir(shardDir);

    expect(entries.some(entry => entry.startsWith(".tmp-"))).toBe(false);
  });

  it("types ctx.store on the regular plugin context and put's resolved shape", () => {
    const app = buildProbeApp(path.join(tempDir, "store"));
    expectTypeOf(app.probe.write).returns.resolves.toEqualTypeOf<PutResult>();
    expectTypeOf(app.probe.has).returns.resolves.toEqualTypeOf<boolean>();
  });
});
