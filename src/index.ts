#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Orchestrator } from "./application/orchestrator.js";
import { FakeProvider } from "./infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "./infrastructure/repositories/in-memory-task-repository.js";
import { createMcpServer } from "./transport/mcp/server.js";

async function main(): Promise<void> {
  const repository = new InMemoryTaskRepository();
  const provider = new FakeProvider();
  const orchestrator = new Orchestrator(repository, provider);
  const server = createMcpServer(orchestrator);
  await server.connect(new StdioServerTransport());
  console.error("HeteMCP server running on stdio with the fake provider");
}

main().catch((error: unknown) => {
  console.error("HeteMCP failed to start", error);
  process.exitCode = 1;
});
