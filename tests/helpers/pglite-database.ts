import { PGlite, type Transaction } from "@electric-sql/pglite";

import type {
  SqlDatabase,
  SqlExecutor,
  SqlQueryResult,
  SqlRow,
} from "../../src/infrastructure/postgres/database.js";

export class PGliteDatabase implements SqlDatabase {
  readonly #database = new PGlite();

  public async ready(): Promise<void> {
    await this.#database.waitReady;
  }

  public query<Row extends SqlRow>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    return this.queryWith(this.#database, sql, parameters);
  }

  public transaction<Result>(
    operation: (executor: SqlExecutor) => Promise<Result>,
  ): Promise<Result> {
    return this.#database.transaction((transaction) =>
      operation({
        query: <Row extends SqlRow>(sql: string, parameters: readonly unknown[] = []) =>
          this.queryWith<Row>(transaction, sql, parameters),
      }),
    );
  }

  public close(): Promise<void> {
    return this.#database.close();
  }

  private async queryWith<Row extends SqlRow>(
    executor: Pick<PGlite, "query"> | Transaction,
    sql: string,
    parameters: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await executor.query<Row>(sql, [...parameters]);
    return {
      rows: result.rows,
      rowCount:
        result.rowCount ??
        (result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0)),
    };
  }
}
