import { describe, expect, it } from "vitest";
import { failureMessageOf, itemFailureOf } from "../../failure";

describe("failureMessageOf", () => {
  it("keeps the first two lines of our own [ai] error", () => {
    const error = new Error("[ai] fal rejected the image.\n  Use a PNG or JPEG.\n  Detail line.");
    expect(failureMessageOf(error)).toBe("[ai] fal rejected the image.\n  Use a PNG or JPEG.");
  });

  it("keeps a one-line [ai] error whole", () => {
    expect(failureMessageOf(new Error("[ai] Aborted."))).toBe("[ai] Aborted.");
  });

  it("cuts the message at 300 characters", () => {
    const message = failureMessageOf(new Error(`[ai] ${"y".repeat(500)}`));
    expect(message).toHaveLength(300);
  });

  it.each<[string, unknown]>([
    ["a provider's own error", new Error("401 Unauthorized: key sk-live-123")],
    ["an [ai] text not at the start", new Error("upstream said: [ai] nope")],
    ["a plain object with an [ai] message", { message: "[ai] not an Error" }],
    ["an [ai] string", "[ai] thrown string"],
    ["undefined", undefined]
  ])("carries no message for %s", (_name, error) => {
    expect(failureMessageOf(error)).toBeUndefined();
  });
});

describe("itemFailureOf", () => {
  it("sets the message key only when there is a message", () => {
    expect(itemFailureOf("http-4xx", "[ai] no.")).toEqual({
      errorClass: "http-4xx",
      message: "[ai] no."
    });
    expect(itemFailureOf("http-4xx", undefined)).not.toHaveProperty("message");
  });
});
