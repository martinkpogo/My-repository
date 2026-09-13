import type { Env } from "../types";
import { DataBoundaryEvaluator, createBoundaryAuditEntry, defaultDataBoundaryEvaluator } from "../dataBoundary/policy";
import { isSemanticTaskId } from "../dataBoundary/registry";
import { AiMessage, AiProvider, AiTask, CommonAiResponse } from "./types";
import { WorkersAiProvider } from "./workersai";

export class AiPolicyExecutor {
  private providers: AiProvider[];
  private dataBoundaryEvaluator: DataBoundaryEvaluator;

  constructor(providers?: AiProvider[], dataBoundaryEvaluator?: DataBoundaryEvaluator) {
    this.providers = providers ?? [new WorkersAiProvider()];
    this.dataBoundaryEvaluator = dataBoundaryEvaluator ?? defaultDataBoundaryEvaluator;
  }

  /**
   * Executes an AI task against eligible providers in deterministic order.
   * Mandates explicit task identity and data-boundary evaluation seam.
   * Evaluates every provider candidate independently against data boundary policy.
   * Falls back to eligible secondary providers ONLY upon InfrastructureError AND data boundary approval.
   * Fails closed if no eligible provider remains, data boundary policy denies execution, or all fail.
   */
  public async executeTask(
    env: Env,
    task: AiTask,
  ): Promise<CommonAiResponse | null> {
    if (!task || !task.taskId || !isSemanticTaskId(task.taskId) || !task.boundaryContext) {
      console.error("AiPolicyExecutor: Task missing valid taskId or boundaryContext");
      return null;
    }

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

      // Data Boundary Seam: Evaluates provider independently against data boundary policy
      const boundaryEval = this.dataBoundaryEvaluator.evaluate(
        task.taskId,
        provider.id,
        task.boundaryContext,
      );

      // Audit boundary evaluation (non-sensitive metadata only)
      const auditEntry = createBoundaryAuditEntry(task.taskId, provider.id, "BOUNDARY_EVALUATION", {
        allowed: boundaryEval.allowed,
        reasonCode: boundaryEval.reasonCode,
        context: task.boundaryContext,
      });
      // Non-sensitive audit logging
      if (!boundaryEval.allowed) {
        console.warn(
          `AiPolicyExecutor: Data boundary denied provider ${provider.id} for task ${task.taskId} [${auditEntry.reasonCode}]: ${boundaryEval.reason}`,
        );
        // Continue fallback loop to check if any other provider is boundary-eligible
        continue;
      }

      // If transformed context is provided, construct effective task with transformed messages
      let effectiveTask = task;
      if (boundaryEval.transformedContext && boundaryEval.transformedContext.segments.length > 0) {
        const transformedMessages: AiMessage[] = boundaryEval.transformedContext.segments.map((seg) => ({
          role: seg.type === "system" || seg.type === "governance" ? "system" : "user",
          content: seg.content,
        }));
        effectiveTask = {
          ...task,
          messages: transformedMessages,
        };
      }

      const result = await provider.execute(env, effectiveTask);
      if (result.success) {
        return result.response;
      }

      // Material provider failure logging (metadata only)
      const failureAudit = createBoundaryAuditEntry(task.taskId, provider.id, "MATERIAL_PROVIDER_FAILURE", {
        reasonCode: result.error.code || "INFRASTRUCTURE_ERROR",
        context: task.boundaryContext,
        errorDetails: {
          statusCode: result.error.statusCode,
          errorCode: result.error.code,
          message: result.error.message,
        },
      });

      console.error(
        `AiPolicyExecutor: Provider ${provider.id} failed with infrastructure error [${failureAudit.reasonCode}]: ${result.error.message}`,
      );
      // Fallback loop continues to next eligible provider
    }

    console.error("AiPolicyExecutor: All eligible AI providers exhausted without success");
    return null;
  }
}

export const defaultPolicyExecutor = new AiPolicyExecutor();
