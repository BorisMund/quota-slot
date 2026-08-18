export interface SqlResult {
  rowCount: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * Run one parameterized statement. The only thing this package needs from your
 * database layer, which is why adapting a driver takes one line and there are
 * no runtime dependencies.
 */
export type SqlExecutor = (
  sql: string,
  params: unknown[],
) => Promise<SqlResult>;

/** Shape of a `pg` Pool or Client, structural so `pg` stays a devDependency. */
interface PgQueryable {
  query(config: {
    text: string;
    values: unknown[];
  }): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

/** Adapter for `pg`. Pass a Pool, or a Client if you're already in a transaction. */
export function pgExecutor(client: PgQueryable): SqlExecutor {
  return async (sql, params) => {
    const result = await client.query({ text: sql, values: params });
    return { rowCount: result.rowCount ?? 0, rows: result.rows };
  };
}
