import { describe, expect, it } from "vitest";
import { isPromptGenUnavailable, PromptGenUnavailableError } from "../../contract";

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
    "limit"
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
