import { QuotaExceededError } from "./errors.js";
import type { SqlExecutor } from "./executor.js";
import { quoteIdentifier } from "./identifiers.js";

/** Where the counter lives. One row per account, one integer column. */
export interface QuotaTable {
  /** Table holding the counter, optionally schema-qualified: `billing.accounts`. */
  table: string;
  /** Column identifying the account. Must be unique, one row per key. */
  key: string;
  /** Integer column counting units taken in the current window. */
  counter: string;
}

export interface QuotaSlotsOptions {
  execute: SqlExecutor;
  table: QuotaTable;
  /**
   * Called when giving a unit back fails. A failed release shouldn't replace
   * the error that caused the rollback, so it's reported here instead of being
   * thrown. Defaults to silence, which is the reason this hook exists.
   */
  onReleaseError?: (error: unknown, key: string) => void;
}

export interface QuotaSlots {
  /**
   * Take one unit if the account is still under `limit`.
   * True when the unit is ours, false when the quota is spent.
   */
  take(key: string, limit: number): Promise<boolean>;

  /**
   * Give one unit back. Only for work that never happened: the upload was
   * refused, the provider was down. Work that ran and failed has been paid for
   * and keeps its unit.
   */
  release(key: string): Promise<void>;

  /** Units taken so far, or null if the account row doesn't exist. */
  usage(key: string): Promise<number | null>;

  /**
   * Take a unit, run `work`, give the unit back if `work` throws.
   * Throws QuotaExceededError when nothing is left.
   */
  withSlot<T>(key: string, limit: number, work: () => Promise<T>): Promise<T>;
}

export function createQuotaSlots(options: QuotaSlotsOptions): QuotaSlots {
  const { execute, table, onReleaseError } = options;

  // Checked once here so a typo fails on startup, not on the first request
  // that touches the quota.
  const tableName = quoteIdentifier(table.table, "table");
  const keyColumn = quoteIdentifier(table.key, "key column");
  const counterColumn = quoteIdentifier(table.counter, "counter column");

  // The point of the whole package.
  //
  // Reading the counter, comparing it in the application and writing it back
  // loses updates: concurrent callers read the same value, all pass the check,
  // and the limit is overspent. Here the check is part of the write. Postgres
  // locks the row, so a caller that shows up while another one is committing
  // re-reads the row and re-evaluates WHERE against the new value. Losers match
  // nothing and get rowCount 0. No transaction involved.
  const takeSql =
    `UPDATE ${tableName} SET ${counterColumn} = ${counterColumn} + 1 ` +
    `WHERE ${keyColumn} = $1 AND ${counterColumn} < $2`;

  // The `> 0` guard keeps the counter off negative numbers if the window was
  // reset between the take and the release. Losing one unit beats showing an
  // account negative usage.
  const releaseSql =
    `UPDATE ${tableName} SET ${counterColumn} = ${counterColumn} - 1 ` +
    `WHERE ${keyColumn} = $1 AND ${counterColumn} > 0`;

  const usageSql = `SELECT ${counterColumn} AS used FROM ${tableName} WHERE ${keyColumn} = $1`;

  async function take(key: string, limit: number): Promise<boolean> {
    assertLimit(limit);
    const { rowCount } = await execute(takeSql, [key, limit]);
    return rowCount === 1;
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
    // Postgres sends integer as a number and bigint as a string. Take both.
    return Number(row["used"]);
  }

  async function withSlot<T>(
    key: string,
    limit: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const taken = await take(key, limit);
    if (!taken) {
      throw new QuotaExceededError(key, limit);
    }

    try {
      return await work();
    } catch (error) {
      // Best effort. Whatever went wrong inside `work` is the error the caller
      // came for, so a broken release goes to the hook and not up the stack.
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
