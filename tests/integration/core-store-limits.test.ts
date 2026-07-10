/**
 * @file Batch 2 — core store CAS + limits admission-control integration
 * scenarios (S06–S09).
 *
 * S05 (store CAS round-trip + first-committer-wins) is intentionally SKIPPED
 * here: it is already implemented in `core-journal-ledger.test.ts` (Batch 1).
 *
 * Exercises the store and limits core plugins through the REAL framework
 * composition (all regular plugins + probe fixture), against per-test tmp-dir
 * journal.db / store dirs. No network, no `.moku/` in the repo.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestFramework } from "./helpers";
import { buildFramework } from "./helpers";

/** App shape produced by the shared test framework builder. */
type TestApp = ReturnType<TestFramework["createApp"]>;

/** Flushes the microtask queue so pending-promise probes settle deterministically. */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

describe("core store + limits integration", () => {
  let tempDir: string;
  let app: TestApp | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (app) {
      await app.stop();
      app = undefined;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // S06 — store integrity verification + gc
  // ---------------------------------------------------------------------------

  it("S06: store read re-verifies integrity and gc sweeps unreferenced objects", async () => {
    app = buildFramework(tempDir).createApp();
    await app.start();
    const store = app.probe.store;

    // Write object A, then corrupt it on disk behind the CAS's back.
    const bytesA = new TextEncoder().encode("artifact-A");
    const putA = await store.put(bytesA);
    await writeFile(putA.path, new TextEncoder().encode("corrupted!"));

    // read() recomputes the hash and refuses the corrupt object.
    await expect(store.read(putA.hash)).rejects.toThrow(/integrity check failed/);

    // Write object B, then sweep keeping only B — the corrupt A object goes.
    const bytesB = new TextEncoder().encode("artifact-B");
    const putB = await store.put(bytesB);
    const swept = await store.gc(new Set([putB.hash]));

    expect(swept.removed).toBe(1);
    expect(swept.bytesFreed).toBeGreaterThan(0);
    expect(await store.has(putA.hash)).toBe(false);
    expect(await store.has(putB.hash)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // S07 — limits concurrency gate: FIFO waiters + snapshot + lanes()
  // ---------------------------------------------------------------------------

  it("S07: limits concurrency gate queues FIFO waiters and reports snapshot/lanes", async () => {
    app = buildFramework(tempDir, {
      pluginConfigs: {
        limits: {
          defaults: { rpm: 6000, concurrency: 2, breakerThreshold: 5, breakerCooldownMs: 30_000 },
          lanes: {}
        }
      }
    }).createApp();
    await app.start();
    const limits = app.probe.limits;
    const lane = "voiceover/fake";

    // Fill both concurrency slots.
    const handle1 = await limits.acquire(lane);
    const handle2 = await limits.acquire(lane);

    // Queue two more acquires; both must stay pending while slots are full.
    const resolved: number[] = [];
    const pending3 = limits.acquire(lane).then(handle => {
      resolved.push(3);
      return handle;
    });
    const pending4 = limits.acquire(lane).then(handle => {
      resolved.push(4);
      return handle;
    });
    await flushMicrotasks();
    expect(resolved).toEqual([]);
    expect(limits.snapshot(lane)).toMatchObject({
      lane,
      inFlight: 2,
      waiting: 2,
      breaker: "closed"
    });

    // Releasing slot #1 admits waiter #3 first (FIFO), leaving #4 queued.
    handle1.release();
    const handle3 = await pending3;
    await flushMicrotasks();
    expect(resolved).toEqual([3]);
    expect(limits.snapshot(lane)).toMatchObject({ inFlight: 2, waiting: 1 });

    // Releasing slot #2 admits waiter #4.
    handle2.release();
    const handle4 = await pending4;
    expect(resolved).toEqual([3, 4]);

    // Everything releases back to an idle lane, and the lane is tracked.
    handle3.release();
    handle4.release();
    expect(limits.snapshot(lane)).toMatchObject({ inFlight: 0, waiting: 0 });
    expect(limits.lanes()).toContain(lane);
  });

  // ---------------------------------------------------------------------------
  // S08 — limits token bucket + laneConfig merge
  // ---------------------------------------------------------------------------

  it("S08: limits token bucket blocks on exhaustion and laneConfig merges overrides", async () => {
    app = buildFramework(tempDir, {
      pluginConfigs: {
        limits: {
          defaults: { rpm: 60, concurrency: 4, breakerThreshold: 5, breakerCooldownMs: 30_000 },
          lanes: {
            "voiceover/fake": { rpm: 2, concurrency: 8 },
            "voiceover/fake/vip": { rpm: 100 }
          }
        }
      }
    }).createApp();
    await app.start();
    const limits = app.probe.limits;
    const lane = "voiceover/fake/default";

    // Prefix ("{task}/{provider}") override applies; defaults fill unset fields.
    expect(limits.laneConfig(lane)).toEqual({
      rpm: 2,
      concurrency: 8,
      breakerThreshold: 5,
      breakerCooldownMs: 30_000
    });

    // Exact-key override wins over the prefix override.
    expect(limits.laneConfig("voiceover/fake/vip")).toEqual({
      rpm: 100,
      concurrency: 8,
      breakerThreshold: 5,
      breakerCooldownMs: 30_000
    });

    vi.useFakeTimers();

    // Drain both tokens of the rpm-2 bucket (concurrency 8 — no slot blocking).
    const first = await limits.acquire(lane);
    first.release();
    const second = await limits.acquire(lane);
    second.release();

    // The third acquire must pend until the bucket refills.
    let thirdResolved = false;
    const third = limits.acquire(lane).then(handle => {
      thirdResolved = true;
      return handle;
    });
    await flushMicrotasks();
    expect(thirdResolved).toBe(false);

    // rpm 2 refills one token every 30s — advancing past that unblocks it.
    await vi.advanceTimersByTimeAsync(30_001);
    const handle = await third;
    expect(thirdResolved).toBe(true);
    handle.release();
  });

  // ---------------------------------------------------------------------------
  // S09 — circuit breaker lifecycle
  // ---------------------------------------------------------------------------

  it("S09: circuit breaker walks closed → open → half-open → closed", async () => {
    app = buildFramework(tempDir, {
      pluginConfigs: {
        limits: {
          defaults: { rpm: 6000, concurrency: 4, breakerThreshold: 2, breakerCooldownMs: 1000 },
          lanes: {}
        }
      }
    }).createApp();
    await app.start();
    const limits = app.probe.limits;
    const lane = "voiceover/fake";

    vi.useFakeTimers();
    expect(limits.snapshot(lane).breaker).toBe("closed");

    // Two consecutive retryable errors trip the threshold-2 breaker open.
    limits.reportOutcome(lane, "retryable-error");
    limits.reportOutcome(lane, "retryable-error");
    expect(limits.snapshot(lane).breaker).toBe("open");

    // An open breaker rejects immediately with the tagged reason — and the
    // failed acquire leaks no token or concurrency slot.
    await expect(limits.acquire(lane)).rejects.toMatchObject({ reason: "breaker-open" });
    expect(limits.snapshot(lane)).toMatchObject({ inFlight: 0, waiting: 0 });

    // Cooldown elapsed → half-open admits exactly one trial probe.
    vi.advanceTimersByTime(1001);
    expect(limits.snapshot(lane).breaker).toBe("half-open");
    const probeHandle = await limits.acquire(lane);
    await expect(limits.acquire(lane)).rejects.toMatchObject({ reason: "breaker-open" });

    // A successful probe outcome closes the breaker again.
    limits.reportOutcome(lane, "ok");
    expect(limits.snapshot(lane).breaker).toBe("closed");
    const secondHandle = await limits.acquire(lane);

    // Nothing leaked: releases return the lane to zero in-flight.
    probeHandle.release();
    secondHandle.release();
    expect(limits.snapshot(lane)).toMatchObject({ inFlight: 0, waiting: 0, breaker: "closed" });
  });
});
