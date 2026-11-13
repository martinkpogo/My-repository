import type { Env } from "../types";
import type { AiTask } from "../ai/types";
import type { ContextSegment, SemanticTaskId } from "../dataBoundary/types";
import { setTaskAugmenter } from "../ai/policy";
import { getGovernance } from "../governance";
import { reportLiveStep } from "./liveStatus";
import { WEB_RESEARCH_TASKS } from "./webResearch";

/**
 * Every Hat knows what ENIG is (Martin's decision, 2026-11-13). Before any
 * Hat's step, the canonical ENIG Consultancy Profile (ENIG HQ, LOG-1150) is
 * read live from Notion -- the business's own description of what it
 * solves, for whom and how -- and added to that step's prompt. Edits to the
 * Profile reach every Hat on its next step (governance cache, 15 minutes).
 *
 * It is ENIG's own self-description, never client data. If it cannot be
 * read, the step still runs and the live status says so: context, not a
 * condition (Martin's approval, 2026-11-13).
 */

export const CONSULTANCY_PROFILE_PAGE_ID = "401cb004-e583-8142-9e27-c3e7087b8546";
const MAX_PROFILE_CHARS = 8000;

/**
 * The Hat steps that receive it: every step that does a Hat's work -- the
 * web-research set plus the evidence-bound Hat steps (qualification and
 * Finance pricing), which need to know ENIG's specialization and terms.
 * Not routing/classification, extraction, Result verification or the
 * research engine's own steps.
 */
export const BUSINESS_CONTEXT_TASKS: ReadonlySet<SemanticTaskId> = new Set<SemanticTaskId>([
  ...WEB_RESEARCH_TASKS,
  "finance.quote_judgment",
  "sales.call_qualification",
  "sales.call_qualification_handoff",
]);

export async function augmentTaskWithBusinessContext(env: Env, task: AiTask): Promise<AiTask> {
  if (!BUSINESS_CONTEXT_TASKS.has(task.taskId)) return task;
  const profile = await getGovernance(env, CONSULTANCY_PROFILE_PAGE_ID, "ENIG Consultancy Profile");
  if (!profile) {
    console.error(`businessContext: the ENIG Consultancy Profile could not be read for ${task.taskId} -- the step runs without it`);
    reportLiveStep("Consultancy Profile unavailable (continuing without it)");
    return task;
  }
  const block = [
    "=== ENIG CONSULTANCY PROFILE (canonical, read live from Notion) ===",
    "This is ENIG's own description of itself: what ENIG solves, for whom, and how it works. Use it to understand the business you work for. It is not evidence about any client or Matter.",
    profile.slice(0, MAX_PROFILE_CHARS),
    "=== END ENIG CONSULTANCY PROFILE ===",
  ].join("\n");
  // No stamp of its own: the Profile is held to the step's own level, so adding it never lowers what the step may send where.
  const segment: ContextSegment = { type: "governance", content: block, provenance: "runtime:consultancy_profile" };
  const messages = [...task.messages];
  const i = messages.findIndex((m) => m.role === "system");
  if (i >= 0) messages[i] = { ...messages[i], content: `${messages[i].content}\n\n${block}` };
  else messages.unshift({ role: "system", content: block });
  return { ...task, messages, boundaryContext: { ...task.boundaryContext, segments: [...task.boundaryContext.segments, segment] } };
}

setTaskAugmenter("business_context", 10, augmentTaskWithBusinessContext);
