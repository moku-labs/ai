import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { registryPlugin } from "../../../registry";
import type { ImageHandler, ImageRequest } from "../../contract";
import { imagePlugin } from "../../index";

/**
 * Real app: registry + image + one fake provider registered in `onInit`.
 *
 * @param tempDir - Directory for the journal and store.
 * @param handler - The fake image handler.
 * @returns The created app.
 * @example
 * ```ts
 * const app = buildApp(tempDir, handler);
 * ```
 */
function buildApp(tempDir: string, handler: ImageHandler) {
  const fakeProvider = createPlugin("fakeImageProvider", {
    depends: [registryPlugin, imagePlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("image", "fake", handler);
    }
  });
  return createCore(coreConfig, {
    plugins: [registryPlugin, imagePlugin, fakeProvider],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      image: { defaultProvider: "fake" }
    }
  }).createApp();
}

describe("image: through a real app", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "image-int-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates, estimates and lists providers through the registered handler", async () => {
    const seen: ImageRequest[] = [];
    const handler: ImageHandler = {
      estimate: () => ({ usd: 0 }),
      execute: async request => {
        seen.push(request);
        return { image: new Uint8Array([137, 80]), mimeType: "image/png", costUsd: 0 };
      }
    };
    const app = buildApp(tempDir, handler);
    await app.start();

    const result = await app.image.generate({ prompt: "patisserie at night", aspect: "9:16" });

    expect(result).toMatchObject({ mimeType: "image/png", costUsd: 0 });
    expect(seen).toEqual([{ prompt: "patisserie at night", aspect: "9:16" }]);
    expect(app.image.estimate({ prompt: "x" })).toEqual({ usd: 0 });
    expect(app.image.providers()).toEqual(["fake"]);
    await app.stop();
  });

  it("names the available providers when an unknown one is asked for", async () => {
    const app = buildApp(tempDir, {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({ image: new Uint8Array(), mimeType: "image/png", costUsd: 0 })
    });
    await app.start();

    await expect(app.image.generate({ prompt: "x" }, { provider: "nope" })).rejects.toThrow(
      '[ai] No image provider named "nope" is registered.\n  Available: fake.'
    );
    await app.stop();
  });
});
