import { describe, expect, expectTypeOf, it } from "vitest";
import { createPromptGenApi } from "../../api";
import type {
  PromptGenApi,
  PromptGenContext,
  PromptGenHandler,
  PromptGenRequest
} from "../../types";

// ---------------------------------------------------------------------------
// Unit test: createPromptGenApi (mock context, no kernel)
// ---------------------------------------------------------------------------

/** In-memory registry double matching the real registry plugin's shape. */
function createFakeRegistry() {
  const handlers = new Map<string, Map<string, unknown>>();
  return {
    register(task: string, provider: string, handler: unknown): void {
      const taskProviders = handlers.get(task) ?? new Map<string, unknown>();
      taskProviders.set(provider, handler);
      handlers.set(task, taskProviders);
    },
    resolve(task: string, provider: string): unknown {
      return handlers.get(task)?.get(provider);
    },
    providers(task: string): string[] {
      return [...(handlers.get(task)?.keys() ?? [])];
    },
    tasks(): string[] {
      return [...handlers.keys()];
    }
  };
}

/** Well-formed prompt-gen handler fixture: echoes the prompt back as text. */
function createEchoHandler(name: string): PromptGenHandler {
  return {
    estimate: (request: PromptGenRequest) => ({ usd: request.prompt.length / 1000 }),
    execute: async (request: PromptGenRequest) => ({
      text: `${name}:${request.prompt}`,
      costUsd: request.prompt.length / 1000
    })
  };
}

/** Builds a mock promptGen context around a given fake registry. */
function createMockCtx(
  registry: ReturnType<typeof createFakeRegistry>,
  configOverrides?: Partial<PromptGenContext["config"]>
): PromptGenContext {
  return {
    config: { defaultProvider: "openai", ...configOverrides },
    state: {},
    emit: () => undefined,
    require: () => registry
  };
}

describe("createPromptGenApi", () => {
  // -------------------------------------------------------------------------
  // generate: default-provider fallback + explicit override
  // -------------------------------------------------------------------------

  describe("generate: provider resolution", () => {
    it("falls back to config.defaultProvider when opts.provider is omitted", async () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "openai", createEchoHandler("openai"));
      const api: PromptGenApi = createPromptGenApi(createMockCtx(registry));

      const result = await api.generate({ prompt: "hi" });

      expect(result.text).toBe("openai:hi");
    });

    it("uses opts.provider over the default when given", async () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "openai", createEchoHandler("openai"));
      registry.register("prompt-gen", "anthropic", createEchoHandler("anthropic"));
      const api = createPromptGenApi(createMockCtx(registry));

      const result = await api.generate({ prompt: "hi" }, { provider: "anthropic" });

      expect(result.text).toBe("anthropic:hi");
    });
  });

  // -------------------------------------------------------------------------
  // generate: unknown-provider error format (exact two-line text)
  // -------------------------------------------------------------------------

  describe("generate: unknown provider", () => {
    it("throws the exact two-line error, listing registered providers", async () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "openai", createEchoHandler("openai"));
      const api = createPromptGenApi(createMockCtx(registry));

      await expect(api.generate({ prompt: "hi" }, { provider: "acme" })).rejects.toThrow(
        '[ai] No prompt-gen provider named "acme" is registered.\n  Available: openai.'
      );
    });

    it('lists "none" when no providers are registered at all', async () => {
      const registry = createFakeRegistry();
      const api = createPromptGenApi(createMockCtx(registry));

      await expect(api.generate({ prompt: "hi" }, { provider: "acme" })).rejects.toThrow(
        '[ai] No prompt-gen provider named "acme" is registered.\n  Available: none.'
      );
    });

    it("does not resolve a handler registered under the wrong (camelCase) task key", async () => {
      const registry = createFakeRegistry();
      // Registered under the plugin/api name, not the registry task key.
      registry.register("promptGen", "openai", createEchoHandler("openai"));
      const api = createPromptGenApi(createMockCtx(registry));

      await expect(api.generate({ prompt: "hi" }, { provider: "openai" })).rejects.toThrow(
        '[ai] No prompt-gen provider named "openai" is registered.\n  Available: none.'
      );
    });
  });

  // -------------------------------------------------------------------------
  // generate: audited-cast shape guard (bad registered value -> descriptive error)
  // -------------------------------------------------------------------------

  describe("generate: malformed registered handler", () => {
    it("throws a descriptive error (not a crash) when estimate/execute are both missing", async () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "broken", { note: "not a handler" });
      const api = createPromptGenApi(createMockCtx(registry));

      await expect(api.generate({ prompt: "hi" }, { provider: "broken" })).rejects.toThrow(
        '[ai] Registered prompt-gen provider "broken" is malformed.\n  Expected an object with estimate() and execute() functions.'
      );
    });

    it("throws a descriptive error when estimate/execute exist but are not functions", async () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "broken", { estimate: 123, execute: "nope" });
      const api = createPromptGenApi(createMockCtx(registry));

      await expect(api.generate({ prompt: "hi" }, { provider: "broken" })).rejects.toThrow(
        '[ai] Registered prompt-gen provider "broken" is malformed.\n  Expected an object with estimate() and execute() functions.'
      );
    });

    it("throws a descriptive error when the registered value is not an object at all", async () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "broken", "just a string");
      const api = createPromptGenApi(createMockCtx(registry));

      await expect(api.generate({ prompt: "hi" }, { provider: "broken" })).rejects.toThrow(
        '[ai] Registered prompt-gen provider "broken" is malformed.\n  Expected an object with estimate() and execute() functions.'
      );
    });
  });

  // -------------------------------------------------------------------------
  // estimate: delegation, no execution
  // -------------------------------------------------------------------------

  describe("estimate", () => {
    it("delegates to the resolved handler's estimate()", () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "openai", createEchoHandler("openai"));
      const api = createPromptGenApi(createMockCtx(registry));

      expect(api.estimate({ prompt: "12345" })).toEqual({ usd: 0.005 });
    });

    it("does not execute the handler — estimate has no execution side effect", () => {
      const registry = createFakeRegistry();
      let executed = false;
      registry.register("prompt-gen", "openai", {
        estimate: () => ({ usd: 0.01 }),
        execute: async () => {
          executed = true;
          return { text: "should not run", costUsd: 0 };
        }
      });
      const api = createPromptGenApi(createMockCtx(registry));

      api.estimate({ prompt: "hi" });

      expect(executed).toBe(false);
    });

    it("honors an opts.provider override", () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "openai", createEchoHandler("openai"));
      registry.register("prompt-gen", "anthropic", {
        estimate: () => ({ usd: 0.02 }),
        execute: async (request: PromptGenRequest) => ({
          text: `anthropic:${request.prompt}`,
          costUsd: 0.02
        })
      });
      const api = createPromptGenApi(createMockCtx(registry));

      expect(api.estimate({ prompt: "hi" }, { provider: "anthropic" })).toEqual({ usd: 0.02 });
    });
  });

  // -------------------------------------------------------------------------
  // providers
  // -------------------------------------------------------------------------

  describe("providers", () => {
    it("lists providers registered under the prompt-gen task key, in registration order", () => {
      const registry = createFakeRegistry();
      registry.register("prompt-gen", "openai", createEchoHandler("openai"));
      registry.register("prompt-gen", "anthropic", createEchoHandler("anthropic"));
      const api = createPromptGenApi(createMockCtx(registry));

      expect(api.providers()).toEqual(["openai", "anthropic"]);
    });

    it("returns an empty array before any provider registers", () => {
      const registry = createFakeRegistry();
      const api = createPromptGenApi(createMockCtx(registry));

      expect(api.providers()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // types: PromptGenApi signatures
  // -------------------------------------------------------------------------

  describe("types: PromptGenApi", () => {
    it("generate/estimate/providers match the spec'd signatures", () => {
      const registry = createFakeRegistry();
      const api = createPromptGenApi(createMockCtx(registry));

      expectTypeOf(api.generate).parameter(0).toEqualTypeOf<PromptGenRequest>();
      expectTypeOf(api.estimate).returns.toEqualTypeOf<{ usd: number }>();
      expectTypeOf(api.providers).returns.toEqualTypeOf<string[]>();
    });
  });
});
