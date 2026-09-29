/**
 * @file Unit tests for promptGen provider resolution (`resolve.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  hasPromptGenHandlerShape,
  isRegistered,
  PROMPT_GEN_TASK,
  resolveHandler,
  unknownProviderError
} from "../../resolve";
import { createEchoHandler, createFakeRegistry, createMockCtx } from "./fixtures";

const MALFORMED_MESSAGE =
  '[ai] Registered prompt-gen provider "broken" is malformed.\n  Expected an object with estimate() and execute() functions.';

describe("unknownProviderError", () => {
  it("lists the available providers on the second line", () => {
    const error = unknownProviderError("acme", ["openai", "codex"]);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      '[ai] No prompt-gen provider named "acme" is registered.\n  Available: openai, codex.'
    );
  });

  it("says none when no provider is registered", () => {
    const error = unknownProviderError("acme", []);

    expect(error.message).toBe(
      '[ai] No prompt-gen provider named "acme" is registered.\n  Available: none.'
    );
  });
});

describe("hasPromptGenHandlerShape", () => {
  it("accepts an object with estimate() and execute() functions", () => {
    expect(hasPromptGenHandlerShape(createEchoHandler("openai"))).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    // eslint-disable-next-line unicorn/no-null -- the guard must reject a JSON-style null handler
    ["null", null],
    ["a string", "handler"],
    ["a function", () => undefined],
    ["an empty object", {}],
    ["an object without execute", { estimate: () => ({ usd: 0 }) }],
    ["an object without estimate", { execute: async () => ({ text: "" }) }],
    ["non-function members", { estimate: 123, execute: "nope" }]
  ])("rejects %s", (_label, value) => {
    expect(hasPromptGenHandlerShape(value)).toBe(false);
  });
});

describe("isRegistered", () => {
  it("is true for a provider registered under the prompt-gen task", () => {
    const registry = createFakeRegistry();
    registry.register(PROMPT_GEN_TASK, "codex", createEchoHandler("codex"));

    expect(isRegistered(registry, "codex")).toBe(true);
  });

  it("is false for an unregistered provider", () => {
    const registry = createFakeRegistry();
    registry.register(PROMPT_GEN_TASK, "codex", createEchoHandler("codex"));

    expect(isRegistered(registry, "claude")).toBe(false);
  });

  it("is false for a provider registered only under another task", () => {
    const registry = createFakeRegistry();
    registry.register("image", "codex", createEchoHandler("codex"));

    expect(isRegistered(registry, "codex")).toBe(false);
  });
});

describe("resolveHandler", () => {
  it("returns the registered handler", () => {
    const registry = createFakeRegistry();
    const handler = createEchoHandler("codex");
    registry.register(PROMPT_GEN_TASK, "codex", handler);

    expect(resolveHandler(createMockCtx(registry), "codex")).toBe(handler);
  });

  it("throws the pinned unknown-provider error for an unregistered provider", () => {
    const registry = createFakeRegistry();
    registry.register(PROMPT_GEN_TASK, "openai", createEchoHandler("openai"));
    registry.register(PROMPT_GEN_TASK, "codex", createEchoHandler("codex"));

    expect(() => resolveHandler(createMockCtx(registry), "acme")).toThrow(
      '[ai] No prompt-gen provider named "acme" is registered.\n  Available: openai, codex.'
    );
  });

  it("throws with Available: none when nothing is registered", () => {
    const registry = createFakeRegistry();

    expect(() => resolveHandler(createMockCtx(registry), "acme")).toThrow(
      '[ai] No prompt-gen provider named "acme" is registered.\n  Available: none.'
    );
  });

  it("throws the malformed error for a registered value without the contract", () => {
    const registry = createFakeRegistry();
    registry.register(PROMPT_GEN_TASK, "broken", { estimate: () => ({ usd: 0 }) });

    expect(() => resolveHandler(createMockCtx(registry), "broken")).toThrow(MALFORMED_MESSAGE);
  });
});
