/**
 * @file journal core plugin — API factory: binds the domain functions of db, runs,
 * items, gate, attempts, snapshot and provider-records to this plugin's state. Metadata only — no
 * free-form payload columns anywhere in the journal.
 */
import type { CorePluginContext } from "@moku-labs/core";
import {
  commitDone,
  findDoneArtifact,
  findLiveJob,
  finishAttempt,
  recordAttempt,
  reuseDone,
  setAttemptJob
} from "./attempts";
import { isOpen } from "./db";
import { gateToDispatching } from "./gate";
import {
  getItem,
  insertItems,
  listItemsOf,
  markFailed,
  markFlagged,
  requeueDispatching
} from "./items";
import { deleteProviderRecord, findProviderRecord, putProviderRecords } from "./provider-records";
import { getRun, latestResumableRun, latestRun, openRun, setRunStatus, totalsOf } from "./runs";
import { readRunSnapshot } from "./snapshot";
import type {
  AttemptEnd,
  AttemptStart,
  Config,
  DoneArtifact,
  ErrorClass,
  ItemFilter,
  ItemIntent,
  JobState,
  JournalApi,
  ProviderRecord,
  ProviderRecordQuery,
  RunStatus,
  State
} from "./types";

/**
 * Creates the journal API surface (ctx.journal.*).
 *
 * @param ctx - Core plugin context (config + state).
 * @returns The journal's public API, injected as `ctx.journal` on every
 *   regular plugin's context.
 */
export function createJournalApi(ctx: CorePluginContext<Config, State>): JournalApi {
  const { config, state } = ctx;

  return {
    // Creates the single `runs` row for one invocation.
    openRun: (opts: { glob: string; maxCostUsd?: number }) => openRun(state, opts),
    // Looks up one run by id.
    getRun: (runId: string) => getRun(state, runId),
    // Finds the latest resumable run not in `exclude`.
    latestResumableRun: (opts?: { exclude?: readonly string[] }) => latestResumableRun(state, opts),
    // Inserts planning-time item intents.
    insertItems: (runId: string, items: ItemIntent[]) => insertItems(state, runId, items),
    // Requeues every dispatching item of a run.
    requeueDispatching: (runId: string) => requeueDispatching(state, runId),
    // The atomic budget + dedup gate.
    gateToDispatching: (itemId: string) => gateToDispatching(state, itemId),
    // Records the start of a provider attempt.
    recordAttempt: (itemId: string, attempt: AttemptStart) => recordAttempt(state, itemId, attempt),
    // Records the end of a provider attempt.
    finishAttempt: (attemptId: number, end: AttemptEnd) => {
      finishAttempt(state, attemptId, end);
    },
    // Transitions an item to done.
    commitDone: (
      itemId: string,
      result: { actualCostUsd: number; artifactKey: string; contentHash: string; mimeType?: string }
    ) => {
      commitDone(state, itemId, result);
    },
    // Finds a reusable done artifact by key, in any run.
    findDoneArtifact: (artifactKey: string) => findDoneArtifact(state, artifactKey),
    // Completes a queued item with a reused artifact.
    reuseDone: (itemId: string, artifact: DoneArtifact) => {
      reuseDone(state, itemId, artifact);
    },
    // Records a provider job on an attempt.
    setAttemptJob: (attemptId: number, job: { externalId?: string; jobState: JobState }) => {
      setAttemptJob(state, attemptId, job);
    },
    // Finds a live provider job for an artifact key.
    findLiveJob: (artifactKey: string) => findLiveJob(state, artifactKey),
    // Finds the newest run of any status.
    latestRun: () => latestRun(state),
    // Looks up one item by run and planning key.
    getItem: (runId: string, planningKey: string) => getItem(state, runId, planningKey),
    // Transitions an item to failed or back to queued.
    markFailed: (itemId: string, result: { errorClass: ErrorClass; terminal: boolean }) => {
      markFailed(state, itemId, result);
    },
    // Transitions an item to flagged.
    markFlagged: (itemId: string) => {
      markFlagged(state, itemId);
    },
    // Sets a run's status.
    setRunStatus: (runId: string, status: RunStatus) => {
      setRunStatus(state, runId, status);
    },
    // Computes aggregate item counts and spend.
    totals: (runId: string) => totalsOf(state, runId),
    // Lists a run's items.
    listItems: (runId: string, filter?: ItemFilter) => listItemsOf(state, runId, filter),
    // Reads a point-in-time run snapshot on its own short-lived connection.
    readSnapshot: (runId: string) => readRunSnapshot(state, config, runId),
    // Tells whether the journal connection is open; never throws.
    isOpen: () => isOpen(state),
    // Reads one provider record's value.
    findProviderRecord: (query: ProviderRecordQuery) => findProviderRecord(state, query),
    // Upserts provider records in one transaction.
    putProviderRecords: (records: ProviderRecord[]) => {
      putProviderRecords(state, records);
    },
    // Deletes one provider record; missing is a no-op.
    deleteProviderRecord: (query: ProviderRecordQuery) => {
      deleteProviderRecord(state, query);
    }
  };
}
