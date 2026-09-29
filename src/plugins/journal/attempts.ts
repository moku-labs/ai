/**
 * @file journal core plugin — `attempts` rows and artifact reuse: attempt start/end, the done
 * transition, done-artifact dedup and live provider jobs.
 */
import { requireDriver, SQL_NULL } from "./db";
import type { AttemptEnd, AttemptStart, DoneArtifact, JobState, LiveJob, State } from "./types";

/** A provider job that expired this many times is stuck: `findLiveJob` stops returning it. */
export const MAX_JOB_EXPIRIES = 2;

/**
 * Records the start of a provider attempt against an item.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id the attempt belongs to.
 * @param attempt - Provider, account, and start time.
 * @returns The new attempt's id.
 */
export function recordAttempt(state: State, itemId: string, attempt: AttemptStart): number {
  const driver = requireDriver(state);
  return driver.transactionImmediate<number>(() => {
    driver.run(
      "INSERT INTO attempts (item_id, provider, account, started_at) VALUES (?, ?, ?, ?)",
      [itemId, attempt.provider, attempt.account, attempt.startedAt]
    );
    const row = driver.get<{ id: number }>("SELECT last_insert_rowid() AS id");
    return row?.id ?? 0;
  });
}

/**
 * Records the end of a provider attempt.
 *
 * @param state - Journal plugin state.
 * @param attemptId - Attempt id, from `recordAttempt`.
 * @param end - End time, outcome, and optional error class / cost.
 */
export function finishAttempt(state: State, attemptId: number, end: AttemptEnd): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE attempts SET ended_at = ?, outcome = ?, error_class = ?, cost_usd = ? WHERE id = ?",
      [end.endedAt, end.outcome, end.errorClass ?? SQL_NULL, end.costUsd ?? SQL_NULL, attemptId]
    );
  });
}

/**
 * Transitions an item `dispatching → done`, recording its actual cost and
 * artifact identity.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id to complete.
 * @param result - Actual cost, artifact key, and content hash.
 * @param result.actualCostUsd - The item's actual, realized cost.
 * @param result.artifactKey - Artifact identity key (planning key + provider + pack version).
 * @param result.contentHash - CAS content hash of the produced artifact.
 * @param result.mimeType - MIME type of the produced artifact, when known.
 */
export function commitDone(
  state: State,
  itemId: string,
  result: { actualCostUsd: number; artifactKey: string; contentHash: string; mimeType?: string }
): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE items SET status = 'done', actual_cost_usd = ?, artifact_key = ?, content_hash = ?, mime_type = ?, updated_at = ? WHERE id = ? AND status = 'dispatching'",
      [
        result.actualCostUsd,
        result.artifactKey,
        result.contentHash,
        result.mimeType ?? SQL_NULL,
        Date.now(),
        itemId
      ]
    );
  });
}

/**
 * Finds the newest `done` item with this artifact key, in any run — the
 * cross-run reuse lookup (a re-run never re-bills a finished artifact).
 *
 * @param state - Journal plugin state.
 * @param artifactKey - Artifact identity key.
 * @returns The artifact's content hash and mime type, or undefined.
 */
export function findDoneArtifact(state: State, artifactKey: string): DoneArtifact | undefined {
  const driver = requireDriver(state);
  const row = driver.get<{ content_hash: string | null; mime_type: string | null }>(
    "SELECT content_hash, mime_type FROM items WHERE artifact_key = ? AND status = 'done' AND content_hash IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    [artifactKey]
  );
  if (!row || row.content_hash === null) return undefined;
  return { contentHash: row.content_hash, mimeType: row.mime_type };
}

/**
 * Transitions a `queued` item straight to `done` with an artifact produced
 * by an earlier item (cost 0). A no-op when the item is not `queued`.
 *
 * @param state - Journal plugin state.
 * @param itemId - Item id to complete.
 * @param artifact - The reused artifact's content hash and mime type.
 */
export function reuseDone(state: State, itemId: string, artifact: DoneArtifact): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE items SET status = 'done', actual_cost_usd = 0, content_hash = ?, mime_type = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      [artifact.contentHash, artifact.mimeType, Date.now(), itemId]
    );
  });
}

/**
 * Records a provider job id and/or its state on an attempt row.
 *
 * @param state - Journal plugin state.
 * @param attemptId - Attempt id, from `recordAttempt`.
 * @param job - The provider job id (when known) and the job state.
 * @param job.externalId - Provider job id; omit to keep the stored one.
 * @param job.jobState - The job's lifecycle state.
 */
export function setAttemptJob(
  state: State,
  attemptId: number,
  job: { externalId?: string; jobState: JobState }
): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(
      "UPDATE attempts SET external_id = COALESCE(?, external_id), job_state = ? WHERE id = ?",
      [job.externalId ?? SQL_NULL, job.jobState, attemptId]
    );
  });
}

/**
 * Finds the newest adoptable provider job for any item with this artifact
 * key, in any run — the job a new attempt adopts instead of re-submitting.
 * Adoptable: `submitted`, or `expired` (a runner stopped waiting, the provider
 * may still finish it), with no later row of the same job marked `failed` or
 * `done`. A job that expired twice counts as stuck and is not returned, so
 * the next attempt submits.
 *
 * @param state - Journal plugin state.
 * @param artifactKey - Artifact identity key.
 * @returns The live job, or undefined.
 */
export function findLiveJob(state: State, artifactKey: string): LiveJob | undefined {
  const driver = requireDriver(state);
  const row = driver.get<{ external_id: string; job_state: LiveJob["jobState"]; id: number }>(
    `SELECT a.external_id AS external_id, a.job_state AS job_state, a.id AS id
     FROM attempts a JOIN items i ON i.id = a.item_id
     WHERE i.artifact_key = ? AND a.external_id IS NOT NULL
       AND a.job_state IN ('submitted', 'expired')
       AND NOT EXISTS (
         SELECT 1 FROM attempts b
         WHERE b.external_id = a.external_id AND b.id > a.id AND b.job_state IN ('failed', 'done'))
       AND (SELECT COUNT(*) FROM attempts c
            WHERE c.external_id = a.external_id AND c.job_state = 'expired') < ?
     ORDER BY a.id DESC LIMIT 1`,
    [artifactKey, MAX_JOB_EXPIRIES]
  );
  return row
    ? { externalId: row.external_id, jobState: row.job_state, attemptId: row.id }
    : undefined;
}
