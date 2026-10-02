import { describe, expect, it } from "vitest";
import {
  assertOneTurnRequest,
  isPromptGenUnavailable,
  PromptGenUnavailableError,
  ToolArgumentsError
} from "../../contract";

// ---------------------------------------------------------------------------
// Unit test: the "provider unavailable" contract (0.7.0)
// ---------------------------------------------------------------------------

describe("PromptGenUnavailableError", () => {
  it("is an Error named PromptGenUnavailableError that carries its reason and the unavailable marker", () => {
    const error = new PromptGenUnavailableError(
      "[ai] Claude CLI is not logged in.\n  Run claude and /login, or use another provider.",
      "auth"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PromptGenUnavailableError");
    expect(error.message).toBe(
      "[ai] Claude CLI is not logged in.\n  Run claude and /login, or use another provider."
    );
    expect(error.reason).toBe("auth");
    expect(error.unavailable).toBe(true);
  });
});

describe("isPromptGenUnavailable", () => {
  it.each([
    "missing",
    "auth",
    "limit",
    "unsupported"
  ] as const)("is true for a PromptGenUnavailableError (%s)", reason => {
    expect(isPromptGenUnavailable(new PromptGenUnavailableError("[ai] x.\n  y.", reason))).toBe(
      true
    );
  });

  it("is true for any object marked unavailable === true", () => {
    expect(isPromptGenUnavailable({ unavailable: true })).toBe(true);
  });

  it.each([401, 402, 403, 429])("is true for an HTTP-shaped error with status %i", status => {
    expect(isPromptGenUnavailable(Object.assign(new Error("http"), { status }))).toBe(true);
  });

  it.each([400, 404, 500, 503])("is false for an HTTP-shaped error with status %i", status => {
    expect(isPromptGenUnavailable({ status })).toBe(false);
  });

  it.each([
    ["a plain Error", new Error("[ai] Codex answer is not valid JSON.")],
    ["a truthy but non-true marker", { unavailable: "yes" }],
    ["a string status", { status: "429" }],
    ["undefined", undefined],
    ["a string", "429"],
    ["a number", 429]
  ])("is false for %s", (_label, error) => {
    expect(isPromptGenUnavailable(error)).toBe(false);
  });
});

describe("PromptGenUnavailableError: unsupported", () => {
  it("carries the unsupported reason for a request the provider cannot express", () => {
    const error = new PromptGenUnavailableError(
      "[ai] Claude CLI cannot take messages or tools.\n  Use the fal provider for tool calling.",
      "unsupported"
    );

    expect(error.reason).toBe("unsupported");
    expect(isPromptGenUnavailable(error)).toBe(true);
  });
});

describe("ToolArgumentsError", () => {
  it("is an Error named ToolArgumentsError that carries the tool name and the raw arguments", () => {
    const error = new ToolArgumentsError("read_frame", "{not json");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ToolArgumentsError");
    expect(error.toolName).toBe("read_frame");
    expect(error.raw).toBe("{not json");
    expect(error.message).toBe(
      '[ai] Tool call "read_frame" has arguments that are not JSON.\n  The model sent: {not json.'
    );
  });

  it("quotes only the first 200 characters of the raw arguments in the message", () => {
    const raw = `${"a".repeat(200)}TAIL`;
    const error = new ToolArgumentsError("search", raw);

    expect(error.raw).toBe(raw);
    expect(error.message).toBe(
      `[ai] Tool call "search" has arguments that are not JSON.\n  The model sent: ${"a".repeat(200)}.`
    );
  });

  it("is not a provider-unavailable error, so promptGen rethrows it at once", () => {
    expect(isPromptGenUnavailable(new ToolArgumentsError("search", "{"))).toBe(false);
  });
});

describe("assertOneTurnRequest", () => {
  it.each([
    ["messages", { prompt: "", messages: [] }],
    ["tools", { prompt: "p", tools: [] }],
    ["toolChoice", { prompt: "p", toolChoice: "auto" as const }]
  ])("throws unsupported for %s", (_field, request) => {
    let caught: unknown;
    try {
      assertOneTurnRequest(request, "Claude");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PromptGenUnavailableError);
    expect(caught).toMatchObject({
      reason: "unsupported",
      message:
        "[ai] Claude prompt-gen does not support messages or tools.\n  Use the fal provider for tool calling."
    });
  });

  it("lets a one-turn request through, cacheSystem included", () => {
    expect(() => assertOneTurnRequest({ prompt: "p", cacheSystem: true }, "Codex")).not.toThrow();
  });
});
