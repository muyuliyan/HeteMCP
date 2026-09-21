import type { ModelProvider, ProviderExecution } from "../../application/ports/model-provider.js";
import type { AttemptResult } from "../../domain/schemas.js";

export class FakeProvider implements ModelProvider {
  public readonly name = "fake";

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
