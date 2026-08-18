# quota-slot

Take and give back units of a per-account quota in Postgres, without losing updates when callers arrive at the same moment.

```ts
const slots = createQuotaSlots({
  execute: pgExecutor(pool),
  table: { table: "accounts", key: "id", counter: "parses_this_month" },
});

const invoice = await slots.withSlot(userId, 40, () => parseWithProvider(file));
```

Zero runtime dependencies. One statement per operation. No transaction is opened.

## The problem

A quota looks like three lines of code:

```ts
const used = await countUsed(userId);      // 9 of 10
if (used >= limit) return "quota spent";
await increment(userId);                   // 10 of 10
```

It's wrong, and testing on your laptop won't show you why. Between the read and the write, another caller does the same read. Both see nine, both pass the check, both increment. The account spends eleven units against a limit of ten.

You don't need anything exotic to hit this. One email with ten attachments, a retry storm, two browser tabs. Anything that starts work in parallel will do it.

## The fix

Let the check travel with the write:

```sql
UPDATE accounts
   SET parses_this_month = parses_this_month + 1
 WHERE id = $1
   AND parses_this_month < $2
```

Postgres locks the row for the duration of the update. A caller that shows up while another one is committing doesn't read a stale value. It waits, re-reads the row, and re-evaluates the `WHERE` clause against the new number. If the limit no longer holds, the statement matches nothing and reports zero affected rows.

That makes `rowCount` the answer rather than a detail: `1` means the unit is yours, `0` means it isn't. This is [READ COMMITTED](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED) behaviour, the default isolation level, so there's nothing to configure.

## What the tests show

The tests run against a real Postgres in a container. Every claim above is a claim about what the database does, and a mocked driver would only prove that the mock agrees with us.

`test/lost-update.test.ts` implements the naive version next to this one and runs the same race: fifty callers, limit of ten.

| | units granted | counter ends at |
|---|---|---|
| read, check, write | 50 | 50 |
| conditional `UPDATE` | 10 | 10 |

The interleaving in the first case is forced rather than hoped for: all readers, then all writers. That's the worst case, it's what a batch arriving at once actually produces, and pinning it keeps the test from going flaky.

## API

### `createQuotaSlots(options)`

| Option | Meaning |
|---|---|
| `execute` | Runs one parameterized statement. `pgExecutor(pool)` adapts `pg`, and any other driver takes one line. |
| `table` | `{ table, key, counter }`, where the counter lives. Names are checked at setup. |
| `onReleaseError` | Called when giving a unit back fails, so a failed release never replaces the error that caused it. |

### `take(key, limit): Promise<TakeResult>`

One of three answers:

| | Meaning |
|---|---|
| `"granted"` | The unit is yours. |
| `"exhausted"` | The account is at its limit. |
| `"unknown-account"` | There is no row for this key. |

It does **not** throw on a spent quota. That's an expected outcome, and only the caller knows what it means: a `403` for someone waiting on a request, a silent skip for a background job that should keep going.

The last two are worth keeping apart. A boolean would report a typo'd account id and a customer who used up their month as the same thing, and the first is a bug you want to hear about. Telling them apart costs a second query, but only on the refusal path: a granted unit is still one round-trip.

### `release(key): Promise<void>`

Give a unit back. Use it only for work that never happened, like storage refusing the file or the provider being unreachable. Work that ran and failed has already been paid for and keeps its unit.

It's guarded by `counter > 0`, so a window reset landing between the take and the release can't push the counter negative. Losing one unit beats showing an account a negative number.

### `usage(key): Promise<number | null>`

`null` means the row doesn't exist, which is different from zero.

### `withSlot(key, limit, work)`

Take, run, and give the unit back if `work` throws. Rethrows the original error, and a failure inside the rollback goes to `onReleaseError` instead of replacing it.

Throws `QuotaExceededError` when the account is at its limit and `UnknownAccountError` when there's no row for the key.

## Why not a transaction

`SELECT ... FOR UPDATE` inside a transaction gives you the same guarantee. It costs more: a second round-trip, an open transaction, and a connection held out of the pool for as long as it stays open. If the paid work happens inside that transaction, say a provider call taking ten seconds, the row stays locked for ten seconds and the pool drains under load.

A single conditional `UPDATE` gets the same answer in one statement and holds the lock for microseconds. Reach for the transaction when several rows have to move together. A counter is one row.

## Why a counter and not a ledger

The other way to model this is a ledger: one row per unit taken, each with its own id. That buys you identity. `release` becomes a delete by id, so it's idempotent, a retried worker can't hand back a unit twice, and you can answer "what was this account charged for" later.

The counter here doesn't have that. `release(key)` decrements, and it has no idea which `take` it belongs to. Call it twice for one take and the account gets a free unit back. `withSlot` keeps the pairing honest because both halves live in one call, but a hand-written `release` is on you.

What the counter buys instead is the whole point of this package: one row, one statement, and a limit check that lives inside the write. A ledger has to count rows to know whether the limit still holds, which is either an aggregate on every take or a second counter to keep in sync, and the rows need cleaning up whenever the window resets. If you need auditability, refunds by id, or at-least-once retries that must not double-refund, use a ledger. If you need a number that never goes over the limit, this is the cheaper half.

## When you don't need this

- **The counter isn't authoritative.** Approximate analytics can live with a lost update. Do the simple thing.
- **The limit is per second, not per account-month.** That's a rate limiter. Use a token bucket in Redis, where the state is meant to be volatile.
- **You already run everything inside one transaction.** Then use `SELECT ... FOR UPDATE` and keep it simple, or pass a checked-out client to `pgExecutor` if you still want this API.

## Not included

- **Window resets.** Rolling months, calendar months and grace periods are policy, and policy belongs to your application. This package only moves the number.
- **Isolation levels other than READ COMMITTED.** Under REPEATABLE READ or SERIALIZABLE the same `UPDATE` doesn't quietly lose the race, it fails with a serialization error (`40001`), and retrying is the caller's job. This package assumes the default and doesn't retry.
- **Databases other than Postgres.** The `UPDATE ... WHERE` trick is standard SQL, but the re-evaluation guarantee described above is specific to how Postgres implements READ COMMITTED. MySQL and SQLite behave differently enough to deserve their own tests before anyone makes a claim about them.
- **Multi-unit reservations.** Taking three units at once needs a different statement. Open an issue if you need it.

## Running the tests

```bash
npm install
npm test                       # starts a throwaway Postgres via testcontainers
DATABASE_URL=postgres://… npm test   # or point at your own
```

Docker is required for the default path.

## License

MIT
