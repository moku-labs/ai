import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore, createPlugin } from "../../../../config";
import { buildfilePlugin } from "../../../buildfile";
import { imagePlugin } from "../../../image";
import type { ImageHandler } from "../../../image/contract";
import { registryPlugin } from "../../../registry";
import { runnerPlugin } from "../../../runner";
import type { SpriteHandler } from "../../contract";
import { spritePlugin } from "../../index";
import { processSprite } from "../../process";
import type { SpriteApi } from "../../types";

/**
 * A 32x32 transparent PNG with an opaque 10x6 block at (5,7): what a matte
 * model hands back for a small UI panel.
 *
 * @returns The PNG bytes.
 */
async function panelPng(): Promise<Uint8Array> {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 7; y < 13; y += 1) {
    for (let x = 5; x < 15; x += 1) pixels.set([120, 80, 40, 255], (y * 32 + x) * 4);
  }
  return sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Fake providers: an image provider returning {@link panelPng}, and a sprite
 * provider for the `none` model that calls the real `processSprite`.
 *
 * @param png - The bytes the image provider returns.
 * @returns The two handlers and their call logs.
 */
function fakeHandlers(png: Uint8Array) {
  const imageCalls: string[] = [];
  const spriteCalls: string[] = [];
  const image: ImageHandler = {
    estimate: () => ({ usd: 0.01 }),
    execute: async request => {
      imageCalls.push(request.prompt);
      return { image: png, mimeType: "image/png", costUsd: 0.01 };
    }
  };
  const sprite: SpriteHandler = {
    estimate: request => ({ usd: request.model === "none" ? 0 : 0.002 }),
    execute: async request => {
      spriteCalls.push(request.source.path);
      const cut = await processSprite(await readFile(request.source.path), request);
      return {
        image: cut.image,
        mimeType: "image/png",
        costUsd: 0,
        meta: { width: cut.width, height: cut.height, trimBox: cut.trimBox, model: request.model }
      };
    }
  };
  return { image, sprite, imageCalls, spriteCalls };
}

/**
 * Real app: registry + buildfile + runner + image + sprite, plus the two fake
 * providers registered in `onInit`, core plugins pinned under `tempDir`.
 *
 * @param tempDir - Per-test directory.
 * @param handlers - The fake handlers.
 * @param handlers.image - The image handler.
 * @param handlers.sprite - The sprite handler.
 * @returns The created app.
 */
function buildApp(tempDir: string, handlers: { image: ImageHandler; sprite: SpriteHandler }) {
  const fakeImage = createPlugin("fakeImage", {
    depends: [registryPlugin, imagePlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("image", "fake", handlers.image);
    }
  });
  const fakeSprite = createPlugin("fakeSprite", {
    depends: [registryPlugin, spritePlugin],
    onInit: ctx => {
      ctx.require(registryPlugin).register("sprite", "fake", handlers.sprite);
    }
  });
  return createCore(coreConfig, {
    plugins: [
      registryPlugin,
      buildfilePlugin,
      runnerPlugin,
      imagePlugin,
      spritePlugin,
      fakeImage,
      fakeSprite
    ],
    pluginConfigs: {
      journal: { path: path.join(tempDir, "journal.db") },
      store: { dir: path.join(tempDir, "store") },
      runner: { retryBaseMs: 1, pollIntervalMs: 1 },
      sprite: { defaultProvider: "fake" }
    }
  }).createApp();
}

/** Build file: an image item, then a nine-slice sprite item that `$ref`s it. */
const UI_YAML = `version: 1
name: ui
items:
  - id: panel-raw
    task: image
    provider: fake
    input: { prompt: "wooden game UI panel, flat colour background" }
  - id: "panel{nine=4,4,4,4}"
    task: sprite
    provider: fake
    input: { source: { $ref: panel-raw }, model: none, padding: 1 }
`;

describe("sprite: through a real app", () => {
  let tempDir: string;
  const stops: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-sprite-int-"));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs image then sprite and exports panel{nine=4,4,4,4}.png as a trimmed RGBA PNG", async () => {
    const handlers = fakeHandlers(await panelPng());
    const app = buildApp(tempDir, handlers);
    await app.start();
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "ui.moku.yaml"), UI_YAML);

    const result = await app.runner.run({ files: path.join(tempDir, "*.moku.yaml") });
    const exported = await app.runner.export({ outDir: path.join(tempDir, "out") });

    expect(result).toMatchObject({ status: "done", totals: { total: 2, done: 2 } });
    expect(handlers.spriteCalls).toHaveLength(1);
    const target = path.join(tempDir, "out", "ui", "panel{nine=4,4,4,4}.png");
    expect(exported.files.map(file => file.path)).toContain(target);
    const metadata = await sharp(await readFile(target)).metadata();
    expect(metadata).toMatchObject({
      format: "png",
      channels: 4,
      hasAlpha: true,
      width: 12,
      height: 8
    });
  });

  it("a second run reuses both artifacts: no provider call, no spend", async () => {
    const handlers = fakeHandlers(await panelPng());
    const app = buildApp(tempDir, handlers);
    await app.start();
    stops.push(() => app.stop());
    await writeFile(path.join(tempDir, "ui.moku.yaml"), UI_YAML);
    const files = path.join(tempDir, "*.moku.yaml");

    await app.runner.run({ files });
    const second = await app.runner.run({ files });

    expect(second).toMatchObject({ status: "done", totals: { done: 2, spendUsd: 0 } });
    expect([handlers.imageCalls.length, handlers.spriteCalls.length]).toEqual([1, 1]);
  });

  it("D2: re-cutting with new sprite options never regenerates the image", async () => {
    const handlers = fakeHandlers(await panelPng());
    const app = buildApp(tempDir, handlers);
    await app.start();
    stops.push(() => app.stop());
    const buildFile = path.join(tempDir, "ui.moku.yaml");
    const files = path.join(tempDir, "*.moku.yaml");
    await writeFile(buildFile, UI_YAML);
    await app.runner.run({ files });

    await writeFile(buildFile, UI_YAML.replace("padding: 1", "padding: 3"));
    const second = await app.runner.run({ files });

    expect(second.status).toBe("done");
    expect(handlers.imageCalls).toHaveLength(1);
    expect(handlers.spriteCalls).toHaveLength(2);
  });

  it("app.sprite cuts a file directly, estimates and lists providers", async () => {
    const app = buildApp(tempDir, fakeHandlers(await panelPng()));
    await app.start();
    stops.push(() => app.stop());
    const sourcePath = path.join(tempDir, "panel.png");
    await writeFile(sourcePath, await panelPng());
    const source = { path: sourcePath, mimeType: "image/png", hash: "panel" };

    const sprite = await app.sprite.generate({ source, model: "none" });

    expect(sprite.mimeType).toBe("image/png");
    expect(sprite.meta?.trimBox).toEqual({ left: 5, top: 7, width: 10, height: 6 });
    expect(app.sprite.estimate({ source, model: "none" })).toEqual({ usd: 0 });
    expect(app.sprite.providers()).toEqual(["fake"]);
    expect(() => app.sprite.estimate({ source, model: "none" }, { provider: "acme" })).toThrow(
      '[ai] No sprite provider named "acme" is registered.\n  Available: fake.'
    );
  });

  it("exposes app.sprite typed as SpriteApi", async () => {
    const app = buildApp(tempDir, fakeHandlers(await panelPng()));

    expectTypeOf(app.sprite).toEqualTypeOf<SpriteApi>();
    expect(Object.keys(app.sprite).toSorted()).toEqual(["estimate", "generate", "providers"]);
  });
});
