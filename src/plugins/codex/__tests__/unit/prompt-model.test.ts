import { describe, expect, it } from "vitest";
import { mapModel } from "../../prompt/model";

describe("mapModel", () => {
  const noDefault = { textModel: "", modelMap: {} };
  const withDefault = { textModel: "gpt-6-sol", modelMap: {} };

  it("gives no model when the request names none and textModel is empty", () => {
    expect(mapModel(noDefault, undefined)).toBeUndefined();
  });

  it("gives textModel when the request names none", () => {
    expect(mapModel(withDefault, undefined)).toBe("gpt-6-sol");
  });

  it("strips the openai/ vendor prefix", () => {
    expect(mapModel(noDefault, "openai/gpt-6-sol")).toBe("gpt-6-sol");
  });

  it.each(["gpt-6-sol", "o4-mini", "codex-mini-latest"])("passes the bare codex id %s", id => {
    expect(mapModel(withDefault, id)).toBe(id);
  });

  it.each([
    "anthropic/claude-opus-5.5",
    "claude-opus-5-5",
    "google/gemini-3-pro",
    "omni-1"
  ])("maps the foreign id %s to textModel", id => {
    expect(mapModel(withDefault, id)).toBe("gpt-6-sol");
    expect(mapModel(noDefault, id)).toBeUndefined();
  });

  it("lets an exact modelMap entry win over every other rule", () => {
    const config = {
      textModel: "gpt-6-sol",
      modelMap: { "openai/gpt-6-sol": "gpt-6-astra", "anthropic/claude-opus-5.5": "o4-mini" }
    };

    expect(mapModel(config, "openai/gpt-6-sol")).toBe("gpt-6-astra");
    expect(mapModel(config, "anthropic/claude-opus-5.5")).toBe("o4-mini");
  });

  it("ignores inherited object keys in modelMap", () => {
    expect(mapModel(withDefault, "constructor")).toBe("gpt-6-sol");
  });

  it("falls back to textModel for a bare openai/ prefix", () => {
    expect(mapModel(withDefault, "openai/")).toBe("gpt-6-sol");
  });
});
