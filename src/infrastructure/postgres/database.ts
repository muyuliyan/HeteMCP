import { Pool, type PoolConfig, type QueryResultRow } from "pg";

export type SqlRow = Record<string, unknown>;

export interface SqlQueryResult<Row extends SqlRow> {
  rows: Row[];
  rowCount: number;
}

export interface SqlExecutor {
  query<Row extends SqlRow>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<Result>(operation: (executor: SqlExecutor) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

export class PgDatabase implements SqlDatabase {
  readonly #pool: Pool;

  public constructor(config: PoolConfig) {
    this.#pool = new Pool({ ...config, allowExitOnIdle: true });
  }

  public async query<Row extends SqlRow>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.#pool.query<Row & QueryResultRow>(sql, [...parameters]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  public async transaction<Result>(
    operation: (executor: SqlExecutor) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation({
        query: async <Row extends SqlRow>(
          sql: string,
          parameters: readonly unknown[] = [],
        ): Promise<SqlQueryResult<Row>> => {
          const queryResult = await client.query<Row & QueryResultRow>(sql, [...parameters]);
          return { rows: queryResult.rows, rowCount: queryResult.rowCount ?? 0 };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public close(): Promise<void> {
    return this.#pool.end();
  }
}
