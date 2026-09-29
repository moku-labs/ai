/**
 * @file journal core plugin — API factory: binds the domain functions of db, runs,
 * items, gate, attempts and snapshot to this plugin's state. Metadata only — no
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
import { gateToDispatching } from "./gate";
import {
  getItem,
  insertItems,
  listItemsOf,
  markFailed,
  markFlagged,
  requeueDispatching
} from "./items";
import { getRun, latestResumableRun, latestRun, openRun, setRunStatus, totalsOf } from "./runs";
import { checkpointNow, readRunSnapshot } from "./snapshot";
import type {
  AttemptEnd,
  AttemptStart,
  Config,
  DoneArtifact,
  ErrorClass,
  GateResult,
  ItemFilter,
  ItemIntent,
  ItemRow,
  JobState,
  JournalApi,
  RunRow,
  RunSnapshot,
  RunStatus,
  RunTotals,
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

  // Creates the single `runs` row for one invocation.
  const boundOpenRun = (opts: { glob: string; maxCostUsd?: number }): RunRow =>
    openRun(state, opts);

  // Looks up one run by id.
  const boundGetRun = (runId: string): RunRow | undefined => getRun(state, runId);

  // Finds the latest resumable run not in `exclude`.
  const boundLatestResumableRun = (opts?: { exclude?: readonly string[] }): RunRow | undefined =>
    latestResumableRun(state, opts);

  // Inserts planning-time item intents.
  const boundInsertItems = (runId: string, items: ItemIntent[]): ItemRow[] =>
    insertItems(state, runId, items);

  // Requeues every dispatching item of a run.
  const boundRequeueDispatching = (runId: string): number => requeueDispatching(state, runId);

  // The atomic budget + dedup gate.
  const boundGateToDispatching = (itemId: string): GateResult => gateToDispatching(state, itemId);

  // Records the start of a provider attempt.
  const boundRecordAttempt = (itemId: string, attempt: AttemptStart): number =>
    recordAttempt(state, itemId, attempt);

  // Records the end of a provider attempt.
  const boundFinishAttempt = (attemptId: number, end: AttemptEnd): void => {
    finishAttempt(state, attemptId, end);
  };

  // Transitions an item to done.
  const boundCommitDone = (
    itemId: string,
    result: { actualCostUsd: number; artifactKey: string; contentHash: string; mimeType?: string }
  ): void => {
    commitDone(state, itemId, result);
  };

  // Transitions an item to failed or back to queued.
  const boundMarkFailed = (
    itemId: string,
    result: { errorClass: ErrorClass; terminal: boolean }
  ): void => {
    markFailed(state, itemId, result);
  };

  // Transitions an item to flagged.
  const boundMarkFlagged = (itemId: string): void => {
    markFlagged(state, itemId);
  };

  // Sets a run's status.
  const boundSetRunStatus = (runId: string, status: RunStatus): void => {
    setRunStatus(state, runId, status);
  };

  // Computes aggregate item counts and spend.
  const boundTotals = (runId: string): RunTotals => totalsOf(state, runId);

  // Lists a run's items.
  const boundListItems = (runId: string, filter?: ItemFilter): ItemRow[] =>
    listItemsOf(state, runId, filter);

  // Reads a point-in-time run snapshot on its own short-lived connection.
  const boundReadSnapshot = (runId: string): RunSnapshot => readRunSnapshot(state, config, runId);

  // Runs a manual checkpoint.
  const boundCheckpoint = (): void => {
    checkpointNow(state);
  };

  return {
    openRun: boundOpenRun,
    getRun: boundGetRun,
    latestResumableRun: boundLatestResumableRun,
    insertItems: boundInsertItems,
    requeueDispatching: boundRequeueDispatching,
    gateToDispatching: boundGateToDispatching,
    recordAttempt: boundRecordAttempt,
    finishAttempt: boundFinishAttempt,
    commitDone: boundCommitDone,
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
    markFailed: boundMarkFailed,
    markFlagged: boundMarkFlagged,
    setRunStatus: boundSetRunStatus,
    totals: boundTotals,
    listItems: boundListItems,
    readSnapshot: boundReadSnapshot,
    checkpoint: boundCheckpoint
  };
}
