import type { Env } from "../types";
import { DataBoundaryEvaluator, createBoundaryAuditEntry, defaultDataBoundaryEvaluator } from "../dataBoundary/policy";
import { isSemanticTaskId } from "../dataBoundary/registry";
import { AiMessage, AiProvider, AiTask, CommonAiResponse } from "./types";
import { WorkersAiProvider } from "./workersai";
import { CEREBRAS_PROVIDER, GEMINI_PROVIDER, GROQ_PROVIDER, NVIDIA_NIM_PROVIDER, OPENROUTER_PROVIDER, SAMBANOVA_PROVIDER } from "./openaiCompatible";
import { redactIdentityTerms, findLeftoverBannedTerms } from "./identityRedaction";
import { sendMessage } from "../telegram";

// Fallback order: Workers AI first (it's the free baseline until its
// daily quota is hit), then the free-tier OpenAI-compatible providers.
// nvidia-nim is ordered last among the working providers -- confirmed
// live to reliably eat its full DEFAULT_PROVIDER_TIMEOUT_MS (12s) with
// zero observed successes on this account's only accessible model
// (openai/gpt-oss-20b), and with several sequential AI calls per user
// turn (R&I alone makes up to four), paying that latency tax early in
// the chain compounds badly. groq goes first among the fallbacks since
// it has been the fastest and most often successful. cerebras/sambanova
// stay last since both currently 402 outright (exhausted quota / no
// payment method) -- essentially free to try (fails instantly) but
// never worth ordering ahead of a provider that might actually answer.
// Each is a no-op in the fallback loop below unless its own API key
// secret is actually configured (see OpenAiCompatibleProvider.
// isEligible) -- adding a key later needs no code change here.
const DEFAULT_PROVIDERS: AiProvider[] = [
  new WorkersAiProvider(),
  GROQ_PROVIDER,
  OPENROUTER_PROVIDER,
  GEMINI_PROVIDER,
  NVIDIA_NIM_PROVIDER,
  CEREBRAS_PROVIDER,
  SAMBANOVA_PROVIDER,
];

export class AiPolicyExecutor {
  private providers: AiProvider[];
  private dataBoundaryEvaluator: DataBoundaryEvaluator;

  constructor(providers?: AiProvider[], dataBoundaryEvaluator?: DataBoundaryEvaluator) {
    this.providers = providers ?? DEFAULT_PROVIDERS;
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

      // Mandatory identity-redaction gate: applies to every provider, not
      // just workers-ai -- redacting the business name and Martin's name
      // costs nothing against a fully trusted provider, and the guarantee
      // is stronger for having no provider-conditional bypass. Redaction
      // is best-effort (a plain substitution can miss an unusual phrasing
      // in live-fetched Notion governance text), so it is never trusted
      // alone: the redacted messages are re-scanned immediately after, and
      // any leftover match is a hard stop, not a residual leak sent anyway.
      const redactedMessages: AiMessage[] = effectiveTask.messages.map((m) => ({
        ...m,
        content: redactIdentityTerms(m.content),
      }));
      const leftoverTerms = redactedMessages.flatMap((m) => findLeftoverBannedTerms(m.content));
      if (leftoverTerms.length > 0) {
        const uniqueTerms = [...new Set(leftoverTerms)];
        console.error(
          `AiPolicyExecutor: identity redaction verification failed for task ${task.taskId} on provider ${provider.id} -- leftover term(s): ${uniqueTerms.join(", ")}. Call blocked, not sent.`,
        );
        await sendMessage(
          env,
          Number(env.MARTIN_TELEGRAM_USER_ID),
          `⚠️ AI call blocked: identity redaction missed ${uniqueTerms.join(", ")} for task "${task.taskId}" (provider ${provider.id}). The prompt was NOT sent. This is a redaction-pattern gap in code, not a one-off -- it will keep blocking this task until fixed.`,
        ).catch((notifyErr) => console.error("Failed to notify Martin of identity redaction failure", notifyErr));
        return null;
      }
      effectiveTask = { ...effectiveTask, messages: redactedMessages };

      const result = await provider.execute(env, effectiveTask);
      if (result.success) {
        if (task.validateResponse && !task.validateResponse(result.response.rawText)) {
          const invalidAudit = createBoundaryAuditEntry(task.taskId, provider.id, "MATERIAL_PROVIDER_FAILURE", {
            reasonCode: "MALFORMED_RESPONSE",
            context: task.boundaryContext,
          });
          console.error(
            `AiPolicyExecutor: Provider ${provider.id} returned a response that failed shape validation for task ${task.taskId} [${invalidAudit.reasonCode}] -- trying next eligible provider.`,
          );
          // Fallback loop continues to next eligible provider -- a
          // malformed response is no more useful than no response.
          continue;
        }
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
