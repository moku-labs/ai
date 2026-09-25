/**
 * @file runner stream — events() consumer queues + overflow coalescing.
 * Backpressure contract (ratified OQ7, keyed by runId since concurrent runs):
 * one bounded buffer per consumer across all the runs it follows; on
 * overflow, oldest ITEM records are dropped and replaced by one
 * `{ type: "overflow", runId, dropped: n }` marker per run; progress records
 * coalesce per run (latest unconsumed wins); one terminal record per run is
 * ALWAYS delivered, after that run's buffered records. The queue never closes
 * itself: the runner closes it when the runs it follows have ended.
 */
import type { EventQueue, RunEvent, State, Subscriber, UnstampedRunEvent } from "./types";

/**
 * Creates a bounded per-consumer event queue. Item records are FIFO and
 * bounded to `bufferSize` across every run the consumer follows (oldest
 * dropped on overflow, counted into one overflow marker per run);
 * `"progress"` records coalesce to the latest unconsumed one per run; each
 * run's `"terminal"` record is delivered once that run has nothing else
 * buffered, without waiting for the other runs. The iterable completes after
 * `close()`, once everything buffered has been delivered.
 *
 * A consumer that stops early (`break` out of `for await`) ends the queue:
 * the buffer is dropped and `onReturn` detaches it from the runner.
 *
 * @param bufferSize - Max buffered item records before overflow coalescing.
 * @param onReturn - Called once when the consumer stops iterating early.
 * @returns A queue that is both an {@link EventQueue} sink and an `AsyncIterable<RunEvent>` source.
 * @example
 * ```ts
 * const queue = createEventQueue(10_000);
 * queue.push({ type: "item:done", runId: "run-1", itemId: "i1", costUsd: 0.1, contentHash: "abc" });
 * queue.close(); // the loop below gets that record, then completes
 * ```
 */
export function createEventQueue(
  bufferSize: number,
  onReturn?: () => void
): EventQueue & AsyncIterable<RunEvent> {
  const items: RunEvent[] = [];
  const bufferedPerRun = new Map<string, number>();
  const dropped = new Map<string, number>();
  const progress = new Map<string, RunEvent>();
  const terminals = new Map<string, RunEvent>();
  let closed = false;
  let waiter: ((result: IteratorResult<RunEvent>) => void) | undefined;

  /**
   * Whether a run still has item records in the buffer.
   *
   * @param runId - The run.
   * @returns True while any buffered item record belongs to `runId`.
   * @example
   * ```ts
   * hasItemsOf("run-1"); // false once run-1's records were all taken
   * ```
   */
  function hasItemsOf(runId: string): boolean {
    return bufferedPerRun.has(runId);
  }

  /**
   * Keeps the per-run count of buffered item records, so {@link hasItemsOf}
   * does not scan the buffer on every take.
   *
   * @param runId - The run whose count changes.
   * @param delta - +1 when a record is buffered, -1 when one leaves.
   * @example
   * ```ts
   * countItem("run-1", 1); // hasItemsOf("run-1") is now true
   * ```
   */
  function countItem(runId: string, delta: number): void {
    const count = (bufferedPerRun.get(runId) ?? 0) + delta;
    if (count > 0) bufferedPerRun.set(runId, count);
    else bufferedPerRun.delete(runId);
  }

  /**
   * Takes the oldest buffered item record.
   *
   * @returns The record, or undefined when the buffer is empty.
   * @example
   * ```ts
   * takeItem(); // { type: "item:queued", runId: "run-1", … }
   * ```
   */
  function takeItem(): RunEvent | undefined {
    const item = items.shift();
    if (item) countItem(item.runId, -1);
    return item;
  }

  /**
   * Takes the overflow marker of the first run that lost records.
   *
   * @returns The marker, or undefined when nothing was dropped.
   * @example
   * ```ts
   * takeOverflow(); // { type: "overflow", runId: "run-1", dropped: 2 }
   * ```
   */
  function takeOverflow(): RunEvent | undefined {
    const [first] = dropped;
    if (!first) return undefined;

    const [runId, count] = first;
    dropped.delete(runId);
    return { type: "overflow", runId, dropped: count };
  }

  /**
   * Takes the last records of a finished run whose item records were all
   * taken: its pending progress first, then its terminal record.
   *
   * @returns The record, or undefined when no finished run is drained yet.
   * @example
   * ```ts
   * takeFinishedRun(); // { type: "terminal", runId: "run-1", status: "done", totals }
   * ```
   */
  function takeFinishedRun(): RunEvent | undefined {
    for (const [runId, terminal] of terminals) {
      if (hasItemsOf(runId)) continue;

      const latest = progress.get(runId);
      if (latest) {
        progress.delete(runId);
        return latest;
      }
      terminals.delete(runId);
      return terminal;
    }
    return undefined;
  }

  /**
   * Takes the latest progress record of the first run that has one.
   *
   * @returns The record, or undefined when no progress is pending.
   * @example
   * ```ts
   * takeProgress(); // { type: "progress", runId: "run-1", totals }
   * ```
   */
  function takeProgress(): RunEvent | undefined {
    const [first] = progress;
    if (!first) return undefined;

    progress.delete(first[0]);
    return first[1];
  }

  /**
   * Synchronously takes the next record, without waiting: overflow markers,
   * then a drained run's last records, then the oldest item, then progress.
   *
   * @returns The next iterator result, or undefined when nothing is ready yet.
   * @example
   * ```ts
   * tryTake(); // { value: { type: "item:queued", … }, done: false }
   * ```
   */
  function tryTake(): IteratorResult<RunEvent> | undefined {
    const next = takeOverflow() ?? takeFinishedRun() ?? takeItem() ?? takeProgress();
    if (next) return { value: next, done: false };
    if (closed) return { value: undefined, done: true };
    return undefined;
  }

  /**
   * Buffers one item record, dropping the oldest one when the buffer is full.
   *
   * @param event - The item record.
   * @example
   * ```ts
   * bufferItem({ type: "item:dispatching", runId: "run-1", itemId: "i1" });
   * ```
   */
  function bufferItem(event: RunEvent): void {
    const oldest = items.length >= bufferSize ? takeItem() : undefined;
    if (oldest) dropped.set(oldest.runId, (dropped.get(oldest.runId) ?? 0) + 1);
    items.push(event);
    countItem(event.runId, 1);
  }

  /**
   * Wakes a pending consumer `next()` call, if one is waiting and data (or
   * closure) is now available.
   *
   * @example
   * ```ts
   * wake(); // a consumer parked in next() receives the record just pushed
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
     * Pushes one record: `"progress"` coalesces per run, `"terminal"` is
     * kept per run until delivered, every other (item) record is buffered.
     * A no-op once `close()`'d.
     *
     * @param event - The record to enqueue.
     * @example
     * ```ts
     * queue.push({ type: "item:dispatching", runId: "run-1", itemId: "i1" });
     * ```
     */
    push(event: RunEvent): void {
      if (closed) return;

      if (event.type === "progress") progress.set(event.runId, event);
      else if (event.type === "terminal") terminals.set(event.runId, event);
      else bufferItem(event);
      wake();
    },
    /**
     * Marks the queue closed. Records already pushed are still delivered;
     * the iterable completes once they are drained.
     *
     * @example
     * ```ts
     * queue.close(); // no more records are accepted
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
     * for await (const event of queue) event.runId;
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
         * await iterator.next(); // { value: { type: "terminal", … }, done: false }
         * ```
         */
        next: (): Promise<IteratorResult<RunEvent>> => {
          const ready = tryTake();
          if (ready) return Promise.resolve(ready);
          return new Promise(resolve => {
            waiter = resolve;
          });
        },
        /**
         * Ends the stream early: drops everything buffered and detaches the
         * consumer, so a run it no longer reads does not fill its buffer.
         *
         * @returns The completed iterator result.
         * @example
         * ```ts
         * for await (const event of queue) if (event.type === "item:done") break; // calls return()
         * ```
         */
        return: (): Promise<IteratorResult<RunEvent>> => {
          const wasOpen = !closed;
          closed = true;
          items.length = 0;
          for (const buffer of [bufferedPerRun, dropped, progress, terminals]) buffer.clear();
          if (wasOpen) onReturn?.();
          wake();
          return Promise.resolve({ value: undefined, done: true });
        }
      };
    }
  };
}

/**
 * Stamps a pipeline record with the run it belongs to.
 *
 * @param runId - The reporting run.
 * @param event - The record without its runId.
 * @returns The stream record.
 * @example
 * ```ts
 * stampRunId("run-1", { type: "item:flagged", itemId: "i1" }); // { type: "item:flagged", itemId: "i1", runId: "run-1" }
 * ```
 */
export function stampRunId(runId: string, event: UnstampedRunEvent): RunEvent {
  return { ...event, runId };
}

/**
 * Whether a consumer receives the records of a run.
 *
 * @param subscriber - The consumer.
 * @param runId - The run.
 * @returns True for an all-runs consumer, or one following exactly `runId`.
 * @example
 * ```ts
 * follows({ queue, runId: undefined }, "run-1"); // true
 * ```
 */
function follows(subscriber: Subscriber, runId: string): boolean {
  return subscriber.runId === undefined || subscriber.runId === runId;
}

/**
 * Pushes one record to every consumer that follows its run.
 *
 * @param state - Runner state (its `subscribers`).
 * @param event - The record to deliver.
 * @example
 * ```ts
 * broadcastEvent(state, { type: "item:dispatching", runId: "run-1", itemId: "i1" });
 * ```
 */
export function broadcastEvent(state: State, event: RunEvent): void {
  for (const subscriber of state.subscribers) {
    if (follows(subscriber, event.runId)) subscriber.queue.push(event);
  }
}

/**
 * Closes and detaches the consumers that are done once `runId` ended: the
 * ones following that run, and the all-runs ones when no run is active any
 * more. Call it after the run left `state.active`.
 *
 * @param state - Runner state.
 * @param runId - The run that ended.
 * @example
 * ```ts
 * closeSubscribers(state, "run-1"); // run-1 consumers end; all-runs ones end too if nothing else runs
 * ```
 */
export function closeSubscribers(state: State, runId: string): void {
  const noRunActive = state.active.size === 0;

  for (const subscriber of state.subscribers) {
    const isDone = subscriber.runId === runId || (subscriber.runId === undefined && noRunActive);
    if (!isDone) continue;

    subscriber.queue.close();
    state.subscribers.delete(subscriber);
  }
}
