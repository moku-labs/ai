import { describe, expectTypeOf, it } from "vitest";
import type { Dialogue, Runner } from "../../../src/index";

describe("dialogue contract against the runner", () => {
  it("a dialogue scene is a result the runner can journal", () => {
    expectTypeOf<Dialogue.DialogueResult>().toExtend<Runner.HandlerResult>();
  });

  it("a dialogue handler is a handler the runner can execute", () => {
    expectTypeOf<Dialogue.DialogueHandler>().toExtend<Runner.ExecutableHandler>();
  });
});
