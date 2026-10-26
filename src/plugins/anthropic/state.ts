/**
 * @file anthropic provider plugin — state factory and the turn memory: the
 * answer blocks of each tool turn (thinking included), kept so the turn can
 * be sent back unchanged on the next request of the conversation.
 */
import type { AnthropicContentBlock, State } from "./types";

/**
 * Most tool turns kept; the oldest is dropped beyond it.
 *
 * @example
 * ```ts
 * MAX_REMEMBERED_TURNS; // => 500
 * ```
 */
export const MAX_REMEMBERED_TURNS = 500;

/**
 * Creates the initial anthropic state: no client and no price table yet
 * (both built on first use), an empty turn memory of its own.
 *
 * @returns Initial anthropic state.
 */
export function createAnthropicState(): State {
  // eslint-disable-next-line unicorn/no-null -- spec/16 pins null as the "not created yet" sentinel (State fields are `X | null`)
  return { client: null, prices: null, turns: new Map() };
}

/**
 * Keeps an answer's whole content under its first tool_use id, in insertion
 * order; past {@link MAX_REMEMBERED_TURNS} the oldest turn is dropped.
 * Content without a tool_use block is not kept: no assistant turn can refer
 * to it.
 *
 * @param turns - The turn memory (`state.turns`).
 * @param content - The answer blocks, unchanged.
 * @example
 * ```ts
 * rememberTurn(turns, [{ type: "tool_use", id: "toolu_01", name: "read_frame", input: {} }]); // turns.has("toolu_01") === true
 * ```
 */
export function rememberTurn(
  turns: Map<string, AnthropicContentBlock[]>,
  content: readonly AnthropicContentBlock[]
): void {
  const firstCall = content.find(block => block.type === "tool_use");
  if (firstCall === undefined) return;

  turns.set(firstCall.id, [...content]);

  // A Map iterates in insertion order: its first key is the oldest turn.
  const oldest = turns.keys().next();
  if (turns.size > MAX_REMEMBERED_TURNS && oldest.done !== true) turns.delete(oldest.value);
}
