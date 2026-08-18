import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

/** Well under the 100 connections a default Postgres allows. */
const POOL_SIZE = 25;

export interface TestDatabase {
  pool: Pool;
  stop: () => Promise<void>;
}

/**
 * A real Postgres, because every claim here is a claim about what the database
 * does under concurrency. DATABASE_URL wins if set, otherwise a throwaway
 * container is started.
 */
export async function startDatabase(): Promise<TestDatabase> {
  if (process.env["DATABASE_URL"]) {
    const pool = new Pool({
      connectionString: process.env["DATABASE_URL"],
      max: POOL_SIZE,
    });
    return {
      pool,
      stop: async () => {
        await pool.end();
      },
    };
  }

  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: POOL_SIZE });

  return {
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

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
