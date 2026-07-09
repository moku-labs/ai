import { describe, expect, expectTypeOf, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { registryPlugin } from "../../index";

// ---------------------------------------------------------------------------
// Nano tier: registry plugin (dumb task→provider→handler transport)
// ---------------------------------------------------------------------------

function createTestApp() {
  const { createApp } = createCore(coreConfig, { plugins: [registryPlugin] });
  return createApp();
}

/** Reference handler used to prove resolve() returns the exact registered value. */
const elevenlabsHandler = (): string => "elevenlabs-handler";

/** Opaque filler handler — the registry transports handlers without ever invoking them. */
const opaqueHandler = (): string => "opaque";

describe("nano tier: registry plugin", () => {
  // -------------------------------------------------------------------------
  // Runtime: register/resolve
  // -------------------------------------------------------------------------

  describe("runtime: register/resolve", () => {
    it("round-trips a registered handler through resolve", () => {
      const app = createTestApp();

      app.registry.register("voiceover", "elevenlabs", elevenlabsHandler);

      expect(app.registry.resolve("voiceover", "elevenlabs")).toBe(elevenlabsHandler);
    });

    it("throws the exact two-line duplicate-registration error", () => {
      const app = createTestApp();
      app.registry.register("voiceover", "elevenlabs", opaqueHandler);

      expect(() => app.registry.register("voiceover", "elevenlabs", opaqueHandler)).toThrowError(
        '[ai] Provider "elevenlabs" is already registered for task "voiceover".\n  Register each task/provider pair exactly once.'
      );
    });

    it("allows the same provider name to register under a different task", () => {
      const app = createTestApp();
      app.registry.register("voiceover", "elevenlabs", opaqueHandler);

      expect(() => app.registry.register("translate", "elevenlabs", opaqueHandler)).not.toThrow();
    });

    it("resolve returns undefined for an unregistered provider on a known task", () => {
      const app = createTestApp();
      app.registry.register("voiceover", "elevenlabs", opaqueHandler);

      expect(app.registry.resolve("voiceover", "openai")).toBeUndefined();
    });

    it("resolve returns undefined for a task with no registrations at all", () => {
      const app = createTestApp();

      expect(app.registry.resolve("translate", "openai")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Runtime: providers/tasks introspection
  // -------------------------------------------------------------------------

  describe("runtime: providers/tasks introspection", () => {
    it("providers() lists provider names in registration order", () => {
      const app = createTestApp();
      app.registry.register("voiceover", "openai", opaqueHandler);
      app.registry.register("voiceover", "elevenlabs", opaqueHandler);

      expect(app.registry.providers("voiceover")).toEqual(["openai", "elevenlabs"]);
    });

    it("providers() returns an empty array for an unknown task", () => {
      const app = createTestApp();

      expect(app.registry.providers("unknown-task")).toEqual([]);
    });

    it("tasks() lists every task that has at least one registration", () => {
      const app = createTestApp();
      app.registry.register("voiceover", "elevenlabs", opaqueHandler);
      app.registry.register("translate", "openai", opaqueHandler);

      expect(app.registry.tasks()).toEqual(["voiceover", "translate"]);
    });

    it("tasks() returns an empty array before any registration", () => {
      const app = createTestApp();

      expect(app.registry.tasks()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Types: API signatures
  // -------------------------------------------------------------------------

  describe("types: API signatures", () => {
    it("resolve returns unknown, not any", () => {
      const app = createTestApp();
      const result = app.registry.resolve("voiceover", "elevenlabs");

      expectTypeOf(result).toBeUnknown();
      expectTypeOf(result).not.toBeAny();
      expect(result).toBeUndefined();
    });

    it("register/resolve/providers/tasks match the spec'd signatures", () => {
      const app = createTestApp();

      expectTypeOf(app.registry.register).toEqualTypeOf<
        (task: string, provider: string, handler: unknown) => void
      >();
      expectTypeOf(app.registry.resolve).toEqualTypeOf<
        (task: string, provider: string) => unknown
      >();
      expectTypeOf(app.registry.providers).toEqualTypeOf<(task: string) => string[]>();
      expectTypeOf(app.registry.tasks).toEqualTypeOf<() => string[]>();
    });

    it('plugin name is the literal type "registry"', () => {
      expectTypeOf(registryPlugin.name).toEqualTypeOf<"registry">();
    });

    it("rejects nonexistent API methods on app surface", () => {
      const app = createTestApp();

      // @ts-expect-error -- nonExistent is not in the registry API
      app.registry.nonExistent;

      expect(app).toBeDefined();
    });
  });
});
