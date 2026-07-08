import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { createStoreApi } from "../../api";
import { createStoreState } from "../../state";
import type { Config, GcResult, PutResult, State, StoreApi } from "../../types";

/**
 * Builds a fresh store context (config + state) rooted at a unique temp dir.
 */
async function createTestCtx(): Promise<{
  config: Readonly<Config>;
  state: State;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "moku-store-unit-"));
  const config: Config = { dir: path.join(dir, "store"), algo: "sha256" };
  return {
    config,
    state: createStoreState(),
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

/**
 * Builds the expected malformed-hash error message for a given input.
 */
function malformedError(hash: string): string {
  return `[ai] Store received a malformed hash "${hash}".\n  Expected a 64-character lowercase sha256 hex digest.`;
}

describe("store unit", () => {
  describe("state", () => {
    it("starts with rootEnsured false", () => {
      expect(createStoreState()).toEqual({ rootEnsured: false });
    });
  });

  describe("api", () => {
    let ctx: Awaited<ReturnType<typeof createTestCtx>>;
    let api: StoreApi;

    beforeEach(async () => {
      ctx = await createTestCtx();
      api = createStoreApi(ctx);
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    it("computes a stable hash for identical content", () => {
      const first = new TextEncoder().encode("hello world");
      const second = new TextEncoder().encode("hello world");
      expect(api.hashOf(first)).toBe(api.hashOf(second));
    });

    it("computes different hashes for different content", () => {
      const a = api.hashOf(new TextEncoder().encode("hello"));
      const b = api.hashOf(new TextEncoder().encode("world"));
      expect(a).not.toBe(b);
    });

    it("does not create the root dir before the first put (lazy root creation)", async () => {
      expect(ctx.state.rootEnsured).toBe(false);
      const content = new TextEncoder().encode("lazy init");
      await api.put(content);
      expect(ctx.state.rootEnsured).toBe(true);
    });

    it("derives a 2-hex-char shard-prefixed path for a hash", async () => {
      const content = new TextEncoder().encode("shard me");
      const result = await api.put(content);
      const hash = api.hashOf(content);
      expect(result.path).toBe(path.join(ctx.config.dir, hash.slice(0, 2), hash));
    });

    it("round-trips content through put then read", async () => {
      const content = new TextEncoder().encode("round trip payload");
      const { hash } = await api.put(content);
      const readBack = await api.read(hash);
      expect(readBack).toEqual(content);
    });

    it("reports existed: false on first put and existed: true on duplicate put", async () => {
      const content = new TextEncoder().encode("dedup me");
      const first = await api.put(content);
      const second = await api.put(content);
      expect(first.existed).toBe(false);
      expect(second.existed).toBe(true);
      expect(second.hash).toBe(first.hash);
      expect(second.path).toBe(first.path);
    });

    it("has() reflects presence before and after put", async () => {
      const content = new TextEncoder().encode("presence check");
      const hash = api.hashOf(content);
      expect(await api.has(hash)).toBe(false);
      await api.put(content);
      expect(await api.has(hash)).toBe(true);
    });

    it("pathOf throws a not-found error for a hash that was never written", () => {
      const missingHash = "0".repeat(64);
      expect(() => api.pathOf(missingHash)).toThrow(
        /\[ai\] Store object not found for hash 0{64}\.\n {2}/
      );
    });

    it("pathOf returns the shard-prefixed path once the hash has been written", async () => {
      const content = new TextEncoder().encode("resolvable");
      const { hash } = await api.put(content);
      expect(api.pathOf(hash)).toBe(path.join(ctx.config.dir, hash.slice(0, 2), hash));
    });

    it("read throws a two-line not-found error for a missing hash", async () => {
      const missingHash = "f".repeat(64);
      await expect(api.read(missingHash)).rejects.toThrow(
        /\[ai\] Store object not found for hash f{64}\.\n {2}/
      );
    });

    it("read throws the exact two-line integrity error when the file is tampered", async () => {
      const content = new TextEncoder().encode("integrity check payload");
      const { hash, path: objectPath } = await api.put(content);
      await writeFile(objectPath, new TextEncoder().encode("tampered bytes"));

      await expect(api.read(hash)).rejects.toThrow(
        `[ai] Store integrity check failed for ${hash}.\n  The artifact is corrupt; delete it and re-run to regenerate.`
      );
    });

    it("gc removes only hashes not in the keep-set and reports bytes freed", async () => {
      const keepContent = new TextEncoder().encode("keep this one");
      const dropContent = new TextEncoder().encode("drop this one, it is longer");
      const keep = await api.put(keepContent);
      const drop = await api.put(dropContent);

      const result: GcResult = await api.gc(new Set([keep.hash]));

      expect(result.removed).toBe(1);
      expect(result.bytesFreed).toBe(dropContent.byteLength);
      expect(await api.has(keep.hash)).toBe(true);
      expect(await api.has(drop.hash)).toBe(false);
    });

    it("gc is a no-op returning zero counts when the root dir was never created", async () => {
      const result = await api.gc(new Set());
      expect(result).toEqual({ removed: 0, bytesFreed: 0 });
    });
  });

  describe("hash validation", () => {
    let ctx: Awaited<ReturnType<typeof createTestCtx>>;
    let api: StoreApi;

    beforeEach(async () => {
      ctx = await createTestCtx();
      api = createStoreApi(ctx);
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    it("pathOf rejects a path-traversal hash before touching the filesystem", () => {
      const traversal = "../../../etc/passwd";
      expect(() => api.pathOf(traversal)).toThrow(malformedError(traversal));
    });

    it("pathOf rejects uppercase and short hashes", () => {
      const uppercase = "A".repeat(64);
      const short = "abc123";
      expect(() => api.pathOf(uppercase)).toThrow(malformedError(uppercase));
      expect(() => api.pathOf(short)).toThrow(malformedError(short));
    });

    it("has rejects a malformed hash", async () => {
      await expect(api.has("../escape")).rejects.toThrow(malformedError("../escape"));
    });

    it("read rejects a malformed hash before opening any file", async () => {
      await expect(api.read("../../secret")).rejects.toThrow(malformedError("../../secret"));
    });

    it("still resolves well-formed unknown hashes to the not-found error (guard does not over-block)", () => {
      const unknown = "0".repeat(64);
      expect(() => api.pathOf(unknown)).toThrow(`[ai] Store object not found for hash ${unknown}.`);
    });
  });

  describe("types", () => {
    it("put resolves to the documented PutResult shape", () => {
      expectTypeOf<StoreApi["put"]>().returns.resolves.toEqualTypeOf<PutResult>();
    });

    it("gc resolves to the documented GcResult shape", () => {
      expectTypeOf<StoreApi["gc"]>().returns.resolves.toEqualTypeOf<GcResult>();
    });

    it("hashOf and pathOf are synchronous string-returning functions", () => {
      expectTypeOf<StoreApi["hashOf"]>().returns.toEqualTypeOf<string>();
      expectTypeOf<StoreApi["pathOf"]>().returns.toEqualTypeOf<string>();
    });
  });
});
