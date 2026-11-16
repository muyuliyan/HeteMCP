import { spawn } from "node:child_process";
import { join } from "node:path";

// Terminate the whole process tree so a cancelled harness cannot leave children running.
export async function terminateTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Use the OS tool's absolute path, never a PATH entry supplied to the worker.
    const root = process.env.SystemRoot ?? "C:\\Windows";
    await new Promise<void>((resolve) => {
      const killer = spawn(
        join(root, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
        },
      );
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* The process group may have exited already. */
    }
  }
}
