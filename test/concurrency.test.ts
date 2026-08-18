import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";

import {
  createQuotaSlots,
  pgExecutor,
  QuotaExceededError,
  UnknownAccountError,
} from "../src/index.js";
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
    table: { table: "accounts", key: "id", counter: "units_this_month" },
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

    const granted = results.filter((result) => result === "granted").length;

    expect(granted).toBe(LIMIT);
    expect(results.filter((result) => result === "exhausted")).toHaveLength(
      ATTEMPTS - LIMIT,
    );
    expect(await readCounter(pool, "acc-1")).toBe(LIMIT);
  });

  it("keeps the counter consistent when takes and releases interleave", async () => {
    // Whatever order they land in, the counter has to stay in range.
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

describe("an account that does not exist", () => {
  it("is reported apart from a spent quota", async () => {
    expect(await slots.take("missing", LIMIT)).toBe("unknown-account");

    // Same refusal from the caller's side, different reason.
    await Promise.all(
      Array.from({ length: LIMIT }, () => slots.take("acc-1", LIMIT)),
    );
    expect(await slots.take("acc-1", LIMIT)).toBe("exhausted");
  });

  it("makes withSlot throw UnknownAccountError, not QuotaExceededError", async () => {
    await expect(
      slots.withSlot("missing", LIMIT, async () => "never runs"),
    ).rejects.toBeInstanceOf(UnknownAccountError);
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
      table: { table: "accounts", key: "id", counter: "units_this_month" },
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
