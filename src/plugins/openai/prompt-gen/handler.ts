/**
 * @file openai prompt-gen handler — implements the prompt-gen task-owned contract.
 */
import type { PromptGenHandler } from "../../promptGen/contract";

/**
 * Creates the OpenAI prompt-gen handler (estimate via price table,
 * execute via chat.completions.create with signal passthrough).
 *
 * @param _ctx - Plugin context (config + state + env + log).
 * @example
 * ```ts
 * registry.register("prompt-gen", "openai", createPromptGenHandler(ctx));
 * ```
 */
export function createPromptGenHandler(_ctx: unknown): PromptGenHandler {
  throw new Error("not implemented");
}
