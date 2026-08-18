/** What one statement gives back. Every driver reports both of these. */
export interface SqlResult {
  /** Rows the statement touched. `take` reads its answer from this. */
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * All this package needs from your database layer: run one parameterized
 * statement and say what happened.
 *
 * It's a plain function rather than an interface so that adapting a driver
 * costs one line, and so the package needs no runtime dependencies.
 */
export type SqlExecutor = (
  sql: string,
  params: unknown[],
) => Promise<SqlResult>;

/** Shape of a `pg` Pool or Client. Structural, so `pg` stays a devDependency. */
interface PgQueryable {
  query(config: {
    text: string;
    values: unknown[];
  }): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

/**
 * Adapter for `pg`. Pass a Pool normally, or a Client checked out of the pool
 * if the surrounding code is already inside its own transaction.
 */
export function pgExecutor(client: PgQueryable): SqlExecutor {
  return async (sql, params) => {
    const result = await client.query({ text: sql, values: params });
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  };
}
