import type { SqlDatabase } from "./database.js";

const migrations = [
  {
    version: 1,
    statements: [
      `
      CREATE TABLE IF NOT EXISTS tasks (
        id uuid PRIMARY KEY,
        idempotency_key text NOT NULL UNIQUE,
        status text NOT NULL,
        revision integer NOT NULL CHECK (revision >= 0),
        lease_owner text,
        lease_expires_at timestamptz,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        record jsonb NOT NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS tasks_queue_order_idx
        ON tasks (created_at, id)
        WHERE status = 'queued'`,
      `CREATE INDEX IF NOT EXISTS tasks_expired_lease_idx
        ON tasks (lease_expires_at)
        WHERE status = 'running'`,
    ],
  },
] as const;

export async function runMigrations(database: SqlDatabase): Promise<void> {
  await database.transaction(async (executor) => {
    // The lock must precede even the metadata-table DDL: concurrent CREATE TABLE
    // can still race in PostgreSQL system catalogs despite IF NOT EXISTS.
    await executor.query("SELECT pg_advisory_xact_lock($1, $2)", [1212501328, 1]);
    await executor.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migration of migrations) {
      const applied = await executor.query<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (applied.rowCount > 0) continue;

      for (const statement of migration.statements) await executor.query(statement);
      await executor.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [migration.version],
      );
    }
  });
}
