#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ModeRoutingExecutor } from "./application/mode-router.js";
import { Orchestrator } from "./application/orchestrator.js";
import { WorkerLoop } from "./application/worker-loop.js";
import type { TaskRepository } from "./application/ports/task-repository.js";
import { createAgentRuntimes } from "./infrastructure/agents/registry.js";
import { PgDatabase, type SqlDatabase } from "./infrastructure/postgres/database.js";
import { runMigrations } from "./infrastructure/postgres/migrations.js";
import { FakeProvider } from "./infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "./infrastructure/repositories/in-memory-task-repository.js";
import { PostgresTaskRepository } from "./infrastructure/repositories/postgres-task-repository.js";
import { startHttpMcpServer, type HttpMcpServer } from "./transport/mcp/http.js";
import { createMcpServer } from "./transport/mcp/server.js";

interface RepositoryRuntime {
  repository: TaskRepository;
  database?: SqlDatabase;
}

interface TransportOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  path: string;
  token?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function createRepositoryRuntime(): Promise<RepositoryRuntime> {
  const connectionString = process.env.HETEMCP_DATABASE_URL;
  if (!connectionString) return { repository: new InMemoryTaskRepository() };

  const database = new PgDatabase({ connectionString });
  await runMigrations(database);
  return { repository: new PostgresTaskRepository(database), database };
}

function readTransportOptions(argv: readonly string[], env: NodeJS.ProcessEnv): TransportOptions {
  const values = new Map<string, string>();
  let httpFlag = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.error(
        "Usage: node dist/index.js [--transport stdio|http] [--host HOST] [--port PORT] [--path /mcp] [--token TOKEN]",
      );
      process.exit(0);
    }
    if (argument === "--http") {
      httpFlag = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unknown argument: ${argument ?? ""}`);
    const [name, inline] = argument.slice(2).split("=", 2);
    if (!name) throw new Error("Invalid argument");
    const value = inline ?? argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for --${name}`);
    if (inline === undefined) index += 1;
    values.set(name, value);
  }

  const transport = (values.get("transport") ?? env.HETEMCP_MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("Transport must be stdio or http");
  }
  const port = Number(values.get("port") ?? env.HETEMCP_MCP_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("MCP port must be an integer between 0 and 65535");
  }
  const token = values.get("token") ?? env.HETEMCP_MCP_TOKEN;
  return {
    transport: httpFlag ? "http" : transport,
    host: values.get("host") ?? env.HETEMCP_MCP_HOST ?? "127.0.0.1",
    port,
    path: values.get("path") ?? env.HETEMCP_MCP_PATH ?? "/mcp",
    ...(token ? { token } : {}),
  };
}

async function main(): Promise<void> {
  const transportOptions = readTransportOptions(process.argv.slice(2), process.env);
  const runtime = await createRepositoryRuntime();
  const artifactRoot = resolve(
    repositoryRoot,
    process.env.HETEMCP_ARTIFACT_ROOT ?? ".heteromcp/artifacts",
  );
  const agents = createAgentRuntimes({ repositoryRoot, env: process.env });
  for (const warning of agents.warnings) console.error(warning);

  const defaultWorker = process.env.HETEMCP_DEFAULT_WORKER?.trim().toLowerCase();
  if (defaultWorker && defaultWorker !== "fake" && !agents.agents.has(defaultWorker)) {
    throw new Error(`HETEMCP_DEFAULT_WORKER is not available: ${defaultWorker}`);
  }

  const provider = new ModeRoutingExecutor({
    agents: [...agents.agents.values()],
    artifactRoot,
    fake: new FakeProvider(),
    ...(defaultWorker ? { defaultWorker } : {}),
    allowExternalArtifacts: process.env.HETEMCP_ALLOW_EXTERNAL_ARTIFACTS === "1",
    catalog: agents.catalog,
  });
  const orchestrator = new Orchestrator(runtime.repository, provider);
  const workerLoop = new WorkerLoop(orchestrator);
  const stdioServer =
    transportOptions.transport === "stdio" ? createMcpServer(orchestrator) : undefined;
  let httpServer: HttpMcpServer | undefined;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    workerLoop.stop();
    await stdioServer?.close();
    await httpServer?.close();
    await runtime.database?.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await workerLoop.start();
  if (stdioServer) {
    await stdioServer.connect(new StdioServerTransport());
    console.error(
      `HeteMCP server running on stdio with ${runtime.database ? "PostgreSQL" : "in-memory"} storage`,
    );
  } else {
    httpServer = await startHttpMcpServer({
      orchestrator,
      host: transportOptions.host,
      port: transportOptions.port,
      path: transportOptions.path,
      ...(transportOptions.token === undefined ? {} : { token: transportOptions.token }),
    });
    console.error(
      `HeteMCP MCP HTTP endpoint ${httpServer.url} with ${runtime.database ? "PostgreSQL" : "in-memory"} storage`,
    );
  }
  console.error(
    `Agents: ${[...agents.agents.keys()].join(", ") || "fake only"}; default mode: dispatch`,
  );
}

main().catch((error: unknown) => {
  console.error("HeteMCP failed to start", error);
  process.exitCode = 1;
});
