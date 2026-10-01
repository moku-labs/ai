import { describe, expect, it } from "vitest";
import type { DoneArtifact, DoneOutput, DoneResult } from "../../../journal/types";
import { createDrainController, executeItem } from "../../pipeline";
import type { HandlerResult, RunnerContext, UnstampedRunEvent } from "../../types";
import {
  type CallLog,
  createFakeRunnerContext,
  fakeHandler,
  fakeItemRow,
  fakePlan
} from "./fixtures";

/** Bytes of the first image: the fake store hashes them to `hash-a`. */
const FIRST = new TextEncoder().encode("a");

/** The three images a fake group handler returns, each its own bytes. */
const GROUP = [
  { image: FIRST, mimeType: "image/jpeg" },
  { image: new TextEncoder().encode("b"), mimeType: "image/jpeg" },
  { image: new TextEncoder().encode("c"), mimeType: "image/png" }
];

/** The outputs journaled for {@link GROUP}: the fake store hashes `x` to `hash-x`. */
const GROUP_OUTPUTS: DoneOutput[] = [
  { contentHash: "hash-a", mimeType: "image/jpeg" },
  { contentHash: "hash-b", mimeType: "image/jpeg" },
  { contentHash: "hash-c", mimeType: "image/png" }
];

/**
 * A fake runner context whose handler returns `result`, whose store hashes
 * the bytes `x` to `hash-x`, and which records every `commitDone` result.
 *
 * @param log - Shared call log.
 * @param result - What the handler returns.
 * @returns The context and the recorded `commitDone` results.
 */
function groupContext(
  log: CallLog,
  result: HandlerResult
): { ctx: RunnerContext; committed: DoneResult[] } {
  const committed: DoneResult[] = [];
  const handler = fakeHandler(log, {
    execute: async () => {
      log.push("handler.execute");
      return result;
    }
  });
  const ctx = createFakeRunnerContext(log, {
    registry: { resolve: (): unknown => handler },
    journal: {
      commitDone: (itemId: string, done: DoneResult): void => {
        log.push(`journal.commitDone(${itemId})`);
        committed.push(done);
      }
    },
    store: {
      put: async (bytes: Uint8Array) => {
        const hash = `hash-${new TextDecoder().decode(bytes)}`;
        log.push(`store.put(${hash})`);
        return { hash, path: `/fake-store/${hash}`, existed: false };
      }
    }
  });
  return { ctx, committed };
}

/**
 * Runs one fresh item through `executeItem` and collects its stream records.
 *
 * @param ctx - The fake runner context.
 * @returns The reported records.
 */
async function runItem(ctx: RunnerContext): Promise<UnstampedRunEvent[]> {
  const events: UnstampedRunEvent[] = [];
  await executeItem(
    ctx,
    fakeItemRow({ artifactKey: "ak-1" }),
    fakePlan(3),
    createDrainController(undefined),
    event => events.push(event),
    Promise.resolve()
  );
  return events;
}

describe("executeItem — a handler that returns images", () => {
  it("stores every image in order, journals them as outputs and reports their hashes", async () => {
    const log: CallLog = [];
    const { ctx, committed } = groupContext(log, {
      image: FIRST,
      mimeType: "image/jpeg",
      images: GROUP,
      costUsd: 0.105
    });

    const events = await runItem(ctx);

    expect(log).toEqual([
      "limits.acquire",
      "journal.gateToDispatching(item-1)",
      "journal.recordAttempt(item-1)",
      "handler.execute",
      "journal.finishAttempt(done)",
      "limits.reportOutcome(ok)",
      "store.put(hash-a)",
      "store.put(hash-b)",
      "store.put(hash-c)",
      "journal.commitDone(item-1)",
      "limits.release"
    ]);
    expect(committed).toEqual([
      {
        actualCostUsd: 0.105,
        artifactKey: "ak-1",
        contentHash: "hash-a",
        mimeType: "image/jpeg",
        outputs: GROUP_OUTPUTS
      }
    ]);
    expect(events.at(-1)).toEqual({
      type: "item:done",
      itemId: "item-1",
      costUsd: 0.105,
      contentHash: "hash-a",
      contentHashes: ["hash-a", "hash-b", "hash-c"]
    });
  });

  it("journals a group of one as one output, so the caller sees the count", async () => {
    const log: CallLog = [];
    const { ctx, committed } = groupContext(log, {
      images: [{ image: FIRST, mimeType: "image/jpeg" }],
      costUsd: 0.035
    });

    const events = await runItem(ctx);

    expect(committed[0]?.outputs).toEqual([{ contentHash: "hash-a", mimeType: "image/jpeg" }]);
    expect(committed[0]).toMatchObject({ contentHash: "hash-a", mimeType: "image/jpeg" });
    expect(events.at(-1)).toMatchObject({ type: "item:done", contentHashes: ["hash-a"] });
  });

  it("keeps the single-artifact path when images is empty or absent", async () => {
    for (const result of [
      { image: FIRST, mimeType: "image/jpeg", costUsd: 0.035 },
      { image: FIRST, mimeType: "image/jpeg", images: [], costUsd: 0.035 }
    ]) {
      const log: CallLog = [];
      const { ctx, committed } = groupContext(log, result);

      const events = await runItem(ctx);

      expect(log.filter(entry => entry.startsWith("store.put"))).toEqual(["store.put(hash-a)"]);
      expect(committed).toEqual([
        { actualCostUsd: 0.035, artifactKey: "ak-1", contentHash: "hash-a", mimeType: "image/jpeg" }
      ]);
      expect(events.at(-1)).toEqual({
        type: "item:done",
        itemId: "item-1",
        costUsd: 0.035,
        contentHash: "hash-a"
      });
    }
  });
});

describe("tryReuse — a done artifact with outputs", () => {
  const GROUP_ARTIFACT: DoneArtifact = {
    contentHash: "hash-a",
    mimeType: "image/jpeg",
    outputs: GROUP_OUTPUTS
  };

  /**
   * A context whose journal finds {@link GROUP_ARTIFACT} and whose store
   * holds only the given hashes.
   *
   * @param log - Shared call log.
   * @param stored - Hashes the store has.
   * @returns The context and the artifacts passed to `reuseDone`.
   */
  function reuseContext(
    log: CallLog,
    stored: readonly string[]
  ): { ctx: RunnerContext; reused: DoneArtifact[] } {
    const reused: DoneArtifact[] = [];
    const ctx = createFakeRunnerContext(log, {
      journal: {
        findDoneArtifact: () => GROUP_ARTIFACT,
        reuseDone: (itemId: string, artifact: DoneArtifact): void => {
          log.push(`journal.reuseDone(${itemId})`);
          reused.push(artifact);
        }
      },
      store: { has: async (hash: string) => stored.includes(hash) }
    });
    return { ctx, reused };
  }

  it("reuses all outputs at cost 0 when the store has every one", async () => {
    const log: CallLog = [];
    const { ctx, reused } = reuseContext(log, ["hash-a", "hash-b", "hash-c"]);

    const events = await runItem(ctx);

    expect(log).toEqual(["journal.reuseDone(item-1)"]);
    expect(reused).toEqual([GROUP_ARTIFACT]);
    expect(events.at(-1)).toEqual({
      type: "item:done",
      itemId: "item-1",
      costUsd: 0,
      contentHash: "hash-a",
      contentHashes: ["hash-a", "hash-b", "hash-c"]
    });
  });

  it("builds again when one extra output left the store", async () => {
    const log: CallLog = [];
    const { ctx } = reuseContext(log, ["hash-a", "hash-c"]);

    const events = await runItem(ctx);

    expect(log).not.toContain("journal.reuseDone(item-1)");
    expect(log).toContain("handler.execute");
    expect(events.at(-1)).toMatchObject({ type: "item:done", costUsd: 0.1 });
  });
});
