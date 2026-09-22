import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const databaseUrl =
  process.env.HETEMCP_INTEGRATION_DATABASE_URL ??
  "postgresql://heteromcp:heteromcp_test_only@127.0.0.1:55432/heteromcp_test";

interface RunOptions {
  env?: NodeJS.ProcessEnv;
}

function run(command: string, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited with ${String(code ?? signal ?? "unknown status")}`));
    });
  });
}

try {
  await run("docker", ["compose", "up", "-d", "--wait", "postgres"]);
  await run(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"],
    { env: { HETEMCP_INTEGRATION_DATABASE_URL: databaseUrl } },
  );
} finally {
  // Compose can create resources before `up --wait` reports a health failure.
  await run("docker", ["compose", "down", "--volumes", "--remove-orphans"]).catch(
    (error: unknown) => {
      console.error("Failed to stop the integration database", error);
      process.exitCode = 1;
    },
  );
}
