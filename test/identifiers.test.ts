import { describe, it, expect } from "vitest";

import { createQuotaSlots, UnsafeIdentifierError } from "../src/index.js";

/**
 * Table and column names get inlined into the SQL text because they cannot be
 * bound as parameters. These tests pin the only defence there is: reject
 * anything that is not a plain identifier, and reject it at setup rather than
 * at query time.
 */
const noopExecutor = async () => ({ rowCount: 0, rows: [] });

describe("identifier validation", () => {
  it("accepts plain and schema-qualified names", () => {
    expect(() =>
      createQuotaSlots({
        execute: noopExecutor,
        table: { table: "billing.accounts", key: "id", counter: "used" },
      }),
    ).not.toThrow();
  });

  it("refuses an injection attempt in a table name", () => {
    expect(() =>
      createQuotaSlots({
        execute: noopExecutor,
        table: {
          table: `accounts"; DROP TABLE accounts; --`,
          key: "id",
          counter: "used",
        },
      }),
    ).toThrow(UnsafeIdentifierError);
  });

  it("refuses a name with more than one dot", () => {
    expect(() =>
      createQuotaSlots({
        execute: noopExecutor,
        table: { table: "db.billing.accounts", key: "id", counter: "used" },
      }),
    ).toThrow(UnsafeIdentifierError);
  });

  it("refuses an empty column name", () => {
    expect(() =>
      createQuotaSlots({
        execute: noopExecutor,
        table: { table: "accounts", key: "", counter: "used" },
      }),
    ).toThrow(UnsafeIdentifierError);
  });
});

describe("limit validation", () => {
  it("rejects a fractional limit before touching the database", async () => {
    const slots = createQuotaSlots({
      execute: noopExecutor,
      table: { table: "accounts", key: "id", counter: "used" },
    });

    await expect(slots.take("acc-1", 2.5)).rejects.toBeInstanceOf(TypeError);
  });
});
