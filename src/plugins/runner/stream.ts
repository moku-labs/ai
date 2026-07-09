/**
 * @file runner stream — events() consumer queues + overflow coalescing.
 * Backpressure contract (ratified OQ7): bounded per-consumer buffer; on
 * overflow, oldest ITEM records are dropped and replaced by one
 * `{ type: "overflow", dropped: n }` marker; progress records coalesce
 * (latest unconsumed wins); a terminal record is ALWAYS delivered before
 * the iterable completes.
 */
import type { ActiveRun, EventQueue, RunEvent } from "./types";

/**
 * Creates a bounded per-consumer event queue: item-type records are FIFO
 * and bounded to `bufferSize` (oldest dropped on overflow, coalesced into a
 * single overflow marker); `"progress"` records coalesce to the latest
 * unconsumed one; a `"terminal"` record is always delivered, after any
 * buffered data, before the iterable completes.
 *
 * @param bufferSize - Max buffered item records before overflow coalescing.
 * @returns A queue that is both an {@link EventQueue} sink and an `AsyncIterable<RunEvent>` source.
 * @example
 * ```ts
 * const queue = createEventQueue(10_000);
 * queue.push({ type: "item:done", itemId: "i1", costUsd: 0.1, contentHash: "abc" });
 * queue.close();
 * ```
 */
export function createEventQueue(bufferSize: number): EventQueue & AsyncIterable<RunEvent> {
  const items: RunEvent[] = [];
  let progress: RunEvent | undefined;
  let terminal: RunEvent | undefined;
  let overflowDropped = 0;
  let closed = false;
  let waiter: ((result: IteratorResult<RunEvent>) => void) | undefined;

  /**
   * Synchronously takes the next record from the queue's priority order
   * (overflow marker, then oldest item, then progress, then terminal),
   * without waiting.
   *
   * @returns The next iterator result, or undefined when nothing is ready yet.
   * @example
   * ```ts
   * const ready = tryTake();
   * ```
   */
  function tryTake(): IteratorResult<RunEvent> | undefined {
    if (overflowDropped > 0) {
      const event: RunEvent = { type: "overflow", dropped: overflowDropped };
      overflowDropped = 0;
      return { value: event, done: false };
    }
    const item = items.shift();
    if (item) {
      return { value: item, done: false };
    }
    if (progress) {
      const event = progress;
      progress = undefined;
      return { value: event, done: false };
    }
    if (terminal) {
      const event = terminal;
      terminal = undefined;
      closed = true;
      return { value: event, done: false };
    }
    if (closed) {
      return { value: undefined, done: true };
    }
    return undefined;
  }

  /**
   * Wakes a pending consumer `next()` call, if one is waiting and data (or
   * closure) is now available.
   *
   * @example
   * ```ts
   * wake();
   * ```
   */
  function wake(): void {
    if (!waiter) return;
    const ready = tryTake();
    if (!ready) return;
    const resolve = waiter;
    waiter = undefined;
    resolve(ready);
  }

  return {
    /**
     * Pushes one event into the queue: `"progress"` coalesces onto the
     * latest unconsumed one, `"terminal"` is always delivered, and every
     * other (item) event is FIFO-bounded to `bufferSize` (oldest dropped,
     * coalesced into an `"overflow"` marker). A no-op once `close()`'d.
     *
     * @param event - The event to enqueue.
     * @example
     * ```ts
     * queue.push({ type: "item:dispatching", itemId: "i1" });
     * ```
     */
    push(event: RunEvent): void {
      if (closed) return;
      if (event.type === "progress") {
        progress = event;
      } else if (event.type === "terminal") {
        terminal = event;
      } else {
        if (items.length >= bufferSize) {
          items.shift();
          overflowDropped += 1;
        }
        items.push(event);
      }
      wake();
    },
    /**
     * Marks the queue closed. Buffered records already pushed are still
     * delivered; the iterable completes once they (and any terminal
     * record) are drained.
     *
     * @example
     * ```ts
     * queue.close();
     * ```
     */
    close(): void {
      closed = true;
      wake();
    },
    /**
     * Returns this queue's async iterator.
     *
     * @returns An `AsyncIterator` over this queue's {@link RunEvent} records.
     * @example
     * ```ts
     * for await (const event of queue) event.type;
     * ```
     */
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      return {
        /**
         * Resolves with the next ready record, or waits for one to arrive.
         *
         * @returns The next iterator result.
         * @example
         * ```ts
         * const result = await iterator.next();
         * ```
         */
        next: (): Promise<IteratorResult<RunEvent>> => {
          const ready = tryTake();
          if (ready) return Promise.resolve(ready);
          return new Promise(resolve => {
            waiter = resolve;
          });
        }
      };
    }
  };
}

/**
 * Pushes one event to every current subscriber of the active run.
 *
 * @param active - The active run's live bookkeeping.
 * @param event - The event to broadcast.
 * @example
 * ```ts
 * broadcastEvent(active, { type: "item:dispatching", itemId: "i1" });
 * ```
 */
export function broadcastEvent(active: ActiveRun, event: RunEvent): void {
  for (const subscriber of active.subscribers) {
    subscriber.push(event);
  }
}

/**
 * Closes and detaches every current subscriber of the active run, called
 * once the run reaches a terminal state.
 *
 * @param active - The active run's live bookkeeping.
 * @example
 * ```ts
 * closeAllSubscribers(active);
 * ```
 */
export function closeAllSubscribers(active: ActiveRun): void {
  for (const subscriber of active.subscribers) {
    subscriber.close();
  }
  active.subscribers.clear();
}
