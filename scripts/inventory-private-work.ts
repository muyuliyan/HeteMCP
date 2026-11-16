import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = join(repositoryRoot, ".heteromcp");
const traceName = /(^|[-_.])(mla|nsa)([-_.]|$)/i;

interface EntrySummary {
  path: string;
  kind: "file" | "directory";
  files: number;
  bytes: number;
}

const entries: EntrySummary[] = [];
for (const directory of [
  privateRoot,
  join(repositoryRoot, "docs"),
  join(repositoryRoot, "skill"),
]) {
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const child of children) {
    if (!traceName.test(child.name) && child.name !== "archive") continue;
    const fullPath = join(directory, child.name);
    entries.push(await summarize(fullPath));
  }
}

entries.sort((left, right) => left.path.localeCompare(right.path));
const totalFiles = entries.reduce((sum, entry) => sum + entry.files, 0);
const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
const manifest = {
  generatedAt: new Date().toISOString(),
  policy:
    "Private experiment traces stay under .heteromcp/ or are matched by ignore rules; they are never tracked by Git.",
  root: ".heteromcp",
  guard: "npm run check:private",
  entries,
  totalFiles,
  totalBytes,
};

const manifestPath = join(privateRoot, "private-work-manifest.json");
const reportPath = join(privateRoot, "PRIVATE-WORK.md");
await mkdir(privateRoot, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const rows = entries
  .map(
    (entry) =>
      `| \`${entry.path}\` | ${entry.kind} | ${String(entry.files)} | ${String(entry.bytes)} |`,
  )
  .join("\n");
const report = `# Private Work Inventory

Generated: ${manifest.generatedAt}

This file and the indexed material are local only. \`.heteromcp/\` is ignored by Git;
\`npm run check:private\` fails if any tracked path matches the private workload patterns.
Live experiment directories were **not moved** because prior task records, scripts and
archives may reference their current paths.

| Path | Kind | Files | Bytes |
| ---- | ---- | ----: | ----: |
${rows}
| **total** |  | **${String(totalFiles)}** | **${String(totalBytes)}** |
`;
await writeFile(reportPath, report, "utf8");

console.log(
  `Private work inventory: ${String(entries.length)} entries, ${String(totalFiles)} files, ${String(totalBytes)} bytes`,
);
console.log(`- ${relative(repositoryRoot, manifestPath).replaceAll("\\", "/")}`);
console.log(`- ${relative(repositoryRoot, reportPath).replaceAll("\\", "/")}`);

async function summarize(path: string): Promise<EntrySummary> {
  const metadata = await lstat(path);
  if (metadata.isFile()) {
    return {
      path: relative(repositoryRoot, path).replaceAll("\\", "/"),
      kind: "file",
      files: 1,
      bytes: metadata.size,
    };
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return {
      path: relative(repositoryRoot, path).replaceAll("\\", "/"),
      kind: "file",
      files: 0,
      bytes: 0,
    };
  }

  let files = 0;
  let bytes = 0;
  const children = await readdir(path, { withFileTypes: true });
  for (const child of children) {
    const childPath = join(path, child.name);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      const nested = await summarize(childPath);
      files += nested.files;
      bytes += nested.bytes;
    } else if (child.isFile()) {
      const nested = await lstat(childPath);
      files += 1;
      bytes += nested.size;
    }
  }
  return {
    path: relative(repositoryRoot, path).replaceAll("\\", "/"),
    kind: "directory",
    files,
    bytes,
  };
}
