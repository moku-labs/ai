import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processSprite } from "../../process";

// ---------------------------------------------------------------------------
// sprite: processSprite (real sharp, fixtures generated in the test)
// ---------------------------------------------------------------------------

/** A rectangle drawn into a fixture: position, size and alpha. */
type Block = { left: number; top: number; width: number; height: number; alpha: number };

/**
 * Encodes an RGBA PNG of `width` x `height`: fully transparent, with each
 * block painted opaque red at its alpha.
 *
 * @param width - Canvas width, px.
 * @param height - Canvas height, px.
 * @param blocks - Blocks to paint.
 * @returns The PNG bytes.
 */
async function pngWith(width: number, height: number, blocks: Block[]): Promise<Uint8Array> {
  const pixels = new Uint8Array(width * height * 4);
  for (const block of blocks) {
    for (let y = block.top; y < block.top + block.height; y += 1) {
      for (let x = block.left; x < block.left + block.width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels.set([255, 0, 0, block.alpha], offset);
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Decodes PNG bytes into raw RGBA plus the PNG's own metadata.
 *
 * @param png - The PNG bytes.
 * @returns The format, channel count, size and raw pixels.
 */
async function decode(png: Uint8Array) {
  const metadata = await sharp(png).metadata();
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return {
    format: metadata.format,
    channels: metadata.channels,
    hasAlpha: metadata.hasAlpha,
    width: info.width,
    height: info.height,
    data
  };
}

/**
 * The distinct alpha values of raw RGBA pixels.
 *
 * @param data - Raw RGBA bytes.
 * @returns The sorted distinct alpha values.
 */
function alphaValues(data: Uint8Array): number[] {
  const seen = new Set<number>();
  for (let index = 3; index < data.length; index += 4) seen.add(data[index] ?? 0);
  return [...seen].toSorted((a, b) => a - b);
}

/**
 * The bounding box of the fully opaque pixels of raw RGBA pixels.
 *
 * @param data - Raw RGBA bytes.
 * @param width - Image width, px.
 * @param height - Image height, px.
 * @returns The box, or undefined when no pixel is fully opaque.
 */
function opaqueBox(data: Uint8Array, width: number, height: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] !== 255) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length === 0) return undefined;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left + 1, height: Math.max(...ys) - top + 1 };
}

/**
 * The RGBA bytes of the pixels within `border` px of any edge.
 *
 * @param data - Raw RGBA bytes.
 * @param width - Image width, px.
 * @param height - Image height, px.
 * @param border - Border width, px.
 * @returns The border pixels as raw RGBA bytes.
 */
function borderAlpha(data: Uint8Array, width: number, height: number, border: number): Uint8Array {
  const kept: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= border && x < width - border && y >= border && y < height - border;
      if (inside) continue;
      const offset = (y * width + x) * 4;
      kept.push(...data.subarray(offset, offset + 4));
    }
  }
  return new Uint8Array(kept);
}

/** The spec fixture: a 32x32 transparent canvas with an opaque 10x6 block at (5,7). */
const BLOCK: Block = { left: 5, top: 7, width: 10, height: 6, alpha: 255 };

/** The trim box of {@link BLOCK}. */
const BLOCK_BOX = { left: 5, top: 7, width: 10, height: 6 };

/** A small block that fits an 8x8 canvas. */
const BLOCK_SMALL: Block = { left: 2, top: 2, width: 3, height: 3, alpha: 255 };

describe("sprite: processSprite", () => {
  it("trims a 32x32 canvas to its opaque 10x6 block and reports the trim box", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {});

    expect(result.trimBox).toEqual({ left: 5, top: 7, width: 10, height: 6 });
    expect([result.width, result.height]).toEqual([10, 6]);
    const decoded = await decode(result.image);
    expect(decoded).toMatchObject({ format: "png", channels: 4, hasAlpha: true, width: 10 });
    expect(alphaValues(decoded.data)).toEqual([255]);
  });

  it("returns a plain Uint8Array", async () => {
    const result = await processSprite(await pngWith(8, 8, [BLOCK_SMALL]), {});

    expect(result.image).toBeInstanceOf(Uint8Array);
  });

  it("ignores pixels at or below alphaThreshold when trimming", async () => {
    const faint: Block = { left: 0, top: 0, width: 32, height: 2, alpha: 8 };
    const png = await pngWith(32, 32, [BLOCK, faint]);

    const strict = await processSprite(png, {});
    const loose = await processSprite(png, { alphaThreshold: 7 });

    expect(strict.trimBox).toEqual(BLOCK_BOX);
    expect(loose.trimBox).toEqual({
      left: 0,
      top: 0,
      width: 32,
      height: 13
    });
  });

  it("adds transparent padding around the trimmed box", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), { padding: 3 });

    expect([result.width, result.height]).toEqual([16, 12]);
    expect(result.trimBox).toEqual(BLOCK_BOX);
    const decoded = await decode(result.image);
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[(3 * 16 + 3) * 4 + 3]).toBe(255);
  });

  it("with size, resizes into size minus padding, then pads: a 12x12 content box in a 2 px border", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {
      padding: 2,
      size: { width: 16, height: 16 },
      fit: "fill"
    });

    expect([result.width, result.height]).toEqual([16, 16]);
    expect(result.trimBox).toEqual(BLOCK_BOX);
    const decoded = await decode(result.image);
    expect([decoded.width, decoded.height]).toEqual([16, 16]);
    expect(opaqueBox(decoded.data, 16, 16)).toEqual({ left: 2, top: 2, width: 12, height: 12 });
    expect(alphaValues(borderAlpha(decoded.data, 16, 16, 2))).toEqual([0]);
  });

  it("with size and contain, the letterboxed content stays inside the padding border", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {
      padding: 3,
      size: { width: 20, height: 20 }
    });

    const decoded = await decode(result.image);
    expect([decoded.width, decoded.height]).toEqual([20, 20]);
    expect(alphaValues(borderAlpha(decoded.data, 20, 20, 3))).toEqual([0]);
    // 10x6 contained in the 14x14 content box is 14x8, centred vertically.
    expect(opaqueBox(decoded.data, 20, 20)).toEqual({ left: 3, top: 6, width: 14, height: 8 });
  });

  it("accepts the largest padding that leaves 1 px inside size", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {
      padding: 7,
      size: { width: 16, height: 15 },
      fit: "fill"
    });

    expect([result.width, result.height]).toEqual([16, 15]);
  });

  it("contain letterboxes the 10x6 block into 16x16 with transparent bands", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {
      size: { width: 16, height: 16 }
    });

    const decoded = await decode(result.image);
    expect([decoded.width, decoded.height, decoded.channels]).toEqual([16, 16, 4]);
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[(8 * 16 + 8) * 4 + 3]).toBe(255);
  });

  it("cover fills 16x16 with the block, cropping its sides", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {
      size: { width: 16, height: 16 },
      fit: "cover"
    });

    const decoded = await decode(result.image);
    expect([decoded.width, decoded.height]).toEqual([16, 16]);
    expect(alphaValues(decoded.data)).toEqual([255]);
  });

  it("fill stretches the block to 16x16", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), {
      size: { width: 16, height: 16 },
      fit: "fill"
    });

    const decoded = await decode(result.image);
    expect([decoded.width, decoded.height]).toEqual([16, 16]);
    expect(alphaValues(decoded.data)).toEqual([255]);
  });

  it("pixelArt keeps hard edges: only two distinct alpha values after a resize", async () => {
    const checker: Block[] = [
      { left: 0, top: 0, width: 2, height: 2, alpha: 255 },
      { left: 2, top: 2, width: 2, height: 2, alpha: 255 }
    ];
    const png = await pngWith(4, 4, checker);
    const options = { trim: false, size: { width: 13, height: 13 }, fit: "fill" } as const;

    const hard = await processSprite(png, { ...options, pixelArt: true });
    const smooth = await processSprite(png, options);

    const hardPixels = await decode(hard.image);
    const smoothPixels = await decode(smooth.image);
    expect(alphaValues(hardPixels.data)).toEqual([0, 255]);
    expect(alphaValues(smoothPixels.data).length).toBeGreaterThan(2);
  });

  it("trim:false keeps the full size and reports the whole canvas as the box", async () => {
    const result = await processSprite(await pngWith(32, 32, [BLOCK]), { trim: false });

    expect([result.width, result.height]).toEqual([32, 32]);
    expect(result.trimBox).toEqual({ left: 0, top: 0, width: 32, height: 32 });
  });

  it("adds an alpha channel to an opaque RGB source", async () => {
    const rgb = await sharp({
      create: { width: 6, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } }
    })
      .png()
      .toBuffer();

    const result = await processSprite(rgb, {});

    expect(result.trimBox).toEqual({ left: 0, top: 0, width: 6, height: 4 });
    expect(await decode(result.image)).toMatchObject({ channels: 4, hasAlpha: true });
  });

  it("throws the empty-sprite error for a fully transparent image", async () => {
    await expect(processSprite(await pngWith(16, 16, []), {})).rejects.toThrow(
      "[ai] Sprite is empty after background removal.\n  Check the source image or lower alphaThreshold."
    );
  });

  it("throws the empty-sprite error with trim:false too", async () => {
    await expect(processSprite(await pngWith(16, 16, []), { trim: false })).rejects.toThrow(
      "[ai] Sprite is empty after background removal."
    );
  });

  describe("input checks, before any work", () => {
    const notAnImage = new Uint8Array([1, 2, 3]);

    it.each([
      [{ width: 0, height: 16 }],
      [{ width: 16, height: 1.5 }],
      [{ width: Number.NaN, height: 16 }]
    ])("rejects size %o", async size => {
      await expect(processSprite(notAnImage, { size })).rejects.toThrow(
        /^\[ai\] Sprite size must be whole pixels of at least 1, got .+\.\n {2}Set size\.width and size\.height to integers of 1 or more\.$/
      );
    });

    it.each([-1, 0.5])("rejects padding %d", async padding => {
      await expect(processSprite(notAnImage, { padding })).rejects.toThrow(
        `[ai] Sprite padding must be a whole number of pixels of 0 or more, got ${padding}.\n  Set padding to an integer of 0 or more.`
      );
    });

    it.each([-1, 256, Number.NaN])("rejects alphaThreshold %d", async alphaThreshold => {
      await expect(processSprite(notAnImage, { alphaThreshold })).rejects.toThrow(
        `[ai] Sprite alphaThreshold must be between 0 and 255, got ${alphaThreshold}.\n  Set alphaThreshold to a value from 0 to 255.`
      );
    });

    it.each([
      [8, { width: 16, height: 16 }],
      [4, { width: 20, height: 8 }],
      [5, { width: 9, height: 32 }]
    ])("rejects padding %d that leaves no room inside size %o", async (padding, size) => {
      await expect(processSprite(notAnImage, { padding, size })).rejects.toThrow(
        `[ai] Sprite padding ${padding} leaves no room inside ${size.width}x${size.height}.\n  Lower padding or raise size.`
      );
    });

    it("rejects an unknown fit", async () => {
      // A build file can carry any string; the type rejects it, the runtime check too.
      // @ts-expect-error -- "stretch" is not a SpriteRequest fit
      const pending = processSprite(notAnImage, { size: { width: 4, height: 4 }, fit: "stretch" });
      await expect(pending).rejects.toThrow(
        '[ai] Sprite fit must be "contain", "cover" or "fill", got "stretch".\n  Set fit to one of those values.'
      );
    });

    it("accepts the edge values 0 padding and thresholds 0 and 255", async () => {
      const png = await pngWith(4, 4, [{ left: 1, top: 1, width: 1, height: 1, alpha: 255 }]);

      await expect(processSprite(png, { padding: 0, alphaThreshold: 0 })).resolves.toMatchObject({
        width: 1
      });
      await expect(processSprite(png, { alphaThreshold: 254 })).resolves.toMatchObject({
        width: 1
      });
      await expect(processSprite(png, { alphaThreshold: 255 })).rejects.toThrow(/empty/);
    });
  });
});
