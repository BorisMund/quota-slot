import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

export interface TestDatabase {
  pool: Pool;
  stop: () => Promise<void>;
}

/**
 * A real Postgres, not a mock.
 *
 * Every claim this package makes is a claim about what the database does under
 * concurrency, and a mocked driver would only prove that the mock agrees with
 * us.
 *
 * DATABASE_URL wins if it is set, so CI can use a service container and you can
 * point at a local instance. Otherwise a throwaway container is started here.
 */
export async function startDatabase(): Promise<TestDatabase> {
  if (process.env["DATABASE_URL"]) {
    const pool = new Pool({
      connectionString: process.env["DATABASE_URL"],
      max: 60,
    });
    return {
      pool,
      stop: async () => {
        await pool.end();
      },
    };
  }

  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 60 });

  return {
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/** One row per account. The shape this package expects, nothing more. */
export async function createAccountsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                 text PRIMARY KEY,
      parses_this_month  integer NOT NULL DEFAULT 0
    )
  `);
}

export async function insertAccount(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO accounts (id, parses_this_month) VALUES ($1, 0)
     ON CONFLICT (id) DO UPDATE SET parses_this_month = 0`,
    [id],
  );
}

export async function readCounter(pool: Pool, id: string): Promise<number> {
  const { rows } = await pool.query<{ parses_this_month: number }>(
    `SELECT parses_this_month FROM accounts WHERE id = $1`,
    [id],
  );
  return Number(rows[0]?.parses_this_month);
}
