import { execFileSync } from "node:child_process";

// Filename-only guard: public docs may describe the policy, but no tracked path may
// contain a private workload name or live runtime directory.
const forbidden = [
  /(^|\/)\.heteromcp(\/|$)/i,
  new RegExp(String.raw`(^|/)(mla|nsa)([-_.]|/|$)`, "i"),
];

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations = tracked.filter((path) => forbidden.some((pattern) => pattern.test(path)));

if (violations.length > 0) {
  console.error("Private workload traces must not be tracked by Git:");
  for (const path of violations) console.error(`- ${path}`);
  console.error(
    "Remove them from the index (git rm --cached <path>), keep them under .heteromcp/, and verify .gitignore.",
  );
  process.exit(1);
}

console.log(`Private trace guard passed (${String(tracked.length)} tracked paths checked).`);
