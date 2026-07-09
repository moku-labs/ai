import { describe, expect, it } from "vitest";
import { broadcastEvent, closeAllSubscribers, createEventQueue } from "../../stream";
import type { ActiveRun, EventQueue, RunEvent } from "../../types";
import { ZERO_TOTALS } from "./fixtures";

/**
 * Drains a queue's async iterable fully into an array. The queue must
 * already be (or become) closed, or this hangs — every test either closes
 * the queue or pushes a terminal record before draining.
 *
 * @param queue - The queue to drain.
 * @returns Every record delivered, in delivery order.
 * @example
 * ```ts
 * const events = await drain(queue);
 * ```
 */
async function drain(queue: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

/**
 * Builds a fake `ActiveRun` with an empty subscriber set, for broadcast
 * tests.
 *
 * @returns A fake active-run record.
 * @example
 * ```ts
 * const active = fakeActiveRun();
 * ```
 */
function fakeActiveRun(): ActiveRun {
  return { runId: "run-1", signal: undefined, subscribers: new Set(), inFlight: 0 };
}

// ---------------------------------------------------------------------------
// createEventQueue — FIFO, overflow coalescing, progress coalescing, terminal
// ---------------------------------------------------------------------------

/** Pushes events one at a time — EventQueue.push takes a single record. */
function pushAll(queue: EventQueue, events: RunEvent[]): void {
  for (const event of events) {
    queue.push(event);
  }
}

describe("createEventQueue", () => {
  it("delivers item events in FIFO push order", async () => {
    const queue = createEventQueue(10);
    pushAll(queue, [
      { type: "item:dispatching", itemId: "i1" },
      { type: "item:dispatching", itemId: "i2" }
    ]);
    queue.close();

    const events = await drain(queue);
    expect(events).toEqual([
      { type: "item:dispatching", itemId: "i1" },
      { type: "item:dispatching", itemId: "i2" }
    ]);
  });

  it("drops the oldest item events on overflow, coalescing them into one overflow marker", async () => {
    const queue = createEventQueue(2);
    pushAll(queue, [
      { type: "item:dispatching", itemId: "i1" },
      { type: "item:dispatching", itemId: "i2" },
      { type: "item:dispatching", itemId: "i3" },
      { type: "item:dispatching", itemId: "i4" }
    ]); // drops i2
    queue.close();

    const events = await drain(queue);
    expect(events).toEqual([
      { type: "overflow", dropped: 2 },
      { type: "item:dispatching", itemId: "i3" },
      { type: "item:dispatching", itemId: "i4" }
    ]);
  });

  it("coalesces progress records: only the latest unconsumed one is delivered", async () => {
    const queue = createEventQueue(10);
    pushAll(queue, [
      { type: "progress", totals: { ...ZERO_TOTALS, total: 1 } },
      { type: "progress", totals: { ...ZERO_TOTALS, total: 2 } },
      { type: "progress", totals: { ...ZERO_TOTALS, total: 3 } }
    ]);
    queue.close();

    const events = await drain(queue);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "progress", totals: { total: 3 } });
  });

  it("always delivers a terminal record, even after overflow", async () => {
    const queue = createEventQueue(1);
    pushAll(queue, [
      { type: "item:dispatching", itemId: "i1" },
      { type: "item:dispatching", itemId: "i2" },
      { type: "terminal", status: "done", totals: { ...ZERO_TOTALS, total: 1 } }
    ]);

    const events = await drain(queue);
    expect(events).toEqual([
      { type: "overflow", dropped: 1 },
      { type: "item:dispatching", itemId: "i2" },
      { type: "terminal", status: "done", totals: { ...ZERO_TOTALS, total: 1 } }
    ]);
  });

  it("delivers buffered events pushed before close(), then completes", async () => {
    const queue = createEventQueue(10);
    queue.push({ type: "item:queued", itemId: "i1", task: "t", provider: "p" });
    queue.close();

    const events = await drain(queue);
    expect(events).toHaveLength(1);
  });

  it("ignores pushes after close()", async () => {
    const queue = createEventQueue(10);
    queue.close();
    queue.push({ type: "item:queued", itemId: "i1", task: "t", provider: "p" });

    const events = await drain(queue);
    expect(events).toEqual([]);
  });

  it("resolves next() lazily when a consumer awaits before any push arrives", async () => {
    const queue = createEventQueue(10);
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push({ type: "item:queued", itemId: "i1", task: "t", provider: "p" });
    const result = await pending;

    expect(result.done).toBe(false);
    expect(result.value).toEqual({ type: "item:queued", itemId: "i1", task: "t", provider: "p" });
    queue.close();
  });
});

// ---------------------------------------------------------------------------
// broadcastEvent / closeAllSubscribers
// ---------------------------------------------------------------------------

describe("broadcastEvent", () => {
  it("pushes the event to every current subscriber", async () => {
    const active = fakeActiveRun();
    const subscriberA = createEventQueue(10);
    const subscriberB = createEventQueue(10);
    active.subscribers.add(subscriberA);
    active.subscribers.add(subscriberB);

    broadcastEvent(active, { type: "item:flagged", itemId: "i1" });
    subscriberA.close();
    subscriberB.close();

    expect(await drain(subscriberA)).toEqual([{ type: "item:flagged", itemId: "i1" }]);
    expect(await drain(subscriberB)).toEqual([{ type: "item:flagged", itemId: "i1" }]);
  });
});

describe("closeAllSubscribers", () => {
  it("closes and detaches every subscriber", async () => {
    const active = fakeActiveRun();
    const subscriber = createEventQueue(10);
    active.subscribers.add(subscriber);

    closeAllSubscribers(active);

    expect(active.subscribers.size).toBe(0);
    // A closed queue with nothing buffered drains to an empty array.
    expect(await drain(subscriber)).toEqual([]);
  });
});
