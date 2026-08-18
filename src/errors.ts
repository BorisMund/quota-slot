/** Thrown by `withSlot` when the account is at its limit. `take` returns "exhausted" instead. */
export class QuotaExceededError extends Error {
  readonly key: string;
  readonly limit: number;

  constructor(key: string, limit: number) {
    super(`Quota exceeded for "${key}": all ${limit} units are already taken.`);
    this.name = "QuotaExceededError";
    this.key = key;
    this.limit = limit;
  }
}

/** Thrown by `withSlot` when there is no quota row for the key. */
export class UnknownAccountError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`No quota row for "${key}": the row has to exist before it can spend anything.`);
    this.name = "UnknownAccountError";
    this.key = key;
  }
}

/** Thrown at setup time for a table or column name we won't inline into SQL. */
export class UnsafeIdentifierError extends Error {
  constructor(role: string, value: string) {
    super(
      `Refusing to use ${role} "${value}": identifiers must match [A-Za-z_][A-Za-z0-9_]* ` +
        `and may be schema-qualified with a single dot.`,
    );
    this.name = "UnsafeIdentifierError";
  }
}
