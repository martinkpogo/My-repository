import type { Env } from "../types";
import type { AccessContext } from "../access";
import type { ResolvedActionSkillSet } from "../platform/skillRegistry";
import { executeProspectResearch, executeResearch } from "./research/executor";
import type { ResearchExecutionInput, ResearchOutcome, ResearchSynthesis } from "./research/types";

/**
 * Research as a Skill any Hat may use (Martin's decision, 2026-10-12).
 *
 * The research runtime is infrastructure; what makes an Action ABLE to use it
 * is declaring the `research_signal` Skill. These two entry points are the
 * only way a Unit runs research: each one takes the methodology from the
 * Action's own resolved Skill set, so an Action that did not declare
 * `research_signal` cannot run research at all -- `skills.get` throws
 * SkillResolutionError before anything is searched. No second trigger
 * mechanism: WHEN research runs is still the owning Hat's own step.
 *
 * The result is evidence for that Hat's output, never a decision: whatever
 * the Hat produces from it still goes to Martin for approval through that
 * Hat's existing approval gate.
 */
export async function runActionResearch(
  env: Env,
  skills: ResolvedActionSkillSet,
  input: Omit<ResearchExecutionInput, "skillContent">,
  access: AccessContext,
): Promise<ResearchOutcome> {
  const methodology = skills.get("research_signal");
  return executeResearch(env, { ...input, skillContent: methodology.content }, access);
}

/**
 * Lead Generation only: researches ONE screened, publicly-discovered prospect
 * organisation by name, under the lead.candidate_research_* task ids that
 * carry the narrow public-source company-name exemption. Never for an engaged
 * client -- client identity stays token-only through runActionResearch.
 */
export async function runProspectResearch(
  env: Env,
  skills: ResolvedActionSkillSet,
  input: Omit<ResearchExecutionInput, "skillContent">,
  access: AccessContext,
): Promise<ResearchOutcome> {
  const methodology = skills.get("research_signal");
  return executeProspectResearch(env, { ...input, skillContent: methodology.content }, access);
}

/**
 * A compact, source-linked digest of a completed synthesis for a Hat's own
 * output (a Telegram card, a diagnosis context). Findings keep their cited
 * sources; limitations are always kept, so a thin result reads as thin.
 * Bounded so a long synthesis never bloats a message or a later prompt.
 */
export function summarizeResearchSynthesis(synthesis: ResearchSynthesis, maxLength = 1500): string {
  const sourceUrl = new Map(synthesis.sources.map((s) => [s.id, s.url || s.source]));
  const evidenceSources = new Map(synthesis.evidence.map((e) => [e.id, e.sourceIds]));
  const findings = synthesis.findings.map((finding) => {
    const urls = [...new Set(finding.evidenceIds.flatMap((id) => evidenceSources.get(id) ?? []).map((id) => sourceUrl.get(id)).filter((u): u is string => Boolean(u)))];
    return `- ${finding.statement}${urls.length > 0 ? ` (${urls.slice(0, 2).join(", ")})` : ""}`;
  });
  const limitations = synthesis.limitations.map((l) => `- ${l.statement}`);
  const text = [
    findings.length > 0 ? `Findings:\n${findings.join("\n")}` : "Findings: none supported by the sources found.",
    limitations.length > 0 ? `Limitations:\n${limitations.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
