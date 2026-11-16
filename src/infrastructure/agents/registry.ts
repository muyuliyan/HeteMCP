import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import type { AgentDescriptor } from "../../domain/schemas.js";
import type { AgentHarness } from "../../application/ports/agent-harness.js";
import { ClaudeHeadlessAdapter } from "../harnesses/claude-headless/adapter.js";
import { CodexHeadlessAdapter } from "../harnesses/codex-headless/adapter.js";
import { createDesktopHarness } from "../harnesses/deepseek-headless/desktop.js";

export interface AgentRuntime {
  name: string;
  kind: string;
  harness: AgentHarness;
  profile: string;
  acceptedProfiles: readonly string[];
  defaultModel?: string;
}

export interface AgentRuntimeSet {
  agents: ReadonlyMap<string, AgentRuntime>;
  catalog: AgentDescriptor[];
  warnings: string[];
}

const knownAgents = new Set(["claude", "codex", "deepseek"]);
const genericProfile = "file-generation";

const inheritedEnvironment = [
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "USERNAME",
  "LOCALAPPDATA",
  "APPDATA",
  "PATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

export function createAgentRuntimes(options: {
  repositoryRoot: string;
  env?: NodeJS.ProcessEnv;
}): AgentRuntimeSet {
  const env = options.env ?? process.env;
  const requested = parseList(env.HETEMCP_AGENTS ?? "auto");
  const enableAll = requested.includes("auto");
  const enabled = new Set(requested);
  const warnings: string[] = [];
  const descriptors: AgentDescriptor[] = [];
  const agents = new Map<string, AgentRuntime>();
  const childEnvironment = pickEnvironment(env);

  const requestedAgent = (name: string) => enableAll || enabled.has(name);
  const reportUnavailable = (name: string, kind: string, profiles: string[], reason: string) => {
    descriptors.push({ name, kind, profiles, available: false, reason });
    if (!enableAll) throw new Error(`Agent ${name} is enabled but unavailable: ${reason}`);
    warnings.push(`Agent ${name} is unavailable: ${reason}`);
  };

  if (requestedAgent("claude")) {
    const executable = resolveExecutable(
      env.HETEMCP_CLAUDE_EXECUTABLE,
      ["claude", join(homedir(), ".local", "bin", "claude.exe")],
      env,
    );
    if (!executable) {
      reportUnavailable(
        "claude",
        "claude-headless",
        ["claude-file-generation", genericProfile],
        "Claude Code executable not found",
      );
    } else {
      const harness = new ClaudeHeadlessAdapter({
        executable,
        env: childEnvironment,
      });
      addAgent({
        name: "claude",
        kind: harness.kind,
        harness,
        profile: "claude-file-generation",
        acceptedProfiles: ["claude-file-generation", genericProfile],
        ...(env.HETEMCP_CLAUDE_MODEL ? { defaultModel: env.HETEMCP_CLAUDE_MODEL } : {}),
      });
    }
  }

  if (requestedAgent("codex")) {
    const executable = resolveExecutable(
      env.HETEMCP_CODEX_EXECUTABLE,
      [...findCodexCandidates(env), "codex"],
      env,
    );
    if (!executable) {
      reportUnavailable(
        "codex",
        "codex-headless",
        ["codex-file-generation", genericProfile],
        "Codex CLI executable not found",
      );
    } else {
      const harness = new CodexHeadlessAdapter({
        executable,
        env: childEnvironment,
      });
      addAgent({
        name: "codex",
        kind: harness.kind,
        harness,
        profile: "codex-file-generation",
        acceptedProfiles: ["codex-file-generation", genericProfile],
        ...(env.HETEMCP_CODEX_MODEL ? { defaultModel: env.HETEMCP_CODEX_MODEL } : {}),
      });
    }
  }

  if (requestedAgent("deepseek")) {
    const desktop = env.HETEMCP_DSH_DESKTOP;
    const credentials = env.HETEMCP_CREDENTIALS_PATH;
    if (!desktop) {
      reportUnavailable(
        "deepseek",
        "deepseek-headless",
        ["deepseek-file-generation", genericProfile],
        "HETEMCP_DSH_DESKTOP is not set",
      );
    } else if (!credentials || env.HETEMCP_ALLOW_UNMETERED !== "1") {
      throw new Error(
        "Desktop file generation requires credentials path and explicit HETEMCP_ALLOW_UNMETERED=1",
      );
    } else {
      const harness = createDesktopHarness({
        applicationDirectory: resolve(options.repositoryRoot, desktop),
        credentialsPath: resolve(options.repositoryRoot, credentials),
        runtimeHome: resolve(options.repositoryRoot, ".heteromcp/dsh-home"),
        policyPatch: resolve(options.repositoryRoot, "config/deepseek-desktop-0.2.1.patch.yml"),
        environment: env,
      });
      addAgent({
        name: "deepseek",
        kind: harness.kind,
        harness,
        profile: "deepseek-file-generation",
        acceptedProfiles: ["deepseek-file-generation", genericProfile],
      });
    }
  }

  for (const name of enabled) {
    if (name === "auto" || name === "fake" || knownAgents.has(name)) continue;
    throw new Error(`Unknown agent in HETEMCP_AGENTS: ${name}`);
  }

  return { agents, catalog: descriptors, warnings };

  function addAgent(agent: AgentRuntime) {
    agents.set(agent.name, agent);
    descriptors.push({
      name: agent.name,
      kind: agent.kind,
      profiles: [...agent.acceptedProfiles],
      available: true,
      ...(agent.defaultModel ? { defaultModel: agent.defaultModel } : {}),
    });
  }
}

export function discoverAgentExecutables(env: NodeJS.ProcessEnv = process.env): {
  claude?: string;
  codex?: string;
} {
  const claude = resolveExecutable(
    env.HETEMCP_CLAUDE_EXECUTABLE,
    ["claude", join(homedir(), ".local", "bin", "claude.exe")],
    env,
  );
  const codex = resolveExecutable(
    env.HETEMCP_CODEX_EXECUTABLE,
    [...findCodexCandidates(env), "codex"],
    env,
  );
  return {
    ...(claude === undefined ? {} : { claude }),
    ...(codex === undefined ? {} : { codex }),
  };
}

export function resolveExecutable(
  explicit: string | undefined,
  candidates: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (explicit) {
    const resolved = isAbsolute(explicit)
      ? explicit
      : (findOnPath(explicit, env) ?? resolve(explicit));
    if (!existsSync(resolved)) {
      throw new Error(`Configured executable does not exist: ${explicit}`);
    }
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
      throw new Error("Use a native .exe for shell-free agent execution");
    }
    return resolved;
  }

  for (const candidate of candidates) {
    const resolved = isAbsolute(candidate) ? candidate : findOnPath(candidate, env);
    if (resolved && existsSync(resolved)) {
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) continue;
      return resolved;
    }
  }
  return undefined;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) return undefined;
  const extensions = process.platform === "win32" ? [".exe", ".com", ""] : ["", ".exe", ".sh"];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function findCodexCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : undefined,
    env.APPDATA ? join(env.APPDATA, "OpenAI", "Codex", "bin") : undefined,
  ].filter((root): root is string => root !== undefined);

  const candidates: { path: string; modified: number }[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, "codex.exe");
      if (!existsSync(candidate)) continue;
      try {
        candidates.push({ path: candidate, modified: statSync(candidate).mtimeMs });
      } catch {
        /* A concurrent update removed the candidate. */
      }
    }
  }
  return candidates
    .sort((left, right) => right.modified - left.modified)
    .map((candidate) => candidate.path);
}

function pickEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of inheritedEnvironment) {
    const value = env[name];
    if (value) picked[name] = value;
  }
  return picked;
}

function parseList(value: string): string[] {
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : ["auto"];
}
