/**
 * @file openai tts handler — implements the voiceover task-owned contract.
 */
import type { VoiceoverHandler } from "../../voiceover/contract";

/**
 * Creates the OpenAI voiceover (tts) handler (estimate via price table,
 * execute via audio.speech.create with signal passthrough).
 *
 * @param _ctx - Plugin context (config + state + env + log).
 * @example
 * ```ts
 * registry.register("voiceover", "openai", createTtsHandler(ctx));
 * ```
 */
export function createTtsHandler(_ctx: unknown): VoiceoverHandler {
  throw new Error("not implemented");
}
