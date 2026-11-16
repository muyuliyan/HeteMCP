import { timingSafeEqual, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { Orchestrator } from "../../application/orchestrator.js";
import { createMcpServer } from "./server.js";

export interface HttpMcpOptions {
  orchestrator: Orchestrator;
  host?: string;
  port?: number;
  path?: string;
  token?: string;
  maxSessions?: number;
  onBackgroundError?: (error: unknown) => void;
}

export interface HttpMcpServer {
  url: string;
  close(): Promise<void>;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const maxBodyBytes = 1024 * 1024;

// Local Streamable HTTP endpoint for clients such as CC-switch. Loopback binding is
// the default; non-loopback binding requires an explicit bearer token.
export async function startHttpMcpServer(options: HttpMcpOptions): Promise<HttpMcpServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const mcpPath = normalizePath(options.path ?? "/mcp");
  const token = options.token;
  const maxSessions = options.maxSessions ?? 32;
  if (!isLoopbackHost(host) && !token) {
    throw new Error("A non-loopback MCP HTTP bind requires HETEMCP_MCP_TOKEN");
  }

  const sessions = new Map<string, Session>();
  const httpServer = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error("MCP HTTP request failed", error);
      if (!response.headersSent) sendJson(response, 500, rpcError("Internal server error"));
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `http://${urlHost}:${String(actualPort)}${mcpPath}`;

  return {
    url,
    async close() {
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/healthz" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (requestUrl.pathname !== mcpPath) {
      sendJson(response, 404, rpcError("Not found"));
      return;
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      sendJson(response, 403, rpcError("Origin is not allowed"));
      return;
    }
    if (!isAuthorized(request)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      sendJson(response, 401, rpcError("Unauthorized"));
      return;
    }

    const method = request.method ?? "GET";
    if (method === "POST") {
      const length = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(length) && length > maxBodyBytes) {
        sendJson(response, 413, rpcError("Request body is too large"));
        return;
      }
      const contentType = headerValue(request.headers["content-type"]) ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        sendJson(response, 415, rpcError("Content-Type must be application/json"));
        return;
      }
    }

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(response, 404, rpcError("Unknown MCP session"));
        return;
      }
      await session.transport.handleRequest(request, response);
      return;
    }

    if (method !== "POST") {
      sendJson(response, 400, rpcError("MCP session header is required"));
      return;
    }
    if (sessions.size >= maxSessions) {
      sendJson(response, 429, rpcError("Too many MCP sessions"));
      return;
    }

    const server = createMcpServer(options.orchestrator, {
      ...(options.onBackgroundError === undefined
        ? {}
        : { onBackgroundError: options.onBackgroundError }),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        void server.close().catch(() => undefined);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      void server.close().catch(() => undefined);
    };
    // The SDK's optional callback properties conflict with exactOptionalPropertyTypes.
    await server.connect(transport as unknown as Transport);
    try {
      await transport.handleRequest(request, response);
    } finally {
      // Rejected or malformed initialization attempts must not leak a server.
      if (!transport.sessionId) {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    }
  }

  function isAuthorized(request: IncomingMessage): boolean {
    if (!token) return true;
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const provided = Buffer.from(header.slice("Bearer ".length));
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", String(payload.length));
  response.end(payload);
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}
