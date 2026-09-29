/**
 * @file journal core plugin — `provider_records` rows: opaque provider ids keyed by
 * provider, account, kind and key (for example an uploaded asset id by content hash).
 */
import { requireDriver } from "./db";
import type { ProviderRecord, ProviderRecordQuery, State } from "./types";

/** Upsert of one `provider_records` row: the same identity replaces value and created_at. */
const UPSERT_PROVIDER_RECORD_SQL = `INSERT INTO provider_records (provider, account, kind, key, value, created_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (provider, account, kind, key)
   DO UPDATE SET value = excluded.value, created_at = excluded.created_at`;

/** WHERE clause that matches one `provider_records` row by its primary key. */
const PROVIDER_RECORD_WHERE = "provider = ? AND account = ? AND kind = ? AND key = ?";

/**
 * Reads the value of one provider record.
 *
 * @param state - Journal plugin state.
 * @param query - The record's identity: provider, account, kind and key.
 * @returns The stored value, or undefined when no record matches.
 */
export function findProviderRecord(state: State, query: ProviderRecordQuery): string | undefined {
  const driver = requireDriver(state);
  const row = driver.get<{ value: string }>(
    `SELECT value FROM provider_records WHERE ${PROVIDER_RECORD_WHERE}`,
    [query.provider, query.account, query.kind, query.key]
  );
  return row?.value;
}

/**
 * Upserts provider records in one `BEGIN IMMEDIATE` transaction: one fsync for
 * the whole batch, and a failing row rolls back every row of it. An empty
 * batch opens no transaction.
 *
 * @param state - Journal plugin state.
 * @param records - Records to insert or replace.
 */
export function putProviderRecords(state: State, records: readonly ProviderRecord[]): void {
  const driver = requireDriver(state);
  if (records.length === 0) return;

  driver.transactionImmediate<void>(() => {
    const now = Date.now();
    for (const record of records) {
      driver.run(UPSERT_PROVIDER_RECORD_SQL, [
        record.provider,
        record.account,
        record.kind,
        record.key,
        record.value,
        now
      ]);
    }
  });
}

/**
 * Deletes one provider record inside a `BEGIN IMMEDIATE` transaction. A
 * missing record is a no-op.
 *
 * @param state - Journal plugin state.
 * @param query - The record's identity: provider, account, kind and key.
 */
export function deleteProviderRecord(state: State, query: ProviderRecordQuery): void {
  const driver = requireDriver(state);
  driver.transactionImmediate<void>(() => {
    driver.run(`DELETE FROM provider_records WHERE ${PROVIDER_RECORD_WHERE}`, [
      query.provider,
      query.account,
      query.kind,
      query.key
    ]);
  });
}
