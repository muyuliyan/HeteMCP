import type { ModelProvider, ProviderExecution } from "../../application/ports/model-provider.js";
import type { AttemptResult, CapabilityCatalog } from "../../domain/schemas.js";

export class FakeProvider implements ModelProvider {
  public readonly name = "fake";

  public describe(): CapabilityCatalog {
    return {
      defaultMode: "dispatch",
      modes: ["dispatch", "mutual-check", "workflow"],
      agents: [
        {
          name: "fake",
          kind: "deterministic",
          profiles: ["fake"],
          available: true,
        },
      ],
    };
  }

  public execute({ taskId, attemptId, spec, signal }: ProviderExecution): Promise<AttemptResult> {
    signal.throwIfAborted();

    return Promise.resolve({
      status: "succeeded",
      summary: `Fake worker completed: ${spec.objective}`,
      artifacts: [{ kind: "log", uri: `memory://tasks/${taskId}/attempts/${attemptId}/log` }],
      checks: spec.acceptance.map((name) => ({
        name,
        outcome: "passed",
        evidence: "Verified by the deterministic fake provider",
      })),
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    });
  }
}
