import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { taskRecordSchema } from "../src/domain/schemas.js";

const recordPath = process.argv[2];
if (!recordPath) throw new Error("Usage: tsx scripts/verify-bubble.ts <run.json> [--publish]");
const raw: unknown = JSON.parse(await readFile(recordPath, "utf8"));
const task = taskRecordSchema.parse(raw);
if (task.status !== "succeeded") throw new Error("Generation did not succeed");
const source = task.result?.artifacts.find((a) => a.kind === "source");
if (!source?.sha256) throw new Error("Missing hashed source artifact");
const sourcePath = fileURLToPath(source.uri);
const bytes = await readFile(sourcePath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== source.sha256) throw new Error("Source changed since generation");
const output = join(dirname(dirname(sourcePath)), "bubble.exe");
const compiler = process.env.HETEMCP_CXX ?? "g++";
const compilerArgs = [
  "-std=c++17",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-pedantic",
  sourcePath,
  "-o",
  output,
];
const compiled = spawnSync(compiler, compilerArgs, {
  encoding: "utf8",
  timeout: 30_000,
  maxBuffer: 64 * 1024,
  windowsHide: true,
  shell: false,
});
if (compiled.error || compiled.status !== 0) {
  throw new Error(`Compilation failed: ${compiled.error?.message ?? compiled.stderr}`);
}
const cases: number[][] = [
  [],
  [1],
  [5, 4, 3, 2, 1],
  [-3, -1, 0, 2],
  [3, 3, 1, -1, 0, 3],
  [2147483647, -2147483648, 0],
  [2, 2, 2],
];
let seed = 17;
for (let test = 0; test < 50; test++) {
  const values: number[] = [];
  for (let i = 0; i < test; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values.push((seed % 2001) - 1000);
  }
  cases.push(values);
}
for (const values of cases) {
  const result = spawnSync(output, [], {
    input: `${String(values.length)}\n${values.join(" ")}\n`,
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  const expected = [...values].sort((a, b) => a - b).join(" ") + "\n";
  if (result.error || result.status !== 0 || result.stdout.replaceAll("\r\n", "\n") !== expected) {
    throw new Error(`Behavior failed for input ${JSON.stringify(values)}`);
  }
}
for (const input of ["-1\n", "3\n1 2\n", "1\nnot-a-number\n"]) {
  const result = spawnSync(output, [], {
    input,
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status === null || result.status === 0)
    throw new Error("Invalid input accepted");
}
const report = {
  taskId: task.id,
  attemptId: task.attemptId,
  sourceSha256: sha256,
  compiler,
  compilerArgs,
  compileExitCode: compiled.status,
  validCases: cases.length,
  invalidCases: 3,
  outcome: "passed",
  target: resolve("test/bubble.cpp"),
  published: false,
};
if (process.argv.includes("--publish")) {
  const targetInfo = await stat(report.target).catch(() => undefined);
  if (targetInfo && targetInfo.size !== 0) throw new Error("Refusing to replace a nonempty target");
  await copyFile(sourcePath, report.target);
  const publishedHash = createHash("sha256")
    .update(await readFile(report.target))
    .digest("hex");
  if (publishedHash !== sha256) throw new Error("Published bytes do not match worker artifact");
  report.published = true;
}
await writeFile(
  join(dirname(dirname(sourcePath)), "supervisor-verification.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
