/**
 * @file journal unit test fixtures — a temp-dir journal (real driver + schema), item intents,
 * and small setup helpers shared by the per-domain test files. NOT a test file itself (no
 * `.test.ts` suffix), so vitest does not collect it as a suite.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { recordAttempt, setAttemptJob } from "../../attempts";
import { openSqliteDriver } from "../../driver/select";
import type { SqliteDriver } from "../../driver/types";
import { insertItems } from "../../items";
import { openRun } from "../../runs";
import { createSchema } from "../../schema";
import type { Config, ItemIntent, JobState, State } from "../../types";

/** A journal on a fresh temp-dir database, open with the full schema. */
export type TestJournal = {
  /** Temp directory holding the database file. */
  dir: string;
  /** Journal config pointing at the temp database. */
  config: Config;
  /** The open primary connection. */
  driver: SqliteDriver;
  /** Journal state holding the open driver (no checkpoint timer). */
  state: State;
};

/**
 * Opens a journal on a fresh temp-dir database with the schema created.
 *
 * @returns The open test journal; pass it to `closeTestJournal` after the test.
 */
export function openTestJournal(): TestJournal {
  const dir = mkdtempSync(path.join(tmpdir(), "journal-unit-"));
  const config: Config = {
    path: path.join(dir, "journal.db"),
    checkpointIntervalMs: 30_000,
    busyTimeoutMs: 5000
  };
  const driver = openSqliteDriver({ path: config.path, busyTimeoutMs: config.busyTimeoutMs });
  createSchema(driver);
  // eslint-disable-next-line unicorn/no-null -- State.checkpointTimer is typed `... | null` (not running yet)
  const state: State = { driver, checkpointTimer: null };
  return { dir, config, driver, state };
}

/**
 * Closes the test journal's connection and removes its temp directory.
 *
 * @param journal - The journal from `openTestJournal`.
 */
export function closeTestJournal(journal: TestJournal): void {
  journal.driver.close();
  rmSync(journal.dir, { recursive: true, force: true });
}

/**
 * Journal state with no open driver, as before `app.start()`.
 *
 * @returns A not-open journal state.
 */
export function closedState(): State {
  // eslint-disable-next-line unicorn/no-null -- State fields are typed `X | null` (not opened yet)
  return { driver: null, checkpointTimer: null };
}

/**
 * Builds a planning-time item intent with test defaults.
 *
 * @param planningKey - The item's planning key; also its label and artifact-key suffix.
 * @param overrides - Fields to replace.
 * @returns The item intent.
 */
export function intent(planningKey: string, overrides: Partial<ItemIntent> = {}): ItemIntent {
  return {
    planningKey,
    buildFile: "voice.build.yaml",
    task: "voiceover",
    provider: "elevenlabs",
    // eslint-disable-next-line unicorn/no-null -- ItemIntent.packVersion is typed `string | null`, matching the nullable SQL column
    packVersion: null,
    estimatedCostUsd: 0.1,
    label: planningKey,
    buildName: "voice",
    artifactKey: `ak-${planningKey}`,
    ...overrides
  };
}

/**
 * Narrows a possibly-undefined test fixture value, failing fast if absent.
 *
 * @param value - The value to narrow.
 * @returns The value, now known to be defined.
 */
export function mustExist<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}

/**
 * Opens a run, inserts one intent and returns the new item's id.
 *
 * @param state - Open journal state.
 * @param overrides - Intent fields to replace.
 * @param maxCostUsd - Optional run budget cap.
 * @returns The run id and the queued item's id.
 */
export function queuedItem(
  state: State,
  overrides: Partial<ItemIntent> = {},
  maxCostUsd?: number
): { runId: string; itemId: string } {
  const run =
    maxCostUsd === undefined
      ? openRun(state, { glob: "*.yaml" })
      : openRun(state, { glob: "*.yaml", maxCostUsd });
  const [item] = insertItems(state, run.id, [intent("pk-1", overrides)]);
  return { runId: run.id, itemId: mustExist(item).id };
}

/**
 * Records one attempt on a fresh `pk-1` item and sets its job.
 *
 * @param state - Open journal state.
 * @param externalId - Provider job id.
 * @param jobState - The job's state.
 * @returns The attempt id.
 */
export function jobAttempt(state: State, externalId: string, jobState: JobState): number {
  const { itemId } = queuedItem(state);
  const attemptId = recordAttempt(state, itemId, {
    provider: "elevenlabs",
    account: "default",
    startedAt: 1
  });
  setAttemptJob(state, attemptId, { externalId, jobState });
  return attemptId;
}

/**
 * Opens a run with a pinned `created_at`, so newest-first order is deterministic.
 *
 * @param state - Open journal state.
 * @param createdAt - The run's creation time, ms epoch.
 * @param glob - The run's file pattern.
 * @returns The run id.
 */
export function openRunAt(state: State, createdAt: number, glob: string): string {
  const clock = vi.spyOn(Date, "now").mockReturnValue(createdAt);
  const run = openRun(state, { glob });
  clock.mockRestore();
  return run.id;
}
