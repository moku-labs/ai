import { describe, expect, it } from "vitest";
import { createPromptGenApi } from "../../api";
import { PromptGenUnavailableError } from "../../contract";
import {
  createEchoHandler,
  createFailingHandler,
  createFakeLog,
  createFakeRegistry,
  createMockCtx
} from "./fixtures";

// ---------------------------------------------------------------------------
// Unit test: generate() fallback chain (0.7.0)
// ---------------------------------------------------------------------------

const UNKNOWN_CLAUDE =
  '[ai] No prompt-gen provider named "claude" is registered.\n  Available: codex.';

/**
 * Builds an unavailable error with a realistic two-line message.
 *
 * @param reason - Why the provider cannot serve.
 * @returns The error.
 */
function unavailable(reason: "missing" | "auth" | "limit"): PromptGenUnavailableError {
  return new PromptGenUnavailableError(
    `[ai] Claude CLI is ${reason}.\n  Use another provider.`,
    reason
  );
}

describe("generate: fallback chain", () => {
  it.each([
    "missing",
    "auth",
    "limit"
  ] as const)("moves to the next provider when the first is unavailable (%s) and names the answering provider", async reason => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", createFailingHandler(unavailable(reason)).handler);
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["codex"] }, log })
    );

    const result = await api.generate({ prompt: "hi" });

    expect(result.text).toBe("codex:hi");
    expect(result.meta).toEqual({ provider: "codex" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback", {
      from: "claude",
      to: "codex",
      reason
    });
  });

  it("switches on an HTTP-shaped 429 and logs the reason as http-429", async () => {
    const registry = createFakeRegistry();
    const rateLimited = Object.assign(new Error("[ai] OpenAI rate limit."), { status: 429 });
    registry.register("prompt-gen", "openai", createFailingHandler(rateLimited).handler);
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, log })
    );

    const result = await api.generate({ prompt: "hi" });

    expect(result.text).toBe("codex:hi");
    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback", {
      from: "openai",
      to: "codex",
      reason: "http-429"
    });
  });

  it('logs the reason as "unavailable" for a marked error with neither reason nor status', async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createFailingHandler({ unavailable: true }).handler);
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, log })
    );

    await api.generate({ prompt: "hi" });

    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback", {
      from: "openai",
      to: "codex",
      reason: "unavailable"
    });
  });

  it.each([
    ["an HTTP 500", Object.assign(new Error("[ai] OpenAI server error."), { status: 500 })],
    [
      "a terminal error",
      new Error("[ai] Codex wrote no answer.\n  Run the same codex exec by hand.")
    ],
    ["a timeout", Object.assign(new Error("[ai] Claude CLI timed out."), { kind: "timeout" })],
    ["an invalid JSON answer", new Error("[ai] Codex answer is not valid JSON.")]
  ])("rethrows %s at once without switching provider", async (_label, error) => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createFailingHandler(error).handler);
    const backup = createFailingHandler(new Error("must not run"));
    registry.register("prompt-gen", "codex", backup.handler);
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, log })
    );

    await expect(api.generate({ prompt: "hi" })).rejects.toBe(error);
    expect(backup.execute).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rethrows an unavailable error without switching when the caller's signal is aborted", async () => {
    const controller = new AbortController();
    const error = unavailable("limit");
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", {
      estimate: () => ({ usd: 0 }),
      execute: async () => {
        controller.abort();
        throw error;
      }
    });
    const backup = createFailingHandler(new Error("must not run"));
    registry.register("prompt-gen", "codex", backup.handler);
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["codex"] }, log })
    );

    await expect(api.generate({ prompt: "hi" }, { signal: controller.signal })).rejects.toBe(error);
    expect(backup.execute).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rethrows the LAST error when every provider is unavailable", async () => {
    const lastError = unavailable("auth");
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", createFailingHandler(unavailable("missing")).handler);
    registry.register("prompt-gen", "codex", createFailingHandler(lastError).handler);
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["codex"] }, log })
    );

    await expect(api.generate({ prompt: "hi" })).rejects.toBe(lastError);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("throws the pinned unknown-provider error when the FIRST name is unregistered, even with a fallback", async () => {
    const registry = createFakeRegistry();
    const backup = createFailingHandler(new Error("must not run"));
    registry.register("prompt-gen", "codex", backup.handler);
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["codex"] } })
    );

    await expect(api.generate({ prompt: "hi" })).rejects.toThrow(UNKNOWN_CLAUDE);
    expect(backup.execute).not.toHaveBeenCalled();
  });

  it("skips a LATER unregistered name with a warn and asks the next registered one", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", createFailingHandler(unavailable("missing")).handler);
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, {
        config: { defaultProvider: "claude", fallback: ["ghost", "codex"] },
        log
      })
    );

    const result = await api.generate({ prompt: "hi" });

    expect(result.meta).toEqual({ provider: "codex" });
    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback-skip", {
      provider: "ghost",
      reason: "unregistered"
    });
    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback", {
      from: "claude",
      to: "codex",
      reason: "missing"
    });
  });

  it("logs no skip warn when the head answers before the walk reaches an unregistered name", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", createEchoHandler("claude"));
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["ghost"] }, log })
    );

    const result = await api.generate({ prompt: "hi" });

    expect(result.meta).toEqual({ provider: "claude" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("rethrows the last unavailable error when only unregistered names are left", async () => {
    const registry = createFakeRegistry();
    const claudeError = unavailable("limit");
    registry.register("prompt-gen", "claude", createFailingHandler(claudeError).handler);
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["ghost"] }, log })
    );

    await expect(api.generate({ prompt: "hi" })).rejects.toBe(claudeError);
    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback-skip", {
      provider: "ghost",
      reason: "unregistered"
    });
  });

  it("tries a provider named twice in the chain only once", async () => {
    const registry = createFakeRegistry();
    const claude = createFailingHandler(unavailable("limit"));
    const codexError = unavailable("auth");
    const codex = createFailingHandler(codexError);
    registry.register("prompt-gen", "claude", claude.handler);
    registry.register("prompt-gen", "codex", codex.handler);
    const api = createPromptGenApi(
      createMockCtx(registry, {
        config: { defaultProvider: "claude", fallback: ["claude", "codex", "codex"] }
      })
    );

    await expect(api.generate({ prompt: "hi" })).rejects.toBe(codexError);
    expect(claude.execute).toHaveBeenCalledTimes(1);
    expect(codex.execute).toHaveBeenCalledTimes(1);
  });

  it("puts an explicit opts.provider at the head of the chain, before the fallback", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createEchoHandler("openai"));
    registry.register("prompt-gen", "claude", createFailingHandler(unavailable("auth")).handler);
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const api = createPromptGenApi(createMockCtx(registry, { config: { fallback: ["codex"] } }));

    const result = await api.generate({ prompt: "hi" }, { provider: "claude" });

    expect(result.text).toBe("codex:hi");
  });

  it("with fallback: [] rethrows the default provider's unavailable error as 0.6.0 did", async () => {
    const error = unavailable("missing");
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createFailingHandler(error).handler);
    const log = createFakeLog();
    const api = createPromptGenApi(createMockCtx(registry, { log }));

    await expect(api.generate({ prompt: "hi" })).rejects.toBe(error);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("merges meta.provider over the handler's own meta", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({
        text: "ok",
        costUsd: 0.001,
        meta: { model: "gpt-4o-mini", provider: "stale" }
      })
    });
    const api = createPromptGenApi(createMockCtx(registry));

    const result = await api.generate({ prompt: "hi" });

    expect(result).toEqual({
      text: "ok",
      costUsd: 0.001,
      meta: { model: "gpt-4o-mini", provider: "openai" }
    });
  });
});

describe("estimate: resolves like generate, never falls back", () => {
  it("throws the pinned unknown-provider error when the first name is unregistered", () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["codex"] } })
    );

    expect(() => api.estimate({ prompt: "hi" })).toThrow(UNKNOWN_CLAUDE);
  });

  it("asks the first provider only, ignoring unregistered later names", () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", {
      estimate: () => ({ usd: 0 }),
      execute: async () => ({ text: "", costUsd: 0 })
    });
    registry.register("prompt-gen", "codex", {
      estimate: () => ({ usd: 9 }),
      execute: async () => ({ text: "", costUsd: 0 })
    });
    const api = createPromptGenApi(
      createMockCtx(registry, {
        config: { defaultProvider: "claude", fallback: ["ghost", "codex"] }
      })
    );

    expect(api.estimate({ prompt: "hi" })).toEqual({ usd: 0 });
  });

  it("rethrows the first provider's estimate error instead of asking the fallback", () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "claude", {
      estimate: () => {
        throw unavailable("missing");
      },
      execute: async () => ({ text: "", costUsd: 0 })
    });
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { defaultProvider: "claude", fallback: ["codex"] } })
    );

    expect(() => api.estimate({ prompt: "hi" })).toThrow(PromptGenUnavailableError);
  });
});
