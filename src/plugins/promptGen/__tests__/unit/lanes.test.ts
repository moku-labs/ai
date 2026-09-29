import { describe, expect, it } from "vitest";
import { createPromptGenApi } from "../../api";
import { PromptGenUnavailableError } from "../../contract";
import {
  createEchoHandler,
  createFailingHandler,
  createFakeLimits,
  createFakeLog,
  createFakeRegistry,
  createMockCtx
} from "./fixtures";

// ---------------------------------------------------------------------------
// Unit test: generate() runs every attempt inside its provider's lane (0.7.0)
// ---------------------------------------------------------------------------

const OPENAI_LANE = "prompt-gen/openai/default";
const CODEX_LANE = "prompt-gen/codex/default";

describe("generate: lane gate", () => {
  it("acquires prompt-gen/<provider>/default with the caller's signal and releases it after success", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createEchoHandler("openai"));
    const fake = createFakeLimits();
    const api = createPromptGenApi(createMockCtx(registry, { limits: fake.limits }));
    const controller = new AbortController();

    await api.generate({ prompt: "hi" }, { signal: controller.signal });

    expect(fake.limits.acquire).toHaveBeenCalledWith(OPENAI_LANE, { signal: controller.signal });
    expect(fake.released).toEqual([OPENAI_LANE]);
  });

  it("releases the lane when execute fails", async () => {
    const error = new Error("[ai] Codex wrote no answer.");
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createFailingHandler(error).handler);
    const fake = createFakeLimits();
    const api = createPromptGenApi(createMockCtx(registry, { limits: fake.limits }));

    await expect(api.generate({ prompt: "hi" })).rejects.toBe(error);
    expect(fake.released).toEqual([OPENAI_LANE]);
  });

  it("takes each provider's own lane per attempt and releases each one", async () => {
    const registry = createFakeRegistry();
    registry.register(
      "prompt-gen",
      "openai",
      createFailingHandler(Object.assign(new Error("rate"), { status: 429 })).handler
    );
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const fake = createFakeLimits();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, limits: fake.limits })
    );

    await api.generate({ prompt: "hi" });

    expect(fake.acquired).toEqual([OPENAI_LANE, CODEX_LANE]);
    expect(fake.released).toEqual([OPENAI_LANE, CODEX_LANE]);
  });

  it("never reports outcomes: breaker state stays owned by the runner", async () => {
    const registry = createFakeRegistry();
    registry.register(
      "prompt-gen",
      "openai",
      createFailingHandler(new PromptGenUnavailableError("[ai] x.\n  y.", "limit")).handler
    );
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const fake = createFakeLimits();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, limits: fake.limits })
    );

    await api.generate({ prompt: "hi" });

    expect(fake.limits.reportOutcome).not.toHaveBeenCalled();
  });

  it("treats a breaker-open lane as unavailable and moves to the next provider", async () => {
    const registry = createFakeRegistry();
    const openai = createFailingHandler(new Error("must not run"));
    registry.register("prompt-gen", "openai", openai.handler);
    registry.register("prompt-gen", "codex", createEchoHandler("codex"));
    const fake = createFakeLimits({ breakerOpen: [OPENAI_LANE] });
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, limits: fake.limits, log })
    );

    const result = await api.generate({ prompt: "hi" });

    expect(result.meta).toEqual({ provider: "codex" });
    expect(openai.execute).not.toHaveBeenCalled();
    expect(fake.released).toEqual([CODEX_LANE]);
    expect(log.warn).toHaveBeenCalledWith("prompt-gen:fallback", {
      from: "openai",
      to: "codex",
      reason: "breaker-open"
    });
  });

  it("rethrows the breaker-open rejection when no provider is left", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createEchoHandler("openai"));
    const fake = createFakeLimits({ breakerOpen: [OPENAI_LANE] });
    const api = createPromptGenApi(createMockCtx(registry, { limits: fake.limits }));

    await expect(api.generate({ prompt: "hi" })).rejects.toMatchObject({ reason: "breaker-open" });
  });

  it("rethrows an abort while queued for the lane, without switching provider", async () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createEchoHandler("openai"));
    const backup = createFailingHandler(new Error("must not run"));
    registry.register("prompt-gen", "codex", backup.handler);
    const fake = createFakeLimits({ full: [OPENAI_LANE] });
    const log = createFakeLog();
    const api = createPromptGenApi(
      createMockCtx(registry, { config: { fallback: ["codex"] }, limits: fake.limits, log })
    );
    const controller = new AbortController();
    const abortReason = new PromptGenUnavailableError("[ai] aborted.\n  x.", "limit");

    const pending = api.generate({ prompt: "hi" }, { signal: controller.signal });
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(backup.execute).not.toHaveBeenCalled();
    expect(fake.acquired).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("estimate and providers: no lane", () => {
  it("estimate() and providers() never acquire a lane", () => {
    const registry = createFakeRegistry();
    registry.register("prompt-gen", "openai", createEchoHandler("openai"));
    const fake = createFakeLimits();
    const api = createPromptGenApi(createMockCtx(registry, { limits: fake.limits }));

    api.estimate({ prompt: "hi" });
    api.providers();

    expect(fake.limits.acquire).not.toHaveBeenCalled();
  });
});
