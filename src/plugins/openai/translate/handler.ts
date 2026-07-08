/**
 * @file openai translate handler — implements the translate task-owned contract.
 */
import type { TranslateHandler } from "../../translate/contract";

/**
 * Creates the OpenAI translate handler (estimate via price table,
 * execute via chat.completions.create with signal passthrough).
 *
 * @param _ctx - Plugin context (config + state + env + log).
 * @example
 * ```ts
 * registry.register("translate", "openai", createTranslateHandler(ctx));
 * ```
 */
export function createTranslateHandler(_ctx: unknown): TranslateHandler {
  throw new Error("not implemented");
}
