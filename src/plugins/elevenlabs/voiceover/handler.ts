/**
 * @file elevenlabs voiceover handler — implements the task-owned contract.
 */
import type { VoiceoverHandler } from "../../voiceover/contract";

/**
 * Creates the ElevenLabs voiceover handler (estimate via price table,
 * execute via POST /v1/text-to-speech/{voiceId} with signal passthrough).
 *
 * @param _ctx - Plugin context (config + state + env + log).
 * @example
 * ```ts
 * registry.register("voiceover", "elevenlabs", createVoiceoverHandler(ctx));
 * ```
 */
export function createVoiceoverHandler(_ctx: unknown): VoiceoverHandler {
  throw new Error("not implemented");
}
