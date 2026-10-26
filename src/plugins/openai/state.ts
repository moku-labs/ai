/**
 * @file openai provider plugin — state factory skeleton.
 */
import type { State } from "./types";

/**
 * Creates initial openai state: client and price table created lazily, no
 * remembered tool turns.
 *
 * @returns Initial openai state.
 */
export function createOpenaiState(): State {
  // eslint-disable-next-line unicorn/no-null -- spec/11 pins null as the "not created yet" sentinel (State fields are `X | null`)
  return { client: null, prices: null, turns: new Map() };
}
