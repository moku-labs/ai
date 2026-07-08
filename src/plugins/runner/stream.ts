/**
 * @file runner stream — events() consumer queues + overflow coalescing skeleton.
 */
import type { EventQueue } from "./types";

/**
 * Creates a bounded per-consumer event queue (overflow coalesces into a
 * single overflow record; terminal records are always delivered).
 *
 * @param _bufferSize - Max buffered records before overflow coalescing.
 * @example
 * ```ts
 * const queue = createEventQueue(10_000);
 * ```
 */
export function createEventQueue(_bufferSize: number): EventQueue {
  throw new Error("not implemented");
}
