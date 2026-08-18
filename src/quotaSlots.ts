import { QuotaExceededError, UnknownAccountError } from "./errors.js";
import type { SqlExecutor } from "./executor.js";
import { quoteIdentifier } from "./identifiers.js";

export type TakeResult = "granted" | "exhausted" | "unknown-account";

/** Where the counter lives. One row per account, one integer column. */
export interface QuotaTable {
  table: string;
  key: string;
  counter: string;
}

export interface QuotaSlotsOptions {
  execute: SqlExecutor;
  table: QuotaTable;
  /** Called when a release fails, so it can't replace the error that caused it. */
  onReleaseError?: (error: unknown, key: string) => void;
}

export interface QuotaSlots {
  take(key: string, limit: number): Promise<TakeResult>;
  /** Only for work that never happened. Work that ran and failed keeps its unit. */
  release(key: string): Promise<void>;
  /** Units taken so far, or null when the row doesn't exist. */
  usage(key: string): Promise<number | null>;
  withSlot<T>(key: string, limit: number, work: () => Promise<T>): Promise<T>;
}

export function createQuotaSlots(options: QuotaSlotsOptions): QuotaSlots {
  const { execute, table, onReleaseError } = options;

  const tableName = quoteIdentifier(table.table, "table");
  const keyColumn = quoteIdentifier(table.key, "key column");
  const counterColumn = quoteIdentifier(table.counter, "counter column");

  // The whole idea. The limit check travels with the write, so Postgres locks
  // the row and re-evaluates WHERE against the committed value. Callers that
  // lose the race match nothing and get rowCount 0.
  const takeSql =
    `UPDATE ${tableName} SET ${counterColumn} = ${counterColumn} + 1 ` +
    `WHERE ${keyColumn} = $1 AND ${counterColumn} < $2`;

  // `> 0` in case the window was reset between the take and the release.
  const releaseSql =
    `UPDATE ${tableName} SET ${counterColumn} = ${counterColumn} - 1 ` +
    `WHERE ${keyColumn} = $1 AND ${counterColumn} > 0`;

  const usageSql = `SELECT ${counterColumn} AS used FROM ${tableName} WHERE ${keyColumn} = $1`;

  async function take(key: string, limit: number): Promise<TakeResult> {
    assertLimit(limit);
    const { rowCount } = await execute(takeSql, [key, limit]);
    if (rowCount === 1) {
      return "granted";
    }

    // Refusals only: one extra query to say which refusal it was. The granted
    // path stays a single round-trip.
    const used = await usage(key);
    return used === null ? "unknown-account" : "exhausted";
  }

  async function release(key: string): Promise<void> {
    await execute(releaseSql, [key]);
  }

  async function usage(key: string): Promise<number | null> {
    const { rows } = await execute(usageSql, [key]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    // Postgres sends integer as a number and bigint as a string.
    return Number(row["used"]);
  }

  async function withSlot<T>(
    key: string,
    limit: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const taken = await take(key, limit);
    if (taken === "unknown-account") {
      throw new UnknownAccountError(key);
    }
    if (taken === "exhausted") {
      throw new QuotaExceededError(key, limit);
    }

    try {
      return await work();
    } catch (error) {
      try {
        await release(key);
      } catch (releaseError) {
        onReleaseError?.(releaseError, key);
      }
      throw error;
    }
  }

  return { take, release, usage, withSlot };
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError(`limit must be a non-negative integer, got ${limit}`);
  }
}
