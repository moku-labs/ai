import { describe, expect, it } from "vitest";
import { failureMessageOf, itemFailureOf, messageDetailOf } from "../../failure";

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

describe("failureMessageOf — a handler's publicMessage", () => {
  const PUBLIC_MESSAGE = "[studio] Invalid assemble request.\n  Name at least one clip.";

  it("forwards the first two lines of a publicMessage", () => {
    const error = Object.assign(new Error("ffmpeg exited 1: /Users/alex/clip.mp4"), {
      kind: "invalid-request",
      publicMessage: `${PUBLIC_MESSAGE}\n  Detail line.`
    });
    expect(failureMessageOf(error)).toBe(PUBLIC_MESSAGE);
  });

  it("cuts a publicMessage at 300 characters", () => {
    const error = Object.assign(new Error("boom"), {
      publicMessage: `[studio] ${"z".repeat(500)}`
    });
    expect(failureMessageOf(error)).toBe(`[studio] ${"z".repeat(291)}`);
  });

  it("wins over our own [ai] message", () => {
    const error = Object.assign(new Error("[ai] fal rejected the image."), {
      publicMessage: PUBLIC_MESSAGE
    });
    expect(failureMessageOf(error)).toBe(PUBLIC_MESSAGE);
  });

  it("is read off a plain object too", () => {
    expect(failureMessageOf({ publicMessage: "x" })).toBe("x");
  });

  it.each<[string, unknown]>([
    ["an empty publicMessage", ""],
    ["a number publicMessage", 42],
    ["an object publicMessage", { text: "[studio] no." }]
  ])("falls back to the [ai] rule for %s", (_name, publicMessage) => {
    const ownError = Object.assign(
      new Error("[ai] ark rejected the request.\n  Check it.\n  Body."),
      {
        publicMessage
      }
    );
    const providerError = Object.assign(new Error("401 Unauthorized: key sk-live-123"), {
      publicMessage
    });

    expect(failureMessageOf(ownError)).toBe("[ai] ark rejected the request.\n  Check it.");
    expect(failureMessageOf(providerError)).toBeUndefined();
  });

  it("carries no message for a plain Error with neither", () => {
    expect(failureMessageOf(new Error("ENOENT: /Users/alex/.secrets"))).toBeUndefined();
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

describe("messageDetailOf", () => {
  it("has the message key only when there is a message", () => {
    expect(messageDetailOf("[ai] no.")).toEqual({ message: "[ai] no." });
    expect(messageDetailOf(undefined)).toEqual({});
  });
});
