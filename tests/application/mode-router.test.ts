import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ModeRoutingExecutor, type RoutedAgent } from "../../src/application/mode-router.js";
import type { AgentHarness, HarnessExecution } from "../../src/application/ports/agent-harness.js";
import type { TaskRecord } from "../../src/domain/schemas.js";
import { FakeProvider } from "../../src/infrastructure/providers/fake-provider.js";
import { createTaskSpec } from "../fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

interface FixtureOptions {
  verdict?: "pass" | "fail";
  modifyCandidate?: boolean;
  onReview?: (input: HarnessExecution, round: number) => void;
}

function fixtureHarness(options: FixtureOptions = {}): AgentHarness {
  return {
    kind: "fixture",
    async execute(input) {
      if (input.prompt.includes("independent reviewer in HeteMCP mutual-check mode")) {
        const round = input.prompt.includes("Review round: 2") ? 2 : 1;
        options.onReview?.(input, round);
        if (options.modifyCandidate) {
          const candidate = join(input.workspacePath, "candidate", "0-note.txt");
          await writeFile(candidate, "tampered", { flag: "a" });
        }
        await writeFile(
          join(input.workspacePath, "review.json"),
          JSON.stringify({
            verdict: options.verdict ?? "pass",
            summary: options.verdict === "fail" ? "Rejected by fixture" : "Accepted by fixture",
            findings: [],
          }),
        );
        return { status: "completed", exitCode: 0 };
      }
      const filename = /Create only (\S+) in the current workspace/.exec(input.prompt)?.[1];
      if (!filename) throw new Error("Fixture received an unexpected prompt");
      await writeFile(join(input.workspacePath, filename), "fixture candidate\n");
      return { status: "completed", exitCode: 0 };
    },
  };
}

function agents(...entries: [string, AgentHarness][]): RoutedAgent[] {
  return entries.map(([name, harness]) => ({
    name,
    kind: "fixture",
    harness,
    profile: "file-generation",
    acceptedProfiles: ["file-generation"],
  }));
}

async function artifactRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "heteromcp-modes-"));
  directories.push(directory);
  return directory;
}

describe("mode routing", () => {
  it("defaults to dispatch and can use the deterministic fake", async () => {
    const router = new ModeRoutingExecutor({
      agents: [],
      artifactRoot: await artifactRoot(),
      fake: new FakeProvider(),
    });
    const result = await router.execute({
      taskId: "task",
      attemptId: "attempt",
      spec: createTaskSpec(),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("succeeded");
    expect(router.describe().defaultMode).toBe("dispatch");
  });

  it("dispatches, reviews twice, and passes a workflow", async () => {
    const root = await artifactRoot();
    const reviews: number[] = [];
    const router = new ModeRoutingExecutor({
      agents: agents(
        ["writer", fixtureHarness()],
        ["reviewer-a", fixtureHarness({ onReview: (_, round) => reviews.push(round) })],
        ["reviewer-b", fixtureHarness({ onReview: (_, round) => reviews.push(round) })],
      ),
      artifactRoot: root,
      fake: new FakeProvider(),
    });
    const spec = createTaskSpec({
      workerProfile: "file-generation",
      worker: { agent: "writer" },
      allowedPaths: ["note.txt"],
      excludedPaths: [],
      acceptance: ["generated-file-scope", "mutual-check"],
      mode: "workflow",
      reviewers: [{ agent: "reviewer-a" }, { agent: "reviewer-b" }],
    });
    const result = await router.execute({
      taskId: "task",
      attemptId: "attempt",
      spec,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.reviews).toHaveLength(2);
    expect(result.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["generated-file-scope", "mutual-check"]),
    );
    expect(reviews.sort()).toEqual([1, 1, 2, 2]);
  });

  it("fails a workflow when any reviewer rejects", async () => {
    const router = new ModeRoutingExecutor({
      agents: agents(
        ["writer", fixtureHarness()],
        ["reviewer-a", fixtureHarness()],
        ["reviewer-b", fixtureHarness({ verdict: "fail" })],
      ),
      artifactRoot: await artifactRoot(),
      fake: new FakeProvider(),
    });
    const spec = createTaskSpec({
      workerProfile: "file-generation",
      worker: { agent: "writer" },
      allowedPaths: ["note.txt"],
      excludedPaths: [],
      acceptance: ["generated-file-scope", "mutual-check"],
      mode: "workflow",
      reviewers: [{ agent: "reviewer-a" }, { agent: "reviewer-b" }],
    });
    const result = await router.execute({
      taskId: "task",
      attemptId: "attempt",
      spec,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("MUTUAL_CHECK_FAILED");
    expect(result.reviews?.map((review) => review.verdict)).toEqual(["pass", "fail"]);
  });

  it("rejects a reviewer that modifies the candidate", async () => {
    const router = new ModeRoutingExecutor({
      agents: agents(
        ["writer", fixtureHarness()],
        ["reviewer-a", fixtureHarness({ modifyCandidate: true })],
      ),
      artifactRoot: await artifactRoot(),
      fake: new FakeProvider(),
    });
    const spec = createTaskSpec({
      workerProfile: "file-generation",
      worker: { agent: "writer" },
      allowedPaths: ["note.txt"],
      excludedPaths: [],
      acceptance: ["generated-file-scope", "mutual-check"],
      mode: "workflow",
      reviewers: [{ agent: "reviewer-a" }],
    });
    const result = await router.execute({
      taskId: "task",
      attemptId: "attempt",
      spec,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.checks.find((check) => check.name === "mutual-check")?.outcome).toBe("failed");
  });

  it("reviews an existing source task in mutual-check mode", async () => {
    const root = await artifactRoot();
    const writer = fixtureHarness();
    const router = new ModeRoutingExecutor({
      agents: agents(["writer", writer], ["reviewer-a", fixtureHarness()]),
      artifactRoot: root,
      fake: new FakeProvider(),
    });
    const dispatchSpec = createTaskSpec({
      workerProfile: "file-generation",
      worker: { agent: "writer" },
      allowedPaths: ["note.txt"],
      excludedPaths: [],
      acceptance: ["generated-file-scope"],
    });
    const dispatch = await router.execute({
      taskId: "source",
      attemptId: "attempt",
      spec: dispatchSpec,
      signal: new AbortController().signal,
    });
    const sourceTask: TaskRecord = {
      id: "00000000-0000-4000-8000-000000000099",
      idempotencyKey: "source",
      status: "succeeded",
      spec: dispatchSpec,
      revision: 3,
      attemptCount: 1,
      cancellationRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      result: dispatch,
    };
    const checkSpec = createTaskSpec({
      workerProfile: "mutual-check",
      mode: "mutual-check",
      sourceTaskId: sourceTask.id,
      reviewers: [{ agent: "reviewer-a" }],
      acceptance: ["mutual-check"],
    });
    const result = await router.execute({
      taskId: "check",
      attemptId: "attempt",
      spec: checkSpec,
      sourceTask,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("succeeded");
    expect(result.reviews).toHaveLength(1);
    const sourceBytes = await readFile(join(root, "source", "attempt", "workspace", "note.txt"));
    expect(sourceBytes.toString()).toBe("fixture candidate\n");
  });
});
