import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJournalApi } from "../../api";
import * as attempts from "../../attempts";
import * as db from "../../db";
import * as gate from "../../gate";
import * as items from "../../items";
import * as providerRecords from "../../provider-records";
import * as runs from "../../runs";
import * as snapshot from "../../snapshot";
import type { Config, JournalApi } from "../../types";
import { closedState, intent } from "./fixtures";

/**
 * Replaces every function export with a spy that still runs the real implementation, so the
 * facade can be checked for delegation while the not-open guard stays real. A function
 * declaration, so the hoisted `vi.mock` factories below can call it.
 */
function spyOnExports<T extends object>(module: T): T {
  return Object.fromEntries(
    Object.entries(module).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value
    ])
  ) as T;
}

vi.mock("../../attempts", async importOriginal =>
  spyOnExports(await importOriginal<typeof attempts>())
);
vi.mock("../../db", async importOriginal => spyOnExports(await importOriginal<typeof db>()));
vi.mock("../../provider-records", async importOriginal =>
  spyOnExports(await importOriginal<typeof providerRecords>())
);
vi.mock("../../gate", async importOriginal => spyOnExports(await importOriginal<typeof gate>()));
vi.mock("../../items", async importOriginal => spyOnExports(await importOriginal<typeof items>()));
vi.mock("../../runs", async importOriginal => spyOnExports(await importOriginal<typeof runs>()));
vi.mock("../../snapshot", async importOriginal =>
  spyOnExports(await importOriginal<typeof snapshot>())
);

/** One api member, how to call it, and the domain call it must make. */
type DelegationCase = {
  member: keyof JournalApi;
  call: (api: JournalApi) => unknown;
  domain: (...args: never[]) => unknown;
  args: readonly unknown[];
  returnsResult: boolean;
};

const NOT_OPEN = "[ai] Journal is not open.\n  Call app.start() before using the journal.";
const sentinel = { sentinel: true };
const config: Config = {
  path: "/unused/journal.db",
  checkpointIntervalMs: 30_000,
  busyTimeoutMs: 5000
};
const state = closedState();
const api = createJournalApi({ config, state });
const attemptStart = { provider: "elevenlabs", account: "default", startedAt: 1 };
const attemptEnd = { endedAt: 2, outcome: "done", costUsd: 0.05 } as const;
const doneResult = { actualCostUsd: 0.2, artifactKey: "ak-1", contentHash: "ch-1" };
const artifact = { contentHash: "ch-1", mimeType: "audio/mpeg" };
const failure = { errorClass: "http-5xx", terminal: false } as const;
const recordQuery = { provider: "apimodels", account: "acct-1", kind: "asset", key: "hash-1" };
const record = { ...recordQuery, value: "asset://asset-1" };

const cases: DelegationCase[] = [
  {
    member: "openRun",
    call: a => a.openRun({ glob: "*.yaml" }),
    domain: runs.openRun,
    args: [state, { glob: "*.yaml" }],
    returnsResult: true
  },
  {
    member: "getRun",
    call: a => a.getRun("run-1"),
    domain: runs.getRun,
    args: [state, "run-1"],
    returnsResult: true
  },
  {
    member: "latestResumableRun",
    call: a => a.latestResumableRun({ exclude: ["run-1"] }),
    domain: runs.latestResumableRun,
    args: [state, { exclude: ["run-1"] }],
    returnsResult: true
  },
  {
    member: "insertItems",
    call: a => a.insertItems("run-1", [intent("pk-1")]),
    domain: items.insertItems,
    args: [state, "run-1", [intent("pk-1")]],
    returnsResult: true
  },
  {
    member: "requeueDispatching",
    call: a => a.requeueDispatching("run-1"),
    domain: items.requeueDispatching,
    args: [state, "run-1"],
    returnsResult: true
  },
  {
    member: "gateToDispatching",
    call: a => a.gateToDispatching("item-1"),
    domain: gate.gateToDispatching,
    args: [state, "item-1"],
    returnsResult: true
  },
  {
    member: "recordAttempt",
    call: a => a.recordAttempt("item-1", attemptStart),
    domain: attempts.recordAttempt,
    args: [state, "item-1", attemptStart],
    returnsResult: true
  },
  {
    member: "finishAttempt",
    call: a => a.finishAttempt(7, attemptEnd),
    domain: attempts.finishAttempt,
    args: [state, 7, attemptEnd],
    returnsResult: false
  },
  {
    member: "commitDone",
    call: a => a.commitDone("item-1", doneResult),
    domain: attempts.commitDone,
    args: [state, "item-1", doneResult],
    returnsResult: false
  },
  {
    member: "findDoneArtifact",
    call: a => a.findDoneArtifact("ak-1"),
    domain: attempts.findDoneArtifact,
    args: [state, "ak-1"],
    returnsResult: true
  },
  {
    member: "reuseDone",
    call: a => a.reuseDone("item-1", artifact),
    domain: attempts.reuseDone,
    args: [state, "item-1", artifact],
    returnsResult: false
  },
  {
    member: "setAttemptJob",
    call: a => a.setAttemptJob(7, { externalId: "req-1", jobState: "submitted" }),
    domain: attempts.setAttemptJob,
    args: [state, 7, { externalId: "req-1", jobState: "submitted" }],
    returnsResult: false
  },
  {
    member: "findLiveJob",
    call: a => a.findLiveJob("ak-1"),
    domain: attempts.findLiveJob,
    args: [state, "ak-1"],
    returnsResult: true
  },
  {
    member: "latestRun",
    call: a => a.latestRun(),
    domain: runs.latestRun,
    args: [state],
    returnsResult: true
  },
  {
    member: "getItem",
    call: a => a.getItem("run-1", "pk-1"),
    domain: items.getItem,
    args: [state, "run-1", "pk-1"],
    returnsResult: true
  },
  {
    member: "markFailed",
    call: a => a.markFailed("item-1", failure),
    domain: items.markFailed,
    args: [state, "item-1", failure],
    returnsResult: false
  },
  {
    member: "markFlagged",
    call: a => a.markFlagged("item-1"),
    domain: items.markFlagged,
    args: [state, "item-1"],
    returnsResult: false
  },
  {
    member: "setRunStatus",
    call: a => a.setRunStatus("run-1", "paused"),
    domain: runs.setRunStatus,
    args: [state, "run-1", "paused"],
    returnsResult: false
  },
  {
    member: "totals",
    call: a => a.totals("run-1"),
    domain: runs.totalsOf,
    args: [state, "run-1"],
    returnsResult: true
  },
  {
    member: "listItems",
    call: a => a.listItems("run-1", { status: "queued" }),
    domain: items.listItemsOf,
    args: [state, "run-1", { status: "queued" }],
    returnsResult: true
  },
  {
    member: "readSnapshot",
    call: a => a.readSnapshot("run-1"),
    domain: snapshot.readRunSnapshot,
    args: [state, config, "run-1"],
    returnsResult: true
  },
  {
    member: "findProviderRecord",
    call: a => a.findProviderRecord(recordQuery),
    domain: providerRecords.findProviderRecord,
    args: [state, recordQuery],
    returnsResult: true
  },
  {
    member: "putProviderRecords",
    call: a => a.putProviderRecords([record]),
    domain: providerRecords.putProviderRecords,
    args: [state, [record]],
    returnsResult: false
  },
  {
    member: "deleteProviderRecord",
    call: a => a.deleteProviderRecord(recordQuery),
    domain: providerRecords.deleteProviderRecord,
    args: [state, recordQuery],
    returnsResult: false
  }
];

/** Members that are not guarded: `isOpen` is the one call that never throws on a closed journal. */
const UNGUARDED_MEMBERS = ["isOpen"];

describe("journal api facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("not-open guard", () => {
    it("throws the documented error message when the driver is null", () => {
      expect(() => api.openRun({ glob: "*.yaml" })).toThrow(NOT_OPEN);
    });

    it("guards every member before the journal is started", () => {
      for (const { member, call } of cases) {
        expect(() => call(api), member).toThrow(NOT_OPEN);
      }
    });
  });

  describe("wiring", () => {
    it("exposes exactly the JournalApi members", () => {
      const members = [...cases.map(({ member }) => member), ...UNGUARDED_MEMBERS];
      expect(Object.keys(api).toSorted()).toEqual(members.toSorted());
    });

    it("isOpen delegates to db.isOpen and reports a closed journal without throwing", () => {
      expect(api.isOpen()).toBe(false);
      expect(vi.mocked(db.isOpen)).toHaveBeenCalledWith(state);
    });

    it.each(cases)("$member delegates to its domain function with the plugin state", ({
      call,
      domain,
      args,
      returnsResult
    }) => {
      const spy = vi.mocked(domain);
      spy.mockReturnValueOnce(sentinel);

      const result = call(api);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(...args);
      expect(result).toBe(returnsResult ? sentinel : undefined);
    });
  });
});
