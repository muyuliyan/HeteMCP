import { DomainError } from "../domain/errors.js";
import { normalizeExecutionMode } from "../domain/schemas.js";
import type {
  AgentDescriptor,
  AgentRef,
  Artifact,
  AttemptResult,
  CapabilityCatalog,
  ExecutionMode,
  TaskSpec,
} from "../domain/schemas.js";

import {
  FileGenerationExecutor,
  genericFileGenerationProfile,
} from "./file-generation-executor.js";
import {
  MutualCheckExecutor,
  mutualCheckAcceptance,
  type ReviewerAgent,
} from "./mutual-check-executor.js";
import type { AgentHarness } from "./ports/agent-harness.js";
import type { TaskExecution, TaskExecutor } from "./ports/task-executor.js";

export interface RoutedAgent {
  name: string;
  kind: string;
  harness: AgentHarness;
  profile: string;
  acceptedProfiles: readonly string[];
  defaultModel?: string;
}

export interface ModeRouterOptions {
  agents: readonly RoutedAgent[];
  artifactRoot: string;
  fake?: TaskExecutor;
  defaultWorker?: string;
  allowExternalArtifacts?: boolean;
  // Registry descriptors for agents that are configured but unavailable.
  catalog?: readonly AgentDescriptor[];
}

type DispatchTarget = { kind: "fake" } | { kind: "agent"; agent: RoutedAgent };

// Dispatch, mutual-check and workflow share one deterministic routing layer.
// The caller selects a mode and concrete agents; code decides what runs and how
// results are combined. No mode silently degrades into a cheaper fallback.
export class ModeRoutingExecutor implements TaskExecutor {
  public readonly name = "heteromcp-mode-router";
  readonly #agents: ReadonlyMap<string, RoutedAgent>;
  readonly #artifactRoot: string;
  readonly #fake: TaskExecutor | undefined;
  readonly #defaultWorker: string | undefined;
  readonly #allowExternalArtifacts: boolean;
  readonly #catalog: readonly AgentDescriptor[];

  public constructor(options: ModeRouterOptions) {
    this.#agents = new Map(options.agents.map((agent) => [agent.name, agent]));
    this.#artifactRoot = options.artifactRoot;
    this.#fake = options.fake;
    this.#defaultWorker = options.defaultWorker;
    this.#allowExternalArtifacts = options.allowExternalArtifacts ?? false;
    this.#catalog = options.catalog ?? [];
  }

  public describe(): CapabilityCatalog {
    const agents: AgentDescriptor[] = [...this.#agents.values()].map((agent) => ({
      name: agent.name,
      kind: agent.kind,
      profiles: [...agent.acceptedProfiles],
      available: true,
      ...(agent.defaultModel ? { defaultModel: agent.defaultModel } : {}),
    }));
    for (const descriptor of this.#catalog) {
      if (!agents.some((agent) => agent.name === descriptor.name)) {
        agents.push({ ...descriptor });
      }
    }
    if (this.#fake && !agents.some((agent) => agent.name === "fake")) {
      agents.push({
        name: "fake",
        kind: "deterministic",
        profiles: ["fake"],
        available: true,
      });
    }
    agents.sort((left, right) => left.name.localeCompare(right.name));
    return {
      defaultMode: "dispatch",
      modes: ["dispatch", "mutual-check", "workflow"],
      agents,
    };
  }

  public execute(input: TaskExecution): Promise<AttemptResult> {
    return this.#executeMode(normalizeExecutionMode(input.spec.mode), input);
  }

  async #executeMode(mode: ExecutionMode, input: TaskExecution): Promise<AttemptResult> {
    if (mode === "dispatch") return this.#dispatch(input);
    if (mode === "mutual-check") {
      return this.#mutualCheck(input, input.sourceTask?.result?.artifacts ?? []);
    }
    return this.#workflow(input);
  }

  async #dispatch(input: TaskExecution): Promise<AttemptResult> {
    const target = this.#resolveDispatchTarget(input.spec);
    if (target.kind === "fake") {
      if (!this.#fake)
        throw new DomainError("AGENT_UNAVAILABLE", "Fake executor is not configured");
      return this.#fake.execute(input);
    }
    const executor = new FileGenerationExecutor(target.agent.harness, this.#artifactRoot, {
      profile: target.agent.profile,
      acceptedProfiles: target.agent.acceptedProfiles,
      agent: target.agent.name,
      ...(target.agent.defaultModel === undefined
        ? {}
        : { defaultModel: target.agent.defaultModel }),
    });
    return executor.execute(input);
  }

  async #mutualCheck(
    input: TaskExecution,
    sourceArtifacts: readonly Artifact[],
  ): Promise<AttemptResult> {
    const executor = new MutualCheckExecutor({
      agents: this.#reviewerAgents(),
      artifactRoot: this.#artifactRoot,
      allowExternalArtifacts: this.#allowExternalArtifacts,
    });
    return executor.execute({ ...input, sourceArtifacts });
  }

  async #workflow(input: TaskExecution): Promise<AttemptResult> {
    // The dispatch phase must not claim the mutual-check requirement itself.
    const dispatch = await this.#dispatch({
      ...input,
      spec: {
        ...input.spec,
        acceptance: input.spec.acceptance.filter((item) => item !== mutualCheckAcceptance),
      },
    });
    if (dispatch.status !== "succeeded") {
      return {
        ...dispatch,
        checks: [
          ...dispatch.checks,
          {
            name: mutualCheckAcceptance,
            outcome: "skipped",
            evidence: "Dispatch did not succeed, so mutual check was not attempted.",
          },
        ],
      };
    }

    const review = await this.#mutualCheck(input, dispatch.artifacts);
    return {
      status: review.status,
      summary: `${dispatch.summary} ${review.summary}`,
      artifacts: dedupeArtifacts([...dispatch.artifacts, ...review.artifacts]),
      checks: [...dispatch.checks, ...review.checks],
      ...(review.reviews === undefined ? {} : { reviews: review.reviews }),
      usage: {
        inputTokens: dispatch.usage.inputTokens + review.usage.inputTokens,
        outputTokens: dispatch.usage.outputTokens + review.usage.outputTokens,
        costMicros: dispatch.usage.costMicros + review.usage.costMicros,
        ...(dispatch.usage.measured === undefined && review.usage.measured === undefined
          ? {}
          : {
              measured: dispatch.usage.measured === true || review.usage.measured === true,
            }),
      },
      ...(review.error === undefined ? {} : { error: review.error }),
    };
  }

  #resolveDispatchTarget(spec: TaskSpec): DispatchTarget {
    if (spec.worker) {
      if (spec.worker.agent.toLowerCase() === "fake") {
        if (spec.workerProfile !== "fake") {
          throw new DomainError(
            "INVALID_MODE",
            `Agent fake does not accept workerProfile ${spec.workerProfile}`,
          );
        }
        return { kind: "fake" };
      }
      return this.#agentTarget(spec.worker, spec.workerProfile);
    }

    if (spec.workerProfile === "fake") return { kind: "fake" };
    if (spec.workerProfile === genericFileGenerationProfile) {
      if (!this.#defaultWorker) {
        throw new DomainError(
          "AGENT_UNAVAILABLE",
          `${spec.workerProfile} requires an explicit worker or HETEMCP_DEFAULT_WORKER`,
        );
      }
      if (this.#defaultWorker === "fake") return { kind: "fake" };
      return this.#agentTarget({ agent: this.#defaultWorker }, spec.workerProfile);
    }

    const suffix = "-file-generation";
    if (spec.workerProfile.endsWith(suffix)) {
      return this.#agentTarget(
        { agent: spec.workerProfile.slice(0, -suffix.length) },
        spec.workerProfile,
      );
    }

    throw new DomainError(
      "AGENT_NOT_FOUND",
      `No worker is configured for workerProfile ${spec.workerProfile}`,
    );
  }

  #agentTarget(ref: AgentRef, workerProfile: string): DispatchTarget {
    const agent = this.#agents.get(ref.agent.toLowerCase());
    if (!agent) {
      throw new DomainError("AGENT_NOT_FOUND", `Agent ${ref.agent} is not configured`);
    }
    if (!agent.acceptedProfiles.includes(workerProfile)) {
      throw new DomainError(
        "INVALID_MODE",
        `Agent ${agent.name} does not accept workerProfile ${workerProfile}`,
      );
    }
    return { kind: "agent", agent };
  }

  #reviewerAgents(): Map<string, ReviewerAgent> {
    return new Map(
      [...this.#agents.values()].map((agent) => [
        agent.name,
        {
          name: agent.name,
          harness: agent.harness,
          ...(agent.defaultModel === undefined ? {} : { defaultModel: agent.defaultModel }),
        },
      ]),
    );
  }
}

function dedupeArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.uri)) return false;
    seen.add(artifact.uri);
    return true;
  });
}
