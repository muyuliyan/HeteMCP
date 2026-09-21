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
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const migration of migrations) {
    await database.transaction(async (executor) => {
      const applied = await executor.query<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (applied.rowCount > 0) return;

      for (const statement of migration.statements) await executor.query(statement);
      await executor.query(
        "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [migration.version],
      );
    });
  }
}
