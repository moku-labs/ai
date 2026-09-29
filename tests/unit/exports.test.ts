import { describe, expect, it } from "vitest";
import type { Fal } from "../../src/index";
import * as root from "../../src/index";
import {
  ApimodelsErrors,
  ArkErrors,
  ClaudeErrors,
  CodexErrors,
  ElevenlabsErrors,
  FalErrors,
  OpenaiErrors
} from "../../src/index";

const THREE_CLASSES = ["FlaggedProviderError", "RetryableProviderError", "TerminalProviderError"];
const TWO_CLASSES = ["RetryableProviderError", "TerminalProviderError"];

describe("framework exports: provider type namespaces", () => {
  it("ship no runtime values from the seven provider namespaces", () => {
    expect(Object.keys(root.Apimodels)).toEqual([]);
    expect(Object.keys(root.Ark)).toEqual([]);
    expect(Object.keys(root.Claude)).toEqual([]);
    expect(Object.keys(root.Codex)).toEqual([]);
    expect(Object.keys(root.Elevenlabs)).toEqual([]);
    expect(Object.keys(root.Fal)).toEqual([]);
    expect(Object.keys(root.Openai)).toEqual([]);
  });

  it("keeps the error classes usable in type position", () => {
    const error: Fal.RetryableProviderError = new FalErrors.RetryableProviderError("x", {
      status: 503
    });

    expect(error.status).toBe(503);
  });
});

describe("framework exports: provider error namespaces", () => {
  it("expose the three error classes for apimodels, ark, elevenlabs, fal and openai", () => {
    expect(Object.keys(ApimodelsErrors).toSorted()).toEqual(THREE_CLASSES);
    expect(Object.keys(ArkErrors).toSorted()).toEqual(THREE_CLASSES);
    expect(Object.keys(ElevenlabsErrors).toSorted()).toEqual(THREE_CLASSES);
    expect(Object.keys(FalErrors).toSorted()).toEqual(THREE_CLASSES);
    expect(Object.keys(OpenaiErrors).toSorted()).toEqual(THREE_CLASSES);
  });

  it("expose the retryable and terminal error classes for claude and codex", () => {
    expect(Object.keys(ClaudeErrors).toSorted()).toEqual(TWO_CLASSES);
    expect(Object.keys(CodexErrors).toSorted()).toEqual(TWO_CLASSES);
  });

  it("constructs a fal terminal error with its name and status", () => {
    const error = new FalErrors.TerminalProviderError("x", 400);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TerminalProviderError");
    expect(error.status).toBe(400);
  });

  it("constructs the apimodels error classes as Errors", () => {
    expect(new ApimodelsErrors.RetryableProviderError("x", { status: 503 })).toBeInstanceOf(Error);
    expect(new ApimodelsErrors.TerminalProviderError("x", 400)).toBeInstanceOf(Error);
    expect(new ApimodelsErrors.FlaggedProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the ark error classes as Errors", () => {
    expect(new ArkErrors.RetryableProviderError("x", { status: 429 })).toBeInstanceOf(Error);
    expect(new ArkErrors.TerminalProviderError("x", 400)).toBeInstanceOf(Error);
    expect(new ArkErrors.FlaggedProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the claude error classes as Errors", () => {
    expect(new ClaudeErrors.RetryableProviderError("x", "timeout")).toBeInstanceOf(Error);
    expect(new ClaudeErrors.TerminalProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the codex error classes as Errors", () => {
    expect(new CodexErrors.RetryableProviderError("x", "timeout")).toBeInstanceOf(Error);
    expect(new CodexErrors.TerminalProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the elevenlabs error classes as Errors", () => {
    expect(new ElevenlabsErrors.RetryableProviderError("x", { status: 429 })).toBeInstanceOf(Error);
    expect(new ElevenlabsErrors.TerminalProviderError("x", 400)).toBeInstanceOf(Error);
    expect(new ElevenlabsErrors.FlaggedProviderError("x")).toBeInstanceOf(Error);
  });

  it("constructs the openai error classes as Errors", () => {
    expect(new OpenaiErrors.RetryableProviderError("x", { status: 503 })).toBeInstanceOf(Error);
    expect(new OpenaiErrors.TerminalProviderError("x", 400)).toBeInstanceOf(Error);
    expect(new OpenaiErrors.FlaggedProviderError("x")).toBeInstanceOf(Error);
  });
});
