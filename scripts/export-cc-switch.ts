import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAgentExecutables } from "../src/infrastructure/agents/registry.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = join(repositoryRoot, "dist", "index.js");
if (!existsSync(entrypoint)) {
  throw new Error("dist/index.js is missing; run npm run build first");
}

const discovered = discoverAgentExecutables(process.env);
const artifactRoot = resolve(
  repositoryRoot,
  process.env.HETEMCP_ARTIFACT_ROOT ?? ".heteromcp/artifacts",
);
const environment: Record<string, string> = {
  HETEMCP_AGENTS: process.env.HETEMCP_AGENTS ?? "auto",
  HETEMCP_ARTIFACT_ROOT: artifactRoot,
};
// Keep the child able to launch native CLIs even if the client replaces its environment.
for (const name of [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PATH",
] as const) {
  const value = process.env[name];
  if (value) environment[name] = value;
}
for (const name of [
  "HETEMCP_DEFAULT_WORKER",
  "HETEMCP_CLAUDE_MODEL",
  "HETEMCP_CODEX_MODEL",
  "HETEMCP_DSH_DESKTOP",
  "HETEMCP_CREDENTIALS_PATH",
  "HETEMCP_ALLOW_UNMETERED",
] as const) {
  const value = process.env[name];
  if (value) environment[name] = value;
}
if (discovered.claude) environment.HETEMCP_CLAUDE_EXECUTABLE = discovered.claude;
if (discovered.codex) environment.HETEMCP_CODEX_EXECUTABLE = discovered.codex;

const port = process.env.HETEMCP_MCP_PORT ?? "8787";
const path = process.env.HETEMCP_MCP_PATH ?? "/mcp";
const token = process.env.HETEMCP_MCP_TOKEN;

const stdio = {
  mcpServers: {
    heteromcp: {
      type: "stdio",
      command: process.execPath,
      args: [entrypoint],
      env: environment,
    },
  },
};
const http = {
  mcpServers: {
    "heteromcp-http": {
      type: "http",
      url: `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  },
};
const combined = {
  mcpServers: {
    ...stdio.mcpServers,
    ...http.mcpServers,
  },
};

const directory = resolve(repositoryRoot, ".heteromcp", "cc-switch");
await mkdir(directory, { recursive: true });
const outputs = [
  ["heteromcp.stdio.json", stdio],
  ["heteromcp.http.json", http],
  ["heteromcp.mcp.json", combined],
] as const;
for (const [name, value] of outputs) {
  await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

console.log(`CC-switch import files written to ${directory}`);
for (const [name] of outputs) console.log(`- ${join(directory, name)}`);
console.log("The HTTP entry requires: npm run start:http");
