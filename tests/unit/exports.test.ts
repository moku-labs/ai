import { describe, expect, it } from "vitest";
import type { Fal } from "../../src/index";
import * as root from "../../src/index";
import { CodexErrors, ElevenlabsErrors, FalErrors, OpenaiErrors } from "../../src/index";

const THREE_CLASSES = ["FlaggedProviderError", "RetryableProviderError", "TerminalProviderError"];

describe("framework exports: provider type namespaces", () => {
  it("ship no runtime values from the Fal, Openai, Elevenlabs and Codex namespaces", () => {
    expect(Object.keys(root.Fal)).toEqual([]);
    expect(Object.keys(root.Openai)).toEqual([]);
    expect(Object.keys(root.Elevenlabs)).toEqual([]);
    expect(Object.keys(root.Codex)).toEqual([]);
  });

  it("keeps the error classes usable in type position", () => {
    const error: Fal.RetryableProviderError = new FalErrors.RetryableProviderError("x", {
      status: 503
    });

    expect(error.status).toBe(503);
  });
});

describe("framework exports: provider error namespaces", () => {
  it("expose the three error classes for fal, openai and elevenlabs", () => {
    expect(Object.keys(FalErrors).toSorted()).toEqual(THREE_CLASSES);
    expect(Object.keys(OpenaiErrors).toSorted()).toEqual(THREE_CLASSES);
    expect(Object.keys(ElevenlabsErrors).toSorted()).toEqual(THREE_CLASSES);
  });

  it("expose the retryable and terminal error classes for codex", () => {
    expect(Object.keys(CodexErrors).toSorted()).toEqual([
      "RetryableProviderError",
      "TerminalProviderError"
    ]);
  });

  it("constructs a fal terminal error with its name and status", () => {
    const error = new FalErrors.TerminalProviderError("x", 400);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TerminalProviderError");
    expect(error.status).toBe(400);
  });

  it("constructs the openai error classes as Errors", () => {
    expect(new OpenaiErrors.RetryableProviderError("x", { status: 503 })).toBeInstanceOf(Error);
    expect(new OpenaiErrors.TerminalProviderError("x", 400)).toBeInstanceOf(Error);
    expect(new OpenaiErrors.FlaggedProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the elevenlabs error classes as Errors", () => {
    expect(new ElevenlabsErrors.RetryableProviderError("x", { status: 429 })).toBeInstanceOf(Error);
    expect(new ElevenlabsErrors.TerminalProviderError("x", 400)).toBeInstanceOf(Error);
    expect(new ElevenlabsErrors.FlaggedProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the codex error classes as Errors", () => {
    expect(new CodexErrors.RetryableProviderError("x", "timeout")).toBeInstanceOf(Error);
    expect(new CodexErrors.TerminalProviderError("x")).toBeInstanceOf(Error);
  });
});
