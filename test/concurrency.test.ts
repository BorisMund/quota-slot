import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";

import { createQuotaSlots, pgExecutor, QuotaExceededError } from "../src/index.js";
import type { QuotaSlots } from "../src/index.js";
import {
  createAccountsTable,
  insertAccount,
  readCounter,
  startDatabase,
  type TestDatabase,
} from "./support/database.js";

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
  await insertAccount(pool, "acc-1");
});

describe("take under concurrency", () => {
  it("hands out exactly `limit` units when 50 callers race for 10", async () => {
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () => slots.take("acc-1", LIMIT)),
    );

    const granted = results.filter(Boolean).length;

    // Exactly ten, not "about ten".
    expect(granted).toBe(LIMIT);
    expect(results.filter((ok) => !ok)).toHaveLength(ATTEMPTS - LIMIT);
    // And the counter agrees: nothing was handed out without being recorded.
    expect(await readCounter(pool, "acc-1")).toBe(LIMIT);
  });

  it("keeps the counter consistent when takes and releases interleave", async () => {
    // Twenty takes racing twenty releases. Whatever order they land in, the
    // counter has to stay in range: never below zero, never above the limit.
    await Promise.all(Array.from({ length: 20 }, () => slots.take("acc-1", LIMIT)));
    await Promise.all([
      ...Array.from({ length: 20 }, () => slots.take("acc-1", LIMIT)),
      ...Array.from({ length: 20 }, () => slots.release("acc-1")),
    ]);

    const used = await readCounter(pool, "acc-1");
    expect(used).toBeGreaterThanOrEqual(0);
    expect(used).toBeLessThanOrEqual(LIMIT);
  });
});

describe("release", () => {
  it("gives a unit back", async () => {
    await slots.take("acc-1", LIMIT);
    await slots.take("acc-1", LIMIT);
    await slots.release("acc-1");

    expect(await slots.usage("acc-1")).toBe(1);
  });

  it("never drives the counter below zero", async () => {
    await slots.release("acc-1");
    await slots.release("acc-1");

    expect(await slots.usage("acc-1")).toBe(0);
  });
});

describe("usage", () => {
  it("returns null for an account that does not exist", async () => {
    expect(await slots.usage("missing")).toBeNull();
  });
});

describe("withSlot", () => {
  it("keeps the unit when the work succeeds", async () => {
    const result = await slots.withSlot("acc-1", LIMIT, async () => "parsed");

    expect(result).toBe("parsed");
    expect(await slots.usage("acc-1")).toBe(1);
  });

  it("gives the unit back when the work throws, and rethrows the original error", async () => {
    await expect(
      slots.withSlot("acc-1", LIMIT, async () => {
        throw new Error("storage refused the file");
      }),
    ).rejects.toThrow("storage refused the file");

    // The provider was never called, so the account keeps its unit.
    expect(await slots.usage("acc-1")).toBe(0);
  });

  it("throws QuotaExceededError once the limit is spent", async () => {
    await Promise.all(
      Array.from({ length: LIMIT }, () => slots.take("acc-1", LIMIT)),
    );

    await expect(
      slots.withSlot("acc-1", LIMIT, async () => "never runs"),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("reports a failing release instead of masking the original error", async () => {
    const seen: unknown[] = [];
    const brittle = createQuotaSlots({
      execute: async (sql, params) => {
        if (sql.includes("- 1")) {
          throw new Error("connection lost");
        }
        return pgExecutor(pool)(sql, params);
      },
      table: { table: "accounts", key: "id", counter: "parses_this_month" },
      onReleaseError: (error) => seen.push(error),
    });

    await expect(
      brittle.withSlot("acc-1", LIMIT, async () => {
        throw new Error("provider is down");
      }),
    ).rejects.toThrow("provider is down");

    expect(seen).toHaveLength(1);
  });
});
