import type { Env } from "../types";
import { AI_TASK_LIVE_LABELS } from "./liveLabels";
import { DataBoundaryEvaluator, createBoundaryAuditEntry, defaultDataBoundaryEvaluator } from "../dataBoundary/policy";
import { isSemanticTaskId, SEMANTIC_TASK_REGISTRY } from "../dataBoundary/registry";
import { reportLiveStep, resolveLiveStep } from "../runtime/liveStatus";
import { AiMessage, AiProvider, AiTask, CommonAiResponse } from "./types";
import { WorkersAiProvider } from "./workersai";
import { GEMINI_PROVIDER, GROQ_PROVIDER, OPENROUTER_PROVIDER, SAMBANOVA_PROVIDER } from "./openaiCompatible";
import { redactIdentityTerms, findLeftoverBannedTerms } from "./identityRedaction";
import { OutboundDataGateEvaluator, defaultOutboundDataGateEvaluator, type OutboundGateReasonCategory } from "./outboundGate";
import { sendMessage } from "../telegram";

/**
 * WHY an AI call produced no usable response -- the distinction a plain
 * `null` erases. Codes only, never payload content.
 *
 * - `outbound_gate_blocked`: the Outbound Data Gate refused the payload
 *   (a policy judgement about the outgoing text, e.g. COMPANY_SUFFIX_DETECTED)
 * - `providers_exhausted`: no AI provider returned a usable result --
 *   infrastructure failures, boundary denials, no eligible provider, or
 *   the identity-redaction hard stop before any provider was reached
 * - `unparseable`: providers answered, but their output never passed shape
 *   validation for this call
 */
export type AiFailureCause = "outbound_gate_blocked" | "providers_exhausted" | "unparseable";

/**
 * The outcome-carrying twin of `executeTask`'s `CommonAiResponse | null`.
 * On failure, `gateReasons` carries the distinct Outbound Data Gate
 * `reasonCategory` CODES observed during the call (empty when the gate
 * never blocked anything) -- metadata only, never the detected text.
 */
export type AiCallOutcome =
  | { ok: true; response: CommonAiResponse }
  | { ok: false; cause: AiFailureCause; gateReasons: string[] };

// Fallback order: Workers AI first (it's the free baseline until its
// daily quota is hit), then the free-tier OpenAI-compatible providers.
// nvidia-nim is ordered last among the working providers -- confirmed
// live to reliably eat its full DEFAULT_PROVIDER_TIMEOUT_MS (12s) with
// zero observed successes on this account's only accessible model
// (openai/gpt-oss-20b), and with several sequential AI calls per user
// turn (the research runtime alone makes up to four), paying that latency tax early in
// the chain compounds badly. groq goes first among the fallbacks since
// it has been the fastest and most often successful. cerebras/sambanova
// stay last since both currently 402 outright (exhausted quota / no
// payment method) -- essentially free to try (fails instantly) but
// never worth ordering ahead of a provider that might actually answer.
// Each is a no-op in the fallback loop below unless its own API key
// secret is actually configured (see OpenAiCompatibleProvider.
// isEligible) -- adding a key later needs no code change here.
//
// Martin's decision, 2026-11-14 (free-tier optimisation, option A):
// nvidia-nim and cerebras are OUT of the chain. Neither answered once in
// the live logs (nvidia timed out every call; cerebras returns 402 payment
// required), and every failed try cost up to 12 s and part of the run's
// 50-subrequest budget -- the budget a research run then ran out of. Their
// adapters stay in openaiCompatible.ts, so restoring either is a one-line
// change once it works (cerebras billing; a model nvidia actually serves).
// sambanova stays: it fails only on a rejected key, which Martin can renew.
const DEFAULT_PROVIDERS: AiProvider[] = [
  new WorkersAiProvider(),
  GROQ_PROVIDER,
  OPENROUTER_PROVIDER,
  GEMINI_PROVIDER,
  SAMBANOVA_PROVIDER,
];

/** The providers in the fallback chain, in order (exported for tests). */
export const DEFAULT_PROVIDER_IDS: readonly string[] = DEFAULT_PROVIDERS.map((p) => p.id);

export class AiPolicyExecutor {
  private providers: AiProvider[];
  private dataBoundaryEvaluator: DataBoundaryEvaluator;
  private outboundDataGateOverride?: OutboundDataGateEvaluator;

  constructor(providers?: AiProvider[], dataBoundaryEvaluator?: DataBoundaryEvaluator, outboundDataGate?: OutboundDataGateEvaluator) {
    this.providers = providers ?? DEFAULT_PROVIDERS;
    this.dataBoundaryEvaluator = dataBoundaryEvaluator ?? defaultDataBoundaryEvaluator;
    this.outboundDataGateOverride = outboundDataGate;
  }

  /**
   * The gate this executor evaluates with, resolved on use rather than in the
   * constructor.
   *
   * `defaultPolicyExecutor` is built at module scope below, and this module
   * sits in the cycle src/access.ts -> src/units/registry.ts -> every Unit
   * manifest -> src/ai (this file) -> src/ai/outboundGate.ts -> src/governance.ts
   * -> src/notion.ts -> src/access.ts. Reading the default gate's binding while
   * that cycle is still being entered would leave it in its temporal dead zone,
   * so the default is resolved at first evaluate instead. An explicitly
   * injected gate still wins, exactly as before -- only when one was omitted
   * does this fall back to the module default.
   */
  private get outboundDataGate(): OutboundDataGateEvaluator {
    return this.outboundDataGateOverride ?? defaultOutboundDataGateEvaluator;
  }

  /**
   * Executes an AI task against eligible providers in deterministic order.
   * Mandates explicit task identity and data-boundary evaluation seam.
   * Evaluates every provider candidate independently against data boundary policy.
   * Falls back to eligible secondary providers ONLY upon InfrastructureError AND data boundary approval.
   * Fails closed if no eligible provider remains, data boundary policy denies execution, or all fail.
   *
   * Behaviour is unchanged for every existing caller: this is now a thin
   * delegate over executeTaskWithOutcome, returning the response exactly
   * when that outcome is ok and `null` for exactly the failure cases that
   * outcome classifies. Callers that need to know WHY nothing usable came
   * back call executeTaskWithOutcome directly.
   */
  public async executeTask(
    env: Env,
    task: AiTask,
  ): Promise<CommonAiResponse | null> {
    const outcome = await this.executeTaskWithOutcome(env, task);
    return outcome.ok ? outcome.response : null;
  }

  /**
   * The same provider loop as executeTask (which delegates here -- every
   * eligibility check, boundary evaluation, redaction verification, gate
   * evaluation, validation and log line is shared, never duplicated), but
   * reports the CAUSE of a failed call instead of collapsing it to `null`.
   *
   * Per-call classification over all provider attempts:
   * - `outbound_gate_blocked` -- every provider the call actually processed
   *   was refused by the Outbound Data Gate (no provider executed, none
   *   returned malformed output, none failed infrastructurally);
   * - `unparseable` -- at least one provider returned output that failed
   *   shape validation, and nothing in the call failed infrastructurally;
   * - `providers_exhausted` -- everything else (infrastructure failures,
   *   data-boundary denials, no eligible provider, an invalid task, or the
   *   identity-redaction hard stop that never reaches a provider at all).
   *
   * `gateReasons` holds the distinct `reasonCategory` CODES the gate
   * reported during the call, whichever cause is returned -- metadata
   * only, never the detected payload text.
   */
  public async executeTaskWithOutcome(
    env: Env,
    task: AiTask,
  ): Promise<AiCallOutcome> {
    if (!task || !task.taskId || !isSemanticTaskId(task.taskId) || !task.boundaryContext) {
      console.error("AiPolicyExecutor: Task missing valid taskId or boundaryContext");
      return { ok: false, cause: "providers_exhausted", gateReasons: [] };
    }
    for (const [id, { fn }] of [...taskAugmenters.entries()].sort((a, b) => a[1].order - b[1].order)) {
      try {
        task = await fn(env, task);
      } catch (err) {
        // Context and research are aids to the step, never conditions of it.
        console.error(`AiPolicyExecutor: task augmenter "${id}" failed -- continuing without it`, err);
      }
    }
    // Universal live status: the registered task's fixed name, never the prompt.
    reportLiveStep(AI_TASK_LIVE_LABELS[task.taskId] ?? `Thinking (${SEMANTIC_TASK_REGISTRY[task.taskId].name})`);

    return this.runProviderChain(env, task, this.providers, true);
  }

  /**
   * The provider loop itself, shared by the first pass and by the last-resort
   * retry below, so every eligibility check, boundary evaluation, redaction
   * verification, gate evaluation and validation applies identically to both.
   */
  private async runProviderChain(env: Env, task: AiTask, providers: AiProvider[], allowLastResort: boolean): Promise<AiCallOutcome> {
    const eligible = providers.filter((p) => p.isEligible(env, task));
    if (eligible.length === 0) {
      console.error("AiPolicyExecutor: No eligible AI provider available");
      return { ok: false, cause: "providers_exhausted", gateReasons: [] };
    }

    const attempted = new Set<string>();
    // Per-call failure accounting for the outcome classification: providers
    // actually processed (after the duplicate-id skip), how each failed, and
    // the distinct gate reason CODES seen -- never payload content.
    let processed = 0;
    let gateBlocked = 0;
    let malformed = 0;
    let infraFailures = 0;
    let redactionAborted = false;
    // Providers that failed on a rate limit and named how long to wait.
    const waitCandidates: Array<{ provider: AiProvider; waitMs: number }> = [];
    const gateReasons = new Set<OutboundGateReasonCategory>();

    for (const provider of eligible) {
      if (attempted.has(provider.id)) {
        continue;
      }
      attempted.add(provider.id);
      processed++;

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
        // Hard stop, exactly as executeTask always behaved: no further
        // provider is tried. The precise notification above already
        // explains why; for the outcome this is "no provider returned a
        // usable result" (an infrastructure/pattern failure, never an
        // evidence judgement).
        redactionAborted = true;
        break;
      }
      effectiveTask = { ...effectiveTask, messages: redactedMessages };

      // Outbound Data Gate: the centralized, fail-closed final check on the
      // ACTUAL effective (post-transform, post-redaction) messages, run
      // for every provider attempt in the fallback loop -- a fallback
      // provider never bypasses this. Never trusts a provider or the task
      // succeeding as license to skip it; blocks and moves on (never
      // silently redacts/changes the payload) whenever this exact payload
      // isn't established as permitted for this task's declared outbound
      // policy. No provider.execute() call is reached for a blocked
      // attempt.
      const gateResult = this.outboundDataGate.evaluate(task.taskId, provider.id, effectiveTask.messages);
      if (!gateResult.allowed) {
        gateBlocked++;
        gateReasons.add(gateResult.reasonCategory);
        console.warn(
          `AiPolicyExecutor: Outbound Data Gate blocked provider ${provider.id} for task ${task.taskId} [${gateResult.reasonCategory}] (policy: ${gateResult.policy}, detector: ${gateResult.detectorClassification}). Call not sent to this provider.`,
        );
        continue;
      }

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
          malformed++;
          continue;
        }
        return { ok: true, response: result.response };
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
      infraFailures++;
      if (result.error.retryAfterMs !== undefined) waitCandidates.push({ provider, waitMs: result.error.retryAfterMs });
    }

    if (!redactionAborted) {
      console.error("AiPolicyExecutor: All eligible AI providers exhausted without success");
    }

    // Last resort (Martin's decision, 2026-11-13, option A): every provider
    // failed, but a rate-limited one named how long to wait -- a few seconds
    // against a minute-long window that a burst of calls (a research run's
    // steps) used up. Wait it out and try THAT provider once more, through
    // the same checks, rather than failing the whole step. Only a wait up to
    // LAST_RESORT_MAX_WAIT_MS; only once per call; never when the loop was
    // stopped by the redaction hard stop.
    if (allowLastResort && !redactionAborted) {
      const candidate = waitCandidates.filter((c) => c.waitMs <= LAST_RESORT_MAX_WAIT_MS).sort((a, b) => a.waitMs - b.waitMs)[0];
      if (candidate) {
        const waitMs = candidate.waitMs + LAST_RESORT_MARGIN_MS;
        console.warn(`AiPolicyExecutor: last resort -- waiting ${waitMs}ms for ${candidate.provider.id}'s rate limit, then trying it once more for task ${task.taskId}`);
        await countDownLiveStep(waitMs, AI_TASK_LIVE_LABELS[task.taskId] ?? `Thinking (${SEMANTIC_TASK_REGISTRY[task.taskId].name})`);
        const retried = await this.runProviderChain(env, task, [candidate.provider], false);
        if (retried.ok) return retried;
      }
    }
    const reasons = [...gateReasons];
    if (gateBlocked > 0 && gateBlocked === processed) {
      return { ok: false, cause: "outbound_gate_blocked", gateReasons: reasons };
    }
    if (malformed > 0 && infraFailures === 0) {
      return { ok: false, cause: "unparseable", gateReasons: reasons };
    }
    return { ok: false, cause: "providers_exhausted", gateReasons: reasons };
  }
}

/**
 * The longest rate-limit wait the last resort will sit out, and the margin
 * added to a provider's stated wait (Martin's decision, 2026-11-13). Raised
 * from 30s to 60s (Martin, 2026-11-14): Groq's limit is a rolling one-minute
 * window, so after a research run it asked for 33s and the draft failed; it
 * can never ask for more than about a minute.
 */
export const LAST_RESORT_MAX_WAIT_MS = 60_000;
const LAST_RESORT_MARGIN_MS = 500;
/** How often the countdown line is edited (Martin, 2026-11-13: in place, inside the existing edit budget). */
export const COUNTDOWN_TICK_MS = 5_000;

function waitLabel(ms: number): string {
  return `Waiting ${Math.ceil(ms / 1000)}s for an AI provider's rate limit`;
}

/**
 * Waits `waitMs`, showing a countdown on the live status line that is edited
 * in place every COUNTDOWN_TICK_MS ("Waiting 26s..." -> "Waiting 21s..."),
 * then puts the line back to the step's own wording as the retry starts.
 * Edits go through the live status's own throttle and budget.
 */
async function countDownLiveStep(waitMs: number, stepLabel: string): Promise<void> {
  let label = waitLabel(waitMs);
  reportLiveStep(label);
  let remaining = waitMs;
  while (remaining > 0) {
    const tick = Math.min(COUNTDOWN_TICK_MS, remaining);
    await new Promise((resolve) => setTimeout(resolve, tick));
    remaining -= tick;
    const next = remaining > 0 ? waitLabel(remaining) : stepLabel;
    resolveLiveStep(label, next);
    label = next;
  }
}

export const defaultPolicyExecutor = new AiPolicyExecutor();

/**
 * The Runtime services every AI call passes through before any provider is
 * tried, in ascending `order`: the shared Consultancy Profile context
 * (src/runtime/businessContext.ts, order 10, Martin 2026-11-13) and the
 * universal web research tool (src/runtime/webResearch.ts, order 20, Martin
 * 2026-11-11). Each module installs itself, so this layer stays free of
 * runtime imports. The augmented task still goes through every boundary,
 * gate and validation below; a failing augmenter is skipped, never fatal.
 */
type TaskAugmenter = (env: Env, task: AiTask) => Promise<AiTask>;
const taskAugmenters = new Map<string, { order: number; fn: TaskAugmenter }>();
export function setTaskAugmenter(id: string, order: number, fn: TaskAugmenter | undefined): void {
  if (fn) taskAugmenters.set(id, { order, fn });
  else taskAugmenters.delete(id);
}
