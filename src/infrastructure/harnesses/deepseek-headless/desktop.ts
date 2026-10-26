import { join, resolve } from "node:path";

import { DeepSeekHeadlessAdapter } from "./adapter.js";

export function createDesktopHarness(options: {
  applicationDirectory: string;
  runtimeHome: string;
  credentialsPath: string;
  policyPatch: string;
}): DeepSeekHeadlessAdapter {
  const env: Record<string, string> = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PATH",
  ]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return new DeepSeekHeadlessAdapter({
    executable: join(resolve(options.applicationDirectory), "DeepSeek Harness.exe"),
    prefixArgs: [
      join(
        resolve(options.applicationDirectory),
        "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
      ),
    ],
    desktopLegacy: { version: "0.2.1-rc.2", policyPatch: resolve(options.policyPatch) },
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      DSH_HOME: resolve(options.runtimeHome),
      HETEMCP_CREDENTIALS_PATH: resolve(options.credentialsPath),
      DSH_PERMISSION_MODE: "workspace-write",
      DSH_TELEMETRY_DISABLED: "1",
    },
  });
}
