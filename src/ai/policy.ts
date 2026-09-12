import type { Env } from "../types";
import { AiProvider, AiTask, CommonAiResponse } from "./types";
import { WorkersAiProvider } from "./workersai";

export class AiPolicyExecutor {
  private providers: AiProvider[];

  constructor(providers?: AiProvider[]) {
    this.providers = providers ?? [new WorkersAiProvider()];
  }

  /**
   * Executes an AI task against eligible providers in deterministic order.
   * Falls back to eligible secondary providers ONLY upon InfrastructureError.
   * Fails closed if no eligible provider remains or all fail.
   */
  public async executeTask(
    env: Env,
    task: AiTask,
  ): Promise<CommonAiResponse | null> {
    const eligible = this.providers.filter((p) => p.isEligible(env, task));
    if (eligible.length === 0) {
      console.error("AiPolicyExecutor: No eligible AI provider available");
      return null;
    }

    const attempted = new Set<string>();

    for (const provider of eligible) {
      if (attempted.has(provider.id)) {
        continue;
      }
      attempted.add(provider.id);

      const result = await provider.execute(env, task);
      if (result.success) {
        return result.response;
      }

      console.error(
        `AiPolicyExecutor: Provider ${provider.id} failed with infrastructure error: ${result.error.message}`,
      );
      // Fallback loop continues to next eligible provider
    }

    console.error("AiPolicyExecutor: All eligible AI providers exhausted without success");
    return null;
  }
}

export const defaultPolicyExecutor = new AiPolicyExecutor();
