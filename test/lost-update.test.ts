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
 * The test that explains why this package exists.
 *
 * It does the obvious thing (read the counter, compare it in the application,
 * write it back) and shows the limit being overspent. The interleaving is
 * forced rather than hoped for: every reader first, then every writer. That is
 * the worst case, it is what a batch arriving at once produces, and pinning it
 * keeps the test from going flaky.
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
    // Phase 1: all fifty read, and each one sees 0 used out of 10.
    const decisions = await Promise.all(
      Array.from({ length: ATTEMPTS }, async () => {
        const { rows } = await pool.query<{ used: number }>(
          `SELECT parses_this_month AS used FROM accounts WHERE id = $1`,
          [ACCOUNT],
        );
        return Number(rows[0]?.used ?? 0) < LIMIT;
      }),
    );

    // Phase 2: everyone who passed the check writes.
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
