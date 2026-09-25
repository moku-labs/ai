import { describe, expect, it } from "vitest";
import { addActiveRun, createRunnerState } from "../../state";
import { broadcastEvent, closeSubscribers, createEventQueue } from "../../stream";
import type { EventQueue, RunEvent } from "../../types";
import { ZERO_TOTALS } from "./fixtures";

/**
 * Drains a queue's async iterable fully into an array. The queue must
 * already be (or become) closed, or this hangs — every test closes the
 * queue before draining.
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

/** Pushes events one at a time — EventQueue.push takes a single record. */
function pushAll(queue: EventQueue, events: RunEvent[]): void {
  for (const event of events) {
    queue.push(event);
  }
}

/**
 * A `dispatching` record of one run, the smallest item record.
 *
 * @param runId - The run it belongs to.
 * @param itemId - The item.
 * @returns The record.
 * @example
 * ```ts
 * dispatching("run-a", "i1");
 * ```
 */
function dispatching(runId: string, itemId: string): RunEvent {
  return { type: "item:dispatching", runId, itemId };
}

/**
 * A `terminal` record of one run.
 *
 * @param runId - The run it belongs to.
 * @returns The record.
 * @example
 * ```ts
 * terminal("run-a");
 * ```
 */
function terminal(runId: string): RunEvent {
  return { type: "terminal", runId, status: "done", totals: { ...ZERO_TOTALS, total: 1 } };
}

// ---------------------------------------------------------------------------
// createEventQueue — FIFO, overflow coalescing, progress coalescing, terminal
// ---------------------------------------------------------------------------

describe("createEventQueue", () => {
  it("delivers item events in FIFO push order", async () => {
    const queue = createEventQueue(10);
    pushAll(queue, [dispatching("run-1", "i1"), dispatching("run-1", "i2")]);
    queue.close();

    const events = await drain(queue);
    expect(events).toEqual([dispatching("run-1", "i1"), dispatching("run-1", "i2")]);
  });

  it("drops the oldest item events on overflow, coalescing them into one overflow marker", async () => {
    const queue = createEventQueue(2);
    pushAll(queue, [
      dispatching("run-1", "i1"),
      dispatching("run-1", "i2"),
      dispatching("run-1", "i3"),
      dispatching("run-1", "i4")
    ]); // drops i1 and i2
    queue.close();

    const events = await drain(queue);
    expect(events).toEqual([
      { type: "overflow", runId: "run-1", dropped: 2 },
      dispatching("run-1", "i3"),
      dispatching("run-1", "i4")
    ]);
  });

  it("coalesces progress records: only the latest unconsumed one is delivered", async () => {
    const queue = createEventQueue(10);
    pushAll(queue, [
      { type: "progress", runId: "run-1", totals: { ...ZERO_TOTALS, total: 1 } },
      { type: "progress", runId: "run-1", totals: { ...ZERO_TOTALS, total: 2 } },
      { type: "progress", runId: "run-1", totals: { ...ZERO_TOTALS, total: 3 } }
    ]);
    queue.close();

    const events = await drain(queue);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "progress", totals: { total: 3 } });
  });

  it("always delivers a terminal record, even after overflow", async () => {
    const queue = createEventQueue(1);
    pushAll(queue, [dispatching("run-1", "i1"), dispatching("run-1", "i2"), terminal("run-1")]);
    queue.close();

    const events = await drain(queue);
    expect(events).toEqual([
      { type: "overflow", runId: "run-1", dropped: 1 },
      dispatching("run-1", "i2"),
      terminal("run-1")
    ]);
  });

  it("delivers buffered events pushed before close(), then completes", async () => {
    const queue = createEventQueue(10);
    queue.push({ type: "item:queued", runId: "run-1", itemId: "i1", task: "t", provider: "p" });
    queue.close();

    const events = await drain(queue);
    expect(events).toHaveLength(1);
  });

  it("ignores pushes after close()", async () => {
    const queue = createEventQueue(10);
    queue.close();
    queue.push({ type: "item:queued", runId: "run-1", itemId: "i1", task: "t", provider: "p" });

    const events = await drain(queue);
    expect(events).toEqual([]);
  });

  it("resolves next() lazily when a consumer awaits before any push arrives", async () => {
    const queue = createEventQueue(10);
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push({ type: "item:queued", runId: "run-1", itemId: "i1", task: "t", provider: "p" });
    const result = await pending;

    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      type: "item:queued",
      runId: "run-1",
      itemId: "i1",
      task: "t",
      provider: "p"
    });
    queue.close();
  });

  describe("several runs in one queue", () => {
    it("coalesces progress per run: the latest record of each run is delivered", async () => {
      const queue = createEventQueue(10);
      pushAll(queue, [
        { type: "progress", runId: "run-a", totals: { ...ZERO_TOTALS, done: 1 } },
        { type: "progress", runId: "run-b", totals: { ...ZERO_TOTALS, done: 5 } },
        { type: "progress", runId: "run-a", totals: { ...ZERO_TOTALS, done: 2 } }
      ]);
      queue.close();

      const events = await drain(queue);
      expect(events).toEqual([
        { type: "progress", runId: "run-a", totals: { ...ZERO_TOTALS, done: 2 } },
        { type: "progress", runId: "run-b", totals: { ...ZERO_TOTALS, done: 5 } }
      ]);
    });

    it("emits one overflow marker per run, carrying that run's runId", async () => {
      const queue = createEventQueue(2);
      pushAll(queue, [
        dispatching("run-a", "a1"),
        dispatching("run-b", "b1"),
        dispatching("run-a", "a2"),
        dispatching("run-a", "a3"),
        dispatching("run-b", "b2")
      ]); // drops a1, b1, a2
      queue.close();

      const events = await drain(queue);
      expect(events).toEqual([
        { type: "overflow", runId: "run-a", dropped: 2 },
        { type: "overflow", runId: "run-b", dropped: 1 },
        dispatching("run-a", "a3"),
        dispatching("run-b", "b2")
      ]);
    });

    it("delivers each run's terminal after that run's buffered items, without waiting for the other run", async () => {
      const queue = createEventQueue(10);
      pushAll(queue, [
        dispatching("run-a", "a1"),
        dispatching("run-b", "b1"),
        dispatching("run-b", "b2"),
        terminal("run-a"),
        dispatching("run-b", "b3")
      ]);
      queue.close();

      const events = await drain(queue);
      expect(events).toEqual([
        dispatching("run-a", "a1"),
        terminal("run-a"),
        dispatching("run-b", "b1"),
        dispatching("run-b", "b2"),
        dispatching("run-b", "b3")
      ]);
    });

    it("hands out a run's last progress before its terminal", async () => {
      const queue = createEventQueue(10);
      pushAll(queue, [
        dispatching("run-b", "b1"),
        { type: "progress", runId: "run-a", totals: { ...ZERO_TOTALS, done: 1 } },
        terminal("run-a")
      ]);
      queue.close();

      const events = await drain(queue);
      expect(events.map(event => `${event.runId}:${event.type}`)).toEqual([
        "run-a:progress",
        "run-a:terminal",
        "run-b:item:dispatching"
      ]);
    });

    it("keeps one terminal per run: both runs' terminals are delivered", async () => {
      const queue = createEventQueue(1);
      pushAll(queue, [
        dispatching("run-a", "a1"),
        dispatching("run-b", "b1"),
        terminal("run-b"),
        terminal("run-a")
      ]);
      queue.close();

      const events = await drain(queue);
      const terminals = events.filter(event => event.type === "terminal");
      expect(terminals).toHaveLength(2);
      expect(terminals).toEqual(expect.arrayContaining([terminal("run-a"), terminal("run-b")]));
      // Each terminal is the last record of its own run.
      for (const runId of ["run-a", "run-b"]) {
        const last = events.findLast(event => event.runId === runId);
        expect(last?.type).toBe("terminal");
      }
    });

    it("does not close the queue when it hands out a terminal record", async () => {
      const queue = createEventQueue(10);
      const iterator = queue[Symbol.asyncIterator]();
      queue.push(terminal("run-a"));

      const first = await iterator.next();
      const pending = iterator.next();
      queue.push(dispatching("run-b", "b1"));
      const second = await pending;
      queue.close();
      const third = await iterator.next();

      expect(first).toEqual({ value: terminal("run-a"), done: false });
      expect(second).toEqual({ value: dispatching("run-b", "b1"), done: false });
      expect(third.done).toBe(true);
    });

    it("keeps the buffer bound across two runs pushing into one queue", async () => {
      const bufferSize = 3;
      const queue = createEventQueue(bufferSize);
      for (let index = 0; index < 10; index += 1) {
        pushAll(queue, [dispatching("run-a", `a${index}`), dispatching("run-b", `b${index}`)]);
      }
      queue.close();

      const events = await drain(queue);
      const items = events.filter(event => event.type === "item:dispatching");
      const dropped = events
        .filter(event => event.type === "overflow")
        .reduce((sum, event) => sum + (event.type === "overflow" ? event.dropped : 0), 0);
      expect(items).toHaveLength(bufferSize);
      expect(dropped).toBe(20 - bufferSize);
    });
  });
});

// ---------------------------------------------------------------------------
// broadcastEvent / closeSubscribers
// ---------------------------------------------------------------------------

describe("broadcastEvent", () => {
  it("pushes the event to every all-runs subscriber and to the subscribers of that run only", async () => {
    const state = createRunnerState();
    const everyRun = createEventQueue(10);
    const runA = createEventQueue(10);
    const runB = createEventQueue(10);
    state.subscribers.add({ queue: everyRun, runId: undefined });
    state.subscribers.add({ queue: runA, runId: "run-a" });
    state.subscribers.add({ queue: runB, runId: "run-b" });

    broadcastEvent(state, { type: "item:flagged", runId: "run-a", itemId: "i1" });
    for (const queue of [everyRun, runA, runB]) queue.close();

    const flagged = { type: "item:flagged", runId: "run-a", itemId: "i1" };
    expect(await drain(everyRun)).toEqual([flagged]);
    expect(await drain(runA)).toEqual([flagged]);
    expect(await drain(runB)).toEqual([]);
  });
});

describe("closeSubscribers", () => {
  it("closes and detaches the finished run's subscribers, keeping all-runs ones while a run is active", async () => {
    const state = createRunnerState();
    addActiveRun(state, "run-b", undefined);
    const everyRun = createEventQueue(10);
    const runA = createEventQueue(10);
    const runB = createEventQueue(10);
    state.subscribers.add({ queue: everyRun, runId: undefined });
    state.subscribers.add({ queue: runA, runId: "run-a" });
    state.subscribers.add({ queue: runB, runId: "run-b" });

    closeSubscribers(state, "run-a");

    expect([...state.subscribers].map(subscriber => subscriber.runId)).toEqual([
      undefined,
      "run-b"
    ]);
    // A closed queue with nothing buffered drains to an empty array.
    expect(await drain(runA)).toEqual([]);
  });

  it("closes the all-runs subscribers once no run is active", async () => {
    const state = createRunnerState();
    const everyRun = createEventQueue(10);
    state.subscribers.add({ queue: everyRun, runId: undefined });

    closeSubscribers(state, "run-a");

    expect(state.subscribers.size).toBe(0);
    expect(await drain(everyRun)).toEqual([]);
  });

  it("return() drops the buffer, calls onReturn once and ends the stream", async () => {
    let returned = 0;
    const queue = createEventQueue(10, () => {
      returned += 1;
    });
    pushAll(queue, [dispatching("run-a", "i1"), dispatching("run-a", "i2")]);

    const seen: RunEvent[] = [];
    for await (const event of queue) {
      seen.push(event);
      break;
    }
    queue.push(dispatching("run-a", "i3"));

    expect(seen).toEqual([dispatching("run-a", "i1")]);
    expect(returned).toBe(1);
    expect(await drain(queue)).toEqual([]);
  });

  it("delivers a run's terminal only after its last buffered item, when the buffer overflowed", async () => {
    const queue = createEventQueue(2);
    pushAll(queue, [
      dispatching("run-a", "i1"),
      dispatching("run-b", "i2"),
      dispatching("run-a", "i3"),
      terminal("run-a")
    ]);
    queue.close();

    expect(await drain(queue)).toEqual([
      { type: "overflow", runId: "run-a", dropped: 1 },
      dispatching("run-b", "i2"),
      dispatching("run-a", "i3"),
      terminal("run-a")
    ]);
  });
});
