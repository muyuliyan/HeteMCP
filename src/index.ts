#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Orchestrator } from "./application/orchestrator.js";
import { WorkerLoop } from "./application/worker-loop.js";
import type { TaskRepository } from "./application/ports/task-repository.js";
import { PgDatabase, type SqlDatabase } from "./infrastructure/postgres/database.js";
import { runMigrations } from "./infrastructure/postgres/migrations.js";
import { FakeProvider } from "./infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "./infrastructure/repositories/in-memory-task-repository.js";
import { PostgresTaskRepository } from "./infrastructure/repositories/postgres-task-repository.js";
import { createMcpServer } from "./transport/mcp/server.js";

interface RepositoryRuntime {
  repository: TaskRepository;
  database?: SqlDatabase;
}

async function createRepositoryRuntime(): Promise<RepositoryRuntime> {
  const connectionString = process.env.HETEMCP_DATABASE_URL;
  if (!connectionString) return { repository: new InMemoryTaskRepository() };

  const database = new PgDatabase({ connectionString });
  await runMigrations(database);
  return { repository: new PostgresTaskRepository(database), database };
}

async function main(): Promise<void> {
  const runtime = await createRepositoryRuntime();
  const provider = new FakeProvider();
  const orchestrator = new Orchestrator(runtime.repository, provider);
  const workerLoop = new WorkerLoop(orchestrator);
  const server = createMcpServer(orchestrator);

  const shutdown = async () => {
    workerLoop.stop();
    await server.close();
    await runtime.database?.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await workerLoop.start();
  await server.connect(new StdioServerTransport());
  console.error(
    `HeteMCP server running on stdio with ${runtime.database ? "PostgreSQL" : "in-memory"} storage`,
  );
}

main().catch((error: unknown) => {
  console.error("HeteMCP failed to start", error);
  process.exitCode = 1;
});
