/**
 * Repo-native Skills (ENIG Operating Model, "Capabilities: Skills" --
 * migrated 2026-09-28 from the retired Notion-backed
 * fetchSkill/SkillDefinition arrangement). A Skill answers "how should
 * this type of work be performed" -- reusable methodology, independent
 * of which Unit/Hat uses it. Minimum contract, per the approved
 * architecture: a stable id + its methodology content. Nothing else --
 * the prior `SkillDefinition`'s `pageId`, `sensitivity`, `description`,
 * `requiredDataSources`, `requiredPrimitives`, `outputContract`, and
 * `validation` fields are dropped, not carried forward, because no
 * runtime code ever read any of them (confirmed by inspection before
 * this migration: only `id`/`pageId` were ever consumed, by the retired
 * `fetchSkill`, and only to resolve a Notion page -- a resolution this
 * repo-native model no longer needs).
 *
 * Content is copied verbatim from the three Notion pages this replaces
 * (ENIG HQ / 4. Skills / research-signal, opportunity-qualification-gate,
 * opportunity-forward-planning) -- unchanged wording, so AI behavior is
 * unaffected by this migration. `universal_role_contract` is deliberately
 * NOT included here: it was already unreachable through the old Skill
 * Registry (zero `fetchSkill("universal_role_contract")` callers found by
 * inspection -- every real consumer already calls `getGovernance`
 * directly with `UNIVERSAL_ROLE_CONTRACT_PAGE_ID`, unchanged by this
 * migration), and it does not fit this file's own definition of a Skill
 * (task-methodology, "how should this be performed") -- it's Kernel-
 * adjacent cross-cutting behavior, injected as `generate()`'s `behavior`
 * part, not `skillContent`. Nothing about it changes here.
 */

export type SkillId = "research_signal" | "opportunity_qualification_gate" | "opportunity_forward_planning";

const RESEARCH_SIGNAL = `\`\`\`yaml
skill_id: research-signal
status: canonical
purpose: >
  Interpret a piece of raw evidence about an external subject (an
  organisation, market, relationship, or discovered signal) and produce a
  disciplined, source-grounded account of what that evidence actually
  supports -- never what it merely suggests, implies, or could be read to
  mean under a generous interpretation.
\`\`\`

## Evidence discipline (the methodology itself)

1. **Only use evidence actually given.** Work strictly from the text/snippets/context supplied for this call -- never draw on outside knowledge, assumption, or general familiarity with the subject to fill a gap the evidence itself doesn't cover.
2. **Distinguish observation from diagnosis.** State only what the evidence directly shows (an observation) -- never convert that into a negative or positive verdict about the subject (a diagnosis) unless the evidence itself states the verdict. "Expanded into a new market but public messaging still describes the old one" is an observation; "this company has confused branding" is a diagnosis the evidence alone doesn't license.
3. **Never fabricate a specific fact.** A name, contact, decision-maker, statistic, date, or claim not present in the supplied evidence must never be invented, guessed, or inferred from role/context alone. If it isn't there, it isn't known.
4. **Name what's missing, don't guess it.** Where the evidence is silent on something relevant, say so explicitly as a gap or limitation -- never fill it with a plausible-sounding assumption.
5. **Attribute honestly.** Every claim traces to where it actually came from -- a named source, a supplied account, or explicitly "not sourced" if none exists. Never let a claim read as more independently verified than it actually is.
6. **A confident tone is not evidence.** The strength of a finding is set by what the evidence actually supports, never by how the finding is phrased or how plausible it sounds.

## What this Skill does not decide

This methodology governs *how the evidence is read* -- it does not decide:
- what the evidence is being read *for* (an opportunity signal, a partnership case, an acquisition-criteria pass/fail, a research brief) -- that shape belongs to the invoking action's own output contract, supplied as that call's own instruction alongside this methodology;
- whether the resulting output may be acted on without Martin's sign-off (approval requirement is the invoking action's declared property, never this Skill's);
- what data the caller was allowed to read in the first place (Data Source eligibility is resolved by the Kernel per invoking Hat, before this methodology is ever applied to it).

Two Hats invoking this Skill against different evidence, under different authority, reach different outputs -- the discipline above is what stays constant.`;

const OPPORTUNITY_QUALIFICATION_GATE = `\`\`\`yaml
skill_id: opportunity-qualification-gate
status: canonical
purpose: >
  Apply an evidence-sufficiency threshold to a body of gathered evidence
  about a candidate opportunity, relationship, or growth direction, and
  decide whether it has earned further investment of effort.
\`\`\`

## The threshold discipline (the methodology itself)

1. **The decision is about the evidence, not the enthusiasm.** Qualification must never be based on how promising something sounds, how confident the reasoning feels, or superficial fit with what ENIG does. It is based strictly on what the gathered evidence actually establishes.
2. **When required evidence is missing, hold -- never infer it.** If the evidence gathered so far genuinely isn't enough to judge either way, the correct outcome is to say so and name exactly what's still needed, never to fill the gap with a plausible guess so a decision can be reached.
3. **A negative indication is not the same as insufficient evidence.** Distinguish evidence that actively counsels against pursuing something from evidence that simply hasn't yet reached a threshold -- these are different outcomes, not the same "not ready" bucket.
4. **Ambiguity or a failed judgment fails closed, never toward the permissive outcome.** If the judgment itself cannot be completed (a provider failure, an unparsable response), the outcome must never default to the outcome that lets work proceed -- it defaults to holding for a retry.
5. **Naming what's missing is part of the decision, not an afterthought.** A hold decision is only useful if it says specifically what evidence would resolve it -- a vague "needs more evidence" is not a completed judgment.

## What this Skill does not decide

This methodology governs how the sufficiency judgment itself is reached -- it does not decide:
- what counts as required evidence for a *particular* subject (an opportunity vs. a partnership vs. a growth direction) -- that's the invoking action's own framing, supplied as that call's own instruction;
- what happens after a qualification outcome is reached (whether it pauses a session, what state it's written to, whether Martin is notified) -- that is the invoking action's own declared consequence and the Kernel's own execution machinery, never this Skill's concern.`;

const OPPORTUNITY_FORWARD_PLANNING = `\`\`\`yaml
skill_id: opportunity-forward-planning
status: canonical
purpose: >
  Draft a forward-looking plan or next action for an already-qualified
  opportunity, relationship, or growth direction, grounded strictly in
  what has actually been established about it so far.
\`\`\`

## The grounding discipline (the methodology itself)

1. **Build only from what's already established.** A forward plan (stakeholders, a value hypothesis, a route, dependencies, risks) or a recommended next action must be constructed only from the subject's own actual signal, gathered evidence, and qualification rationale -- never from what would typically be expected, or from filling a gap with a plausible default.
2. **Never invent a stakeholder, a route, a dependency, or a next action not implied by what's known.** If a plan element can't be derived from the established state, that element is stated as unknown or not yet determinable -- it is never fabricated to make the plan feel complete.
3. **Say plainly when something can't be determined yet.** A thin or incomplete plan that honestly reflects thin evidence is correct; a fuller-sounding plan manufactured to look complete is not.
4. **A drafted plan is a proposal, never a commitment.** This Skill's output is always a draft for review -- it never itself represents an executed decision, regardless of how concrete or confident it reads.
5. **Surface any human decision the plan depends on explicitly, rather than assuming it away.** If moving forward genuinely depends on a decision or approval beyond the plan itself, name that dependency directly instead of quietly presupposing it will go a particular way.

## What this Skill does not decide

This methodology governs how a forward plan or next-action recommendation is derived from established state -- it does not decide:
- the specific fields a particular plan must contain (stakeholders/value hypothesis/route vs. a single next action + rationale) -- that shape is the invoking action's own output contract, supplied as that call's own instruction;
- whether the resulting plan may be acted on without Martin's sign-off, or what gets committed if it's approved -- those are the invoking action's own declared consequence/approval and the Kernel's own execution machinery, never this Skill's concern.`;

const SKILL_CONTENT: Readonly<Record<SkillId, string>> = {
  research_signal: RESEARCH_SIGNAL,
  opportunity_qualification_gate: OPPORTUNITY_QUALIFICATION_GATE,
  opportunity_forward_planning: OPPORTUNITY_FORWARD_PLANNING,
};

/** Returns a Skill's methodology content by id -- a plain, synchronous lookup (no network call, no cache, no Env). `SkillId` is a closed union and `SKILL_CONTENT` a total map over it, so this can never fail at runtime; an unregistered id is a compile-time error, not a thing this function needs to guard against. */
export function getSkillContent(id: SkillId): string {
  return SKILL_CONTENT[id];
}
