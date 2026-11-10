/**
 * @file journal core plugin — database access shared by every domain file: the open-driver
 * guard, the `null` bind sentinel, the raw-row to public-row mappers, and the `outputs` column
 * codec.
 */
import type { ItemDatabaseRow, RunDatabaseRow, SqliteDriver } from "./driver/types";
import type { DoneOutput, ItemRow, RunRow, State } from "./types";

/** Error text thrown when a journal call runs before `app.start()` opened the driver. */
export const NOT_OPEN_ERROR =
  "[ai] Journal is not open.\n  Call app.start() before using the journal.";

/**
 * Reusable `null` sentinel. TS's `X | null` row fields (matching SQL's
 * NULL) and SQLite bind parameters both need a literal `null` — never
 * `undefined`, since better-sqlite3/bun:sqlite throw on an `undefined`
 * bind parameter. Centralizing the literal here keeps the `no-null` lint
 * exception to this one line instead of one per call site.
 */
// eslint-disable-next-line unicorn/no-null -- see comment above; the single source of the null literal for this file
export const SQL_NULL = null;

/**
 * Whether one entry of a parsed `outputs` array is well formed.
 *
 * @param value - One parsed entry.
 * @returns True for `{ contentHash: string, mimeType: string, name?: string }`.
 * @example
 * ```ts
 * isDoneOutput({ contentHash: "ch-1", mimeType: "image/png" }); // => true
 * isDoneOutput({ contentHash: "ch-1", mimeType: "audio/mpeg", name: 5 }); // => false
 * ```
 */
function isDoneOutput(value: unknown): value is DoneOutput {
  if (typeof value !== "object" || value === null) return false;

  const hasHash = "contentHash" in value && typeof value.contentHash === "string";
  const hasMimeType = "mimeType" in value && typeof value.mimeType === "string";
  const hasValidName =
    !("name" in value) || value.name === undefined || typeof value.name === "string";
  return hasHash && hasMimeType && hasValidName;
}

/**
 * Parses JSON column text, or gives undefined when it is not JSON.
 *
 * @param text - The raw column text.
 * @returns The parsed value, still untrusted, or undefined.
 * @example
 * ```ts
 * parseJsonColumn("[{"); // => undefined
 * ```
 */
function parseJsonColumn(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads the `outputs` column: a non-empty JSON array of `{ contentHash, mimeType, name? }`.
 * Anything else maps to null: NULL, missing (a reader on an un-migrated file),
 * unparsable, not an array, empty, or with a malformed entry. An older or damaged
 * row so stays a single-artifact item.
 *
 * @param text - The raw column value.
 * @returns The outputs in order, or null.
 * @example
 * ```ts
 * parseOutputs('[{"contentHash":"ch-1","mimeType":"image/png"}]'); // => [{ contentHash: "ch-1", mimeType: "image/png" }]
 * parseOutputs("[{"); // => null
 * ```
 */
export function parseOutputs(text: string | null | undefined): DoneOutput[] | null {
  if (typeof text !== "string") return SQL_NULL;

  const parsed = parseJsonColumn(text);
  if (!Array.isArray(parsed) || parsed.length === 0) return SQL_NULL;

  return parsed.every(entry => isDoneOutput(entry)) ? parsed : SQL_NULL;
}

/**
 * The `outputs` column value to write: JSON of hashes, mime types and the
 * names of named outputs, or NULL when there are no outputs. An unnamed
 * output gets no `name` key, so a journal without names keeps its old text.
 *
 * @param outputs - Every output of a multi-output item, or undefined.
 * @returns JSON text, or null.
 * @example
 * ```ts
 * outputsColumn(undefined); // => null
 * outputsColumn([{ contentHash: "ch-1", mimeType: "image/png" }]); // => '[{"contentHash":"ch-1","mimeType":"image/png"}]'
 * outputsColumn([{ contentHash: "ch-2", mimeType: "audio/mpeg", name: "l1" }]); // => '[{"contentHash":"ch-2","mimeType":"audio/mpeg","name":"l1"}]'
 * ```
 */
export function outputsColumn(outputs: readonly DoneOutput[] | undefined): string | null {
  if (outputs === undefined || outputs.length === 0) return SQL_NULL;

  // Only the metadata fields: never a payload, whatever else the caller's objects carry.
  return JSON.stringify(
    outputs.map(({ contentHash, mimeType, name }) => ({
      contentHash,
      mimeType,
      ...(name === undefined ? {} : { name })
    }))
  );
}

/**
 * Maps a raw `items` row to the public, camelCase `ItemRow` shape.
 *
 * @param row - Raw database row.
 * @returns The public item representation.
 */
export function mapItem(row: ItemDatabaseRow): ItemRow {
  return {
    id: row.id,
    runId: row.run_id,
    buildFile: row.build_file,
    planningKey: row.planning_key,
    task: row.task,
    provider: row.provider,
    packVersion: row.pack_version,
    artifactKey: row.artifact_key,
    contentHash: row.content_hash,
    status: row.status,
    estimatedCostUsd: row.estimated_cost_usd,
    actualCostUsd: row.actual_cost_usd,
    attemptCount: row.attempt_count,
    updatedAt: row.updated_at,
    label: row.label,
    buildName: row.build_name,
    mimeType: row.mime_type,
    outputs: parseOutputs(row.outputs)
  };
}

/**
 * Maps a raw `runs` row to the public, camelCase `RunRow` shape.
 *
 * @param row - Raw database row.
 * @returns The public run representation.
 */
export function mapRun(row: RunDatabaseRow): RunRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    status: row.status,
    glob: row.glob,
    maxCostUsd: row.max_cost_usd,
    finishedAt: row.finished_at
  };
}

/**
 * Returns the open driver, or throws the documented not-open error.
 *
 * @param state - Journal plugin state.
 * @returns The open SqliteDriver.
 * @throws {Error} When `onStart` has not run yet (driver is null).
 */
export function requireDriver(state: State): SqliteDriver {
  if (!state.driver) {
    throw new Error(NOT_OPEN_ERROR);
  }
  return state.driver;
}

/**
 * Tells whether the journal connection is open: true between `onStart` and
 * `onStop`. The only journal call that never throws.
 *
 * @param state - Journal plugin state.
 * @returns True when the driver is open.
 */
export function isOpen(state: State): boolean {
  return state.driver !== null;
}
