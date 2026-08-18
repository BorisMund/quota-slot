import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";

import { createQuotaSlots, pgExecutor } from "../src/index.js";
import type { QuotaSlots } from "../src/index.js";
import {
  createAccountsTable,
  insertAccount,
  readCounter,
  startDatabase,
  type TestDatabase,
} from "./support/database.js";

/**
 * The test that explains why this package exists: read-compare-write next to
 * the conditional UPDATE, same race, fifty callers against a limit of ten.
 * All readers go first and then all writers, so the overspend is forced
 * rather than hoped for.
 */
const ACCOUNT = "acc-2";
const LIMIT = 10;
const ATTEMPTS = 50;

let db: TestDatabase;
let pool: Pool;
let slots: QuotaSlots;

beforeAll(async () => {
  db = await startDatabase();
  pool = db.pool;
  await createAccountsTable(pool);
  slots = createQuotaSlots({
    execute: pgExecutor(pool),
    table: { table: "accounts", key: "id", counter: "parses_this_month" },
  });
}, 180_000);

afterAll(async () => {
  await db.stop();
});

beforeEach(async () => {
  await insertAccount(pool, ACCOUNT);
});

describe("read-modify-write", () => {
  it("overspends the limit when every caller checks before anyone writes", async () => {
    const decisions = await Promise.all(
      Array.from({ length: ATTEMPTS }, async () => {
        const { rows } = await pool.query<{ used: number }>(
          `SELECT parses_this_month AS used FROM accounts WHERE id = $1`,
          [ACCOUNT],
        );
        return Number(rows[0]?.used ?? 0) < LIMIT;
      }),
    );

    await Promise.all(
      decisions
        .filter(Boolean)
        .map(() =>
          pool.query(
            `UPDATE accounts SET parses_this_month = parses_this_month + 1 WHERE id = $1`,
            [ACCOUNT],
          ),
        ),
    );

    // Fifty units handed out against a limit of ten.
    expect(await readCounter(pool, ACCOUNT)).toBe(ATTEMPTS);
    expect(await readCounter(pool, ACCOUNT)).toBeGreaterThan(LIMIT);
  });
});

describe("conditional update, same race", () => {
  it("holds the limit exactly", async () => {
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => slots.take(ACCOUNT, LIMIT)),
    );

    expect(results.filter((result) => result === "granted").length).toBe(LIMIT);
    expect(await readCounter(pool, ACCOUNT)).toBe(LIMIT);
  });
});
