import { describe, expectTypeOf, it } from "vitest";
import type { PromptGenHandler } from "../../../promptGen/contract";
import type { TranslateHandler } from "../../../translate/contract";
import type { VoiceoverHandler } from "../../../voiceover/contract";
import { createPromptGenHandler } from "../../prompt-gen/handler";
import { createTranslateHandler } from "../../translate/handler";
import { createTtsHandler } from "../../tts/handler";
import type { OpenaiContext } from "../../types";

describe("openai type-level: handlers satisfy their task contracts", () => {
  it("createTtsHandler's return value satisfies VoiceoverHandler structurally", () => {
    expectTypeOf(createTtsHandler).returns.toEqualTypeOf<VoiceoverHandler>();
  });

  it("createTtsHandler accepts an OpenaiContext", () => {
    expectTypeOf(createTtsHandler).parameter(0).toEqualTypeOf<OpenaiContext>();
  });

  it("createTranslateHandler's return value satisfies TranslateHandler structurally", () => {
    expectTypeOf(createTranslateHandler).returns.toEqualTypeOf<TranslateHandler>();
  });

  it("createTranslateHandler accepts an OpenaiContext", () => {
    expectTypeOf(createTranslateHandler).parameter(0).toEqualTypeOf<OpenaiContext>();
  });

  it("createPromptGenHandler's return value satisfies PromptGenHandler structurally", () => {
    expectTypeOf(createPromptGenHandler).returns.toEqualTypeOf<PromptGenHandler>();
  });

  it("createPromptGenHandler accepts an OpenaiContext", () => {
    expectTypeOf(createPromptGenHandler).parameter(0).toEqualTypeOf<OpenaiContext>();
  });
});
