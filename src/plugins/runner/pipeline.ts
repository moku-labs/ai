/**
 * @file runner pipeline — per-item execution skeleton (gate → execute → store → commit).
 */
import type { ItemRow } from "../journal/types";

/**
 * Executes one queued item through the durable pipeline:
 * gate(budget+dedup) → limits.acquire → handler.execute → store.put → commitDone.
 *
 * @param _ctx - Plugin context (journal/store/limits/registry access).
 * @param _item - The queued item row to execute.
 * @example
 * ```ts
 * await executeItem(ctx, item);
 * ```
 */
export function executeItem(_ctx: unknown, _item: ItemRow): Promise<void> {
  throw new Error("not implemented");
}
