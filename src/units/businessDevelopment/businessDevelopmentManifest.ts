import type { Env, WorkState, Unit } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { BDOpportunityState } from "./types";
import type { HatManifest, UnitManifest, ApprovalCallbackHandler } from "../unitManifest";
import { createHandoff } from "../../handoffWriter";
import { mintApprovalProofForWork, workSessionContext } from "../../access";
import { recordWorkAction } from "../dispatch";
import { title, richText, select } from "../../notion";
import { sendWorkspaceHatMessage } from "../../telegram";
import { logActivity } from "../../log";
import { generate } from "../../ai";
import { getSkillContent } from "../../platform/skillRegistry";

/**
 * Business Development's Unit Manifest -- the first Unit built entirely
 * on the manifest/registry pattern (ENIG Operating Model design doc,
 * "Business Development as conformance test"). NOT yet wired into
 * dispatchCowork/WorkSession/handleTextReply -- this is the manifest
 * itself, built from the real Hat Definitions already in Notion (ENIG HQ
 * / 2. Units & Hats / Units / Business Development), so it reflects real
 * requirements rather than a theoretical schema.
 *
 * All three Hats share one action shape (discover -> research -> assess
 * -> qualify -> develop -> determine_next_move -> handoff_to_sales /
 * handoff_to_strategy) with domain-specific action names per Hat, which
 * is exactly why action resolution must be scoped per Hat (see
 * unitManifest.ts's doc comment) -- `determine_next_move`,
 * `handoff_to_sales`, and `handoff_to_strategy` are literally the same
 * name on all three Hats.
 *
 * CONSEQUENCE LEVELS (per Architect's Action Registry correction --
 * see actionRegistry.ts): discover/research/assess are "read" (no
 * persisted state). qualify_* is "internal" -- it needs a WorkSession to
 * pause on Held/missing-evidence and resume later, but that is execution
 * state, not a privileged commitment, so it never requires approval.
 * develop_* / determine_next_move / handoff_to_sales / handoff_to_strategy
 * are "write" with requiresApproval: true -- these commit real direction or
 * cross a Unit boundary, so they gate on Martin's sign-off before being
 * final. This is BD's own conformance-test proof that internal and write
 * are genuinely different gates, not a relabeled binary.
 *
 * STATUS: all three Hats -- Opportunity Development, Partnership
 * Development, and Growth & Market Development -- are fully built out:
 * every action on all three has real implementation. Opportunity
 * Development and Partnership Development's discover/research/assess/
 * qualify/develop tasks are classified business_sensitive in
 * PRODUCTION_TASK_SENSITIVITY (Architect-approved). Growth & Market
 * Development's five equivalent tasks (discover_growth_opportunity,
 * research_market, assess_market_opportunity, qualify_growth_opportunity,
 * develop_growth_opportunity) are registered but NOT yet classified --
 * pending Architect review, same as every new BD task before it; they
 * fail closed (UNRESOLVED_POLICY_HOLD) until classified.
 *
 * The write-action plumbing (handoff_to_sales/handoff_to_strategy,
 * develop_*, determine_next_move) is generic across all Hats built on
 * this pattern -- proposeBDHandoff/handleBDHandoffApproval,
 * proposeBDDevelopment/handleBDDevelopApproval, and
 * proposeNextMove/handleBDNextMoveApproval all derive the calling Hat's
 * identity from state.hat (set by dispatch.ts's Hat resolution) rather
 * than a hardcoded per-Hat constant, so Partnership Development and
 * Growth & Market Development both reuse them unchanged -- only the
 * domain-specific discover/research/assess/qualify reasoning and each
 * Hat's develop_* drafting prompt are Hat-specific
 * (discoverOpportunity/discoverPartner/discoverGrowthOpportunity,
 * draftDevelopOpportunity/draftDevelopPartnership/
 * draftDevelopGrowthOpportunity, etc.). This generalization happened on
 * the second real Hat, matching the design doc's guidance: prove the
 * shape on Hat 1, generalize only once Hat 2 actually needs the same
 * shape -- not before. (An earlier draft
 * of this file called evaluateHandoffContext with a made-up
 * SemanticTaskId for outbound Handoffs, which was simply the wrong
 * pattern -- that function validates *inbound* context, e.g.
 * strategy.diagnosis; outbound Handoffs are a preview object + Telegram
 * approve/reject buttons + createHandoff only on approval, no
 * SemanticTaskId involved. Corrected; no governance decision was
 * actually needed for that fix.)
 *
 * qualify_opportunity/qualify_partnership/qualify_growth_opportunity are
 * all "internal" -- real hold/resume flows against BDOpportunityState,
 * reusing the same "bd_opportunity_evidence_gap" awaiting-state key in
 * each Hat's own awaitingHandlers map (safe to reuse: lookup is scoped to
 * manifest.hats[state.hat] first, so the key only needs to be unique
 * within one Hat's map, not globally).
 *
 * determine_next_move and the two handoff_to_* actions reuse the exact
 * same registered tasks/pattern across all three Hats (their prompts are
 * already Hat-agnostic, and Handoffs need no SemanticTaskId at all) --
 * only each Hat's own discover/research/assess/qualify/develop actions
 * needed their own new, domain-flavored registered tasks, since Notion
 * treats Opportunity Development, Partnership Development, and Growth &
 * Market Development as three distinct specialized Hats, not aliases of
 * one another.
 *
 * All three Business Development Hats are now fully built.
 *
 * SKILLS (A1): every AI-driven action on all three Hats now resolves its
 * methodology through getSkillContent instead of restating it inline --
 * discover/research/assess actions fetch `research_signal`, qualify_*
 * fetch `opportunity_qualification_gate`, develop_* and
 * determine_next_move fetch `opportunity_forward_planning`. What stays
 * hardcoded in each call is only its own persona framing and output
 * contract (the Skill content itself explicitly leaves the output shape
 * to the invoking action). The three HatManifest.responsibility strings
 * are deliberately NOT migrated: whether responsibility framing should
 * resolve through a Skill or getGovernance at all is still an open
 * question in docs/enig-operating-model.md, not an implementation detail
 * this migration may decide.
 *
 * NOTE: dispatch wiring for entryHandler/readHandler/awaitingHandlers
 * (three chokepoints) is done -- see units/dispatch.ts, units/registry.ts,
 * and router.ts/session.ts's generic manifest lookups. The fourth
 * chokepoint, the approval callback, is now fully migrated onto
 * HatManifest.callbackHandlers: bdopportunityhandoff (PR #203), bddevelop
 * (PR #204), and bdnextmove, all across all three Hats, dispatch
 * generically through session.ts's handleCallback default case instead of
 * their own hardcoded switch case. All four Unit Registry chokepoints are
 * now genuinely wired for Business Development -- no hardcoded BD case
 * remains in session.ts's handleCallback switch.
 */

type OpportunityDevelopmentAction =
  | "discover_opportunity"
  | "research_opportunity"
  | "assess_opportunity"
  | "qualify_opportunity"
  | "develop_opportunity"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

// Matches BD_OPPORTUNITY_DEVELOPMENT's HatIdentity in ../../hats/registry.ts --
// the Hat name (job position the runtime assumes), not concatenated with
// its specialization ("Opportunity Development", tracked separately below
// for documentation/display; never consumed by dispatch, which keys
// purely on this Hat name).
const OPPORTUNITY_DEVELOPMENT_HAT_NAME = "Business Development Manager";
const OPPORTUNITY_DEVELOPMENT_SPECIALIZATION = "Opportunity Development";
const EVIDENCE_GAP_AWAITING_STATE = "bd_opportunity_evidence_gap" as const;

/**
 * Every Business Development Action is INTERPRETATION-DRIVEN, unlike the
 * structural entry rules Finance/Strategy/Sales/Marketing declare:
 * this Unit's three Hats each declare several entry Actions with the same
 * Responsibility, so the Work's origin cannot distinguish them -- only what
 * the requester actually asked for can. That is expressed declaratively
 * (an exact `requested_action` condition per Action) rather than by having
 * the model pick: an intake interpretation may only name an Action id that
 * matches one of these conditions exactly, and zero or multiple matches
 * fail closed at the resolution boundary.
 */
const opportunityDevelopmentActions: ActionDefinition<OpportunityDevelopmentAction>[] = [
  { name: "discover_opportunity", responsibility: "develop_opportunities", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "discover_opportunity" }] }, description: "Identify a candidate BD opportunity from a signal, market, organisation, or relationship." },
  { name: "research_opportunity", responsibility: "develop_opportunities", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "research_opportunity" }] }, description: "Gather evidence-backed findings on a named opportunity signal." },
  { name: "assess_opportunity", responsibility: "develop_opportunities", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "assess_opportunity" }] }, description: "Determine whether a researched signal has a substantive reason for ENIG to pursue it." },
  {
    name: "qualify_opportunity",
    responsibility: "develop_opportunities",
    consequence: "internal",
    requiresApproval: false,
    applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "qualify_opportunity" }] },
    description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated.",
  },
  { name: "develop_opportunity", responsibility: "develop_opportunities", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "develop_opportunity" }] }, description: "Take a qualified opportunity forward: stakeholders, value hypothesis, route, dependencies, risks, next step." },
  { name: "determine_next_move", responsibility: "develop_opportunities", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "determine_next_move" }] }, description: "Commit to the next concrete action for an active opportunity." },
  { name: "handoff_to_sales", responsibility: "develop_opportunities", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "handoff_to_sales" }] }, description: "Governed transition to Sales once the opportunity is a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", responsibility: "develop_opportunities", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "handoff_to_strategy" }] }, description: "Governed transition to Strategy when the opportunity needs strategic diagnosis rather than client-acquisition progression." },
];

/**
 * Real signal-identification reasoning for discover_opportunity, per the
 * Hat Definition's own Output contract (Notion): "candidate opportunity
 * with the signal, why it may matter to ENIG, and what evidence is still
 * missing." Per the operating boundary "BD does not invent evidence to
 * close qualification gaps," this never fabricates supporting evidence --
 * it only names what's still needed, exactly like qualify_opportunity's
 * missingEvidence. Stateless (a "read" action -- no WorkSession, nothing
 * persisted): if Martin wants to carry this forward into qualification,
 * that evidence has to be supplied again when he invokes qualify_opportunity.
 *
 * Migrated (Skills architecture proof, Build order Step 2) to fetch the
 * shared `research-signal` Skill's evidence discipline instead of
 * restating it inline -- the "never invent or infer evidence" rule above
 * is now research-signal's own methodology, not duplicated prose here.
 * Sales's Lead Generation Specialist (`evaluateCandidates` in
 * leadGenerationDiscovery.ts) fetches the identical Skill under a
 * materially different Persona, Data Source (public web search results
 * vs. Martin's own request text), and consequence/approval shape --
 * proving genuine cross-Hat reuse per the OS-analogy review's five-part
 * test, not two copies of the same prompt under one label.
 */
async function discoverOpportunity(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{ signal?: string; whyItMayMatter?: string; evidenceNeeded?: string[] }>(env, {
    taskId: "business_development.discover_opportunity",
    mode: "json",
    parts: {
      persona:
        "You identify potential Business Development opportunities for ENIG from explicit user direction, market signals, organisations, industries, geographies, partnerships, channels, offerings, or strategic relationships.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"signal": "<what was identified>", "whyItMayMatter": "<why this may matter to ENIG>", "evidenceNeeded": ["<specific evidence still missing>", ...]}\n- signal: a concise statement of the candidate opportunity itself.\n- whyItMayMatter: the plausible reason ENIG should care, grounded only in what was actually stated.\n- evidenceNeeded: what's still required to move this from a signal to a developed opportunity -- never empty; discovery alone is never sufficient evidence.`,
    },
    light: true,
  });

  if (!result || !result.signal) {
    return "Couldn't identify a clear opportunity signal from that -- can you name the market, organisation, partnership, or channel you have in mind?";
  }

  const evidenceNeeded = result.evidenceNeeded && result.evidenceNeeded.length > 0 ? result.evidenceNeeded : ["supporting evidence for this signal"];
  return `Signal: ${result.signal}\n\nWhy it may matter: ${result.whyItMayMatter ?? "(not stated)"}\n\nEvidence still needed: ${evidenceNeeded.join(", ")}`;
}

/**
 * Real evidence-organization reasoning for research_opportunity, per the
 * Hat Definition's own Output contract (Notion): "evidence-backed
 * findings, implications for ENIG, limitations, and sources." BD has no
 * live web-search/external-research capability wired up (unlike
 * Lead Discovery) -- this organizes and draws implications only from
 * what Martin has actually supplied in the request, never fabricating
 * facts, statistics, or claims not present in the input. Anything not
 * actually stated is named as a limitation, not inferred or guessed.
 * Stateless (a "read" action), same as discoverOpportunity above.
 *
 * Migrated to fetch the shared `research-signal` Skill -- see
 * discoverOpportunity's doc comment for the cross-Hat reuse proof this
 * is part of.
 */
async function researchOpportunity(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{ findings?: string[]; implications?: string; limitations?: string[]; sources?: string[] }>(env, {
    taskId: "business_development.research_opportunity",
    mode: "json",
    parts: {
      persona:
        "You research a named organisation, market, industry, relationship, partnership, channel, or offering to establish relevant facts and evidence for a Business Development opportunity. You have no live search or external research capability -- you may only organize, structure, and draw implications from facts Martin has actually stated in the request.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"findings": ["<fact actually stated, organized>", ...], "implications": "<what this may mean for ENIG, grounded only in the findings>", "limitations": ["<relevant fact/evidence not available>", ...], "sources": ["<where each finding came from -- Martin's own account if no external source was cited>"]}\n- findings: only facts genuinely present in the input, restated clearly -- never invented.\n- limitations: what's still unknown or unverified; never empty if findings alone can't establish the opportunity.\n- sources: attribute each finding honestly -- "Martin's own account" is a valid and expected source when no external evidence was cited.`,
    },
    light: true,
  });

  if (!result || !result.findings || result.findings.length === 0) {
    return "Couldn't extract any concrete findings from that -- can you share what you already know about this opportunity (organisation, market, evidence you have)?";
  }

  const limitations = result.limitations && result.limitations.length > 0 ? result.limitations.join(", ") : "(none stated)";
  const sources = result.sources && result.sources.length > 0 ? result.sources.join(", ") : "Martin's own account";
  return `Findings: ${result.findings.join("; ")}\n\nImplications: ${result.implications ?? "(not stated)"}\n\nLimitations: ${limitations}\n\nSources: ${sources}`;
}

/**
 * Real strategic/commercial-relevance judgment for assess_opportunity,
 * per the Hat Definition's own Output contract (Notion): "assessment
 * with evidence, implications, limitations, and unresolved questions,"
 * examining strategic relevance, commercial relevance, plausible value
 * to ENIG, fit with ENIG's capabilities, evidence quality, and material
 * unknowns. Distinct from qualify_opportunity: assess judges whether
 * there's a *substantive reason to pursue* across these named
 * dimensions; qualify later applies the evidence-sufficiency threshold
 * gate. Same evidence discipline as discover/research above -- never
 * fabricates evidence, only assesses what's actually been stated.
 * Stateless (a "read" action).
 *
 * Migrated to fetch the shared `research-signal` Skill -- its third
 * consumer alongside discoverOpportunity/researchOpportunity above,
 * since judging strategic/commercial relevance and capability fit
 * without inventing unstated capability claims or market facts is the
 * same evidence discipline, not a distinct methodology.
 */
async function assessOpportunity(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{
    assessment?: string;
    strategicRelevance?: string;
    commercialRelevance?: string;
    capabilityFit?: string;
    evidenceQuality?: string;
    unresolvedQuestions?: string[];
  }>(env, {
    taskId: "business_development.assess_opportunity",
    mode: "json",
    parts: {
      persona:
        "You determine whether a researched Business Development signal has a substantive reason for ENIG to pursue it -- examining strategic relevance, commercial relevance, plausible value to ENIG, fit with ENIG's capabilities, evidence quality, and material unknowns.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"assessment": "<one-line verdict: substantive reason to pursue, or not, or too early to tell>", "strategicRelevance": "<brief>", "commercialRelevance": "<brief>", "capabilityFit": "<brief -- does this fit ENIG's actual capabilities>", "evidenceQuality": "<brief -- how strong is what's been stated so far>", "unresolvedQuestions": ["<material unknown that still needs answering>", ...]}\n- unresolvedQuestions: never empty if any dimension above couldn't be judged from the input alone.`,
    },
    light: true,
  });

  if (!result || !result.assessment) {
    return "Couldn't complete an assessment from that -- can you share more about the strategic/commercial case, or ENIG's fit for this opportunity?";
  }

  const unresolved = result.unresolvedQuestions && result.unresolvedQuestions.length > 0 ? result.unresolvedQuestions.join(", ") : "(none stated)";
  return `Assessment: ${result.assessment}\n\nStrategic relevance: ${result.strategicRelevance ?? "(not stated)"}\nCommercial relevance: ${result.commercialRelevance ?? "(not stated)"}\nCapability fit: ${result.capabilityFit ?? "(not stated)"}\nEvidence quality: ${result.evidenceQuality ?? "(not stated)"}\n\nUnresolved questions: ${unresolved}`;
}

async function opportunityDevelopmentReadHandler(env: Env, actionName: OpportunityDevelopmentAction, text: string): Promise<string> {
  switch (actionName) {
    case "discover_opportunity":
      return discoverOpportunity(env, text);
    case "research_opportunity":
      return researchOpportunity(env, text);
    case "assess_opportunity":
      return assessOpportunity(env, text);
    default:
      // qualify_opportunity is "internal" and develop_opportunity/
      // determine_next_move/handoff_to_sales/handoff_to_strategy are
      // "write" -- dispatchAction never routes any of them here;
      // reaching this branch means the caller didn't respect the
      // declared consequence.
      throw new Error(`${actionName}: not a read action on Opportunity Development.`);
  }
}

interface QualificationJudgment {
  qualification: "Qualified" | "Held" | "Blocked";
  rationale: string;
  missingEvidence?: string[];
}

/**
 * Real evidence-sufficiency judgment for qualify_opportunity, per the Hat
 * Definition's own rule (Notion): "Qualification must not be based on
 * enthusiasm, AI confidence, or superficial fit. If required evidence is
 * missing, hold rather than infer." Ambiguity/AI failure fails closed to
 * Held, never silently defaults to Qualified.
 *
 * Migrated to fetch the shared `opportunity-qualification-gate` Skill --
 * a deliberately separate Skill from `research-signal` since this is a
 * threshold decision with its own consequence-level machinery (it pauses
 * the WorkSession on Held), not an evidence-interpretation step.
 */
async function judgeOpportunityQualification(env: Env, opportunity: BDOpportunityState): Promise<QualificationJudgment> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered yet)";
  const skillContent = getSkillContent("opportunity_qualification_gate");

  const result = await generate<{ qualification?: string; rationale?: string; missingEvidence?: string[] }>(env, {
    taskId: "business_development.opportunity_qualification",
    mode: "json",
    parts: {
      persona: "You apply Business Development's evidence threshold for whether a BD opportunity is sufficiently real to invest further effort in developing.",
      skillContent,
      situation: `Opportunity signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered so far:\n${evidenceText}\n\nReturn JSON:\n{"qualification": "Qualified" | "Held" | "Blocked", "rationale": "<brief rationale>", "missingEvidence": ["<specific missing evidence>", ...]}\n- Qualified: the evidence gathered gives a substantive, non-superficial reason to keep developing this opportunity.\n- Held: there isn't yet enough evidence to judge either way -- missingEvidence must name specifically what's needed.\n- Blocked: the evidence gathered actively indicates this opportunity should not be pursued.\n- missingEvidence: only when qualification is "Held"; omit or leave empty otherwise.`,
    },
    light: true,
  });

  if (!result || (result.qualification !== "Qualified" && result.qualification !== "Held" && result.qualification !== "Blocked")) {
    // Fails closed -- an AI/provider failure or unparsable response is
    // never silently treated as Qualified. Held (not Blocked) since this
    // is a failure to judge, not a negative judgment.
    return {
      qualification: "Held",
      rationale: "Couldn't complete the evidence assessment -- please try again or share more detail.",
      missingEvidence: ["a retry of the evidence assessment"],
    };
  }

  return {
    qualification: result.qualification,
    rationale: result.rationale ?? "(no rationale given)",
    missingEvidence: result.qualification === "Held" ? (result.missingEvidence ?? []) : undefined,
  };
}

async function runQualifyOpportunity(env: Env, state: WorkState, hatName: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  const result = await judgeOpportunityQualification(env, opportunity);

  state.bdOpportunity = {
    ...opportunity,
    qualification: result.qualification,
    qualificationRationale: result.rationale,
    missingEvidence: result.missingEvidence,
  };

  if (result.qualification === "Held") {
    state.awaiting = EVIDENCE_GAP_AWAITING_STATE;
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: hatName },
      `Held -- ${result.rationale}\n\nWhat evidence can you share for: ${result.missingEvidence?.join(", ") || "this opportunity"}?`,
    );
    return state;
  }

  state.awaiting = undefined;
  if (result.qualification === "Blocked") {
    await sendWorkspaceHatMessage(env, { ...state, hat: hatName }, `Blocked -- ${result.rationale}`);
    return state;
  }

  await sendWorkspaceHatMessage(env, { ...state, hat: hatName }, `Qualified -- ${result.rationale}`);
  return state;
}

/**
 * Proposes (never auto-creates) a BD -> Sales/Strategy opportunity
 * handoff -- mirrors Strategy's routeToUnit
 * exactly: build a preview into pendingBDHandoff, present Telegram
 * approve/reject buttons, and only create the Handoff in
 * handleBDHandoffApproval once Martin approves. No SemanticTaskId or
 * evaluateHandoffContext involved -- that machinery is for validating
 * inbound context, not gating an outbound Handoff. Generic across all
 * three BD Hats -- derives the calling Hat's name from state.hat (set by
 * dispatch.ts's Hat resolution) rather than a hardcoded constant, so
 * Partnership Development/Growth & Market Development reuse this
 * unchanged rather than each needing their own copy.
 */
async function proposeBDHandoff(env: Env, state: WorkState, targetUnit: Unit, targetHat: string, text: string): Promise<WorkState> {
  const fromHat = state.hat ?? "Business Development";
  const opportunity = state.bdOpportunity;
  const opportunitySummary = (opportunity?.qualificationRationale ?? text).slice(0, 1900);
  const reason = `Business Development's ${fromHat} Hat judged this ready for ${targetHat}'s ownership.`;

  state.pendingBDHandoff = {
    unit: targetUnit,
    hat: targetHat,
    handoffTitle: `Business Development -> ${targetHat}: opportunity handoff`,
    reason,
    opportunitySummary,
  };

  await logActivity(env, {
    entry: `Business Development proposed handoff to ${targetHat} -- pending approval`,
    type: "Decision",
    area: "Business Development",
    decisionRationale: reason,
    outcome: "Blocked",
  });

  const handoffMessage = `This opportunity looks ready for *${targetHat}*: ${reason}\n\n*Preview of what would be sent:*\n${opportunitySummary}\n\nThis is a recommendation, not yet an approved decision. Send this handoff?`;
  const handoffButtons = [
    [
      { text: "✅ Send handoff", callback_data: `bdopportunityhandoff:${state.workId}:approve` },
      { text: "🚫 Don't send", callback_data: `bdopportunityhandoff:${state.workId}:reject` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, handoffMessage, handoffButtons);
  return state;
}

/**
 * Resolves handoff_to_sales/handoff_to_strategy's approve/reject callback
 * -- mirrors handleStrategyHandoffApproval
 * exactly. Pre-Entity, same as Lead Discovery's own pre-Entity Handoffs
 * (leadGenerationDiscovery.ts): BD never resolves a real Entity/Matter,
 * so this uses the same "E-UNBOUND"/"M-UNBOUND" placeholder tokens
 * rather than leaving the required fields empty. Generic across all
 * three BD Hats -- see proposeBDHandoff's doc comment.
 */
export async function handleBDHandoffApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const fromHat = state.hat ?? "Business Development";
  const pending = state.pendingBDHandoff;
  // The Work is about to perform the HANDOFF itself, which is a different
  // registered operation from the determine_next_move that proposed it. Both
  // are approval-gated, but they are gated for different reasons, and only
  // the handoff is the effect Martin's approval of this button commits. The
  // Work records which one it is performing; Access then judges the create
  // against that, and cannot be talked into judging it as something laxer.
  if (approved && pending) {
    recordWorkAction(state, pending.unit === "Sales" ? "handoff_to_sales" : "handoff_to_strategy");
  }

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "There's no pending handoff to act on.");
    return state;
  }

  if (!approved) {
    state.pendingBDHandoff = undefined;
    await logActivity(env, {
      entry: `Business Development handoff to ${pending.hat} declined by Martin`,
      type: "Decision",
      area: "Business Development",
      decisionRationale: "Martin chose not to send this opportunity to the proposed Hat.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, `Okay -- this opportunity wasn't sent to *${pending.hat}*.`);
    return state;
  }

  await createHandoff(
    env,
    {
      Handoff: title(pending.handoffTitle),
      "From Unit": select("Business Development"),
      "From Hat": richText(fromHat),
      "To Unit": select(pending.unit),
      "To Hat": richText(pending.hat),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(pending.reason),
      "Verified Facts & Sources": richText(pending.opportunitySummary),
    },
    { entityToken: "E-UNBOUND", matterToken: "M-UNBOUND" },
    // The Handoff is created here, from a verified approval callback, and it is
    // exactly what handoff_to_sales / handoff_to_strategy gate on. The Work has
    // already been advanced to that Action by the code proposing the handoff, so
    // the proof is bound to it rather than to a name chosen here.
    workSessionContext(state, mintApprovalProofForWork(state, env.HANDOFFS_DATA_SOURCE_ID)),
  );
  await logActivity(env, {
    entry: `Business Development handed off opportunity to ${pending.hat}`,
    type: "Activity",
    area: "Business Development",
    activity: `${fromHat} Hat's handoff to ${pending.hat} approved by Martin.`,
    outcome: "Active",
  });
  state.pendingBDHandoff = undefined;
  await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, `Sent to *${pending.hat}*.`);
  return state;
}

// The callback_data prefix proposeBDHandoff's own buttons are built with
// (see its "bdopportunityhandoff:<workId>:approve/reject" literal above).
export const BD_OPPORTUNITY_HANDOFF_CALLBACK_PREFIX = "bdopportunityhandoff" as const;

/**
 * Real drafting reasoning for develop_opportunity, per the Hat
 * Definition's own Output contract (Notion): "developed opportunity
 * state and defined next action," establishing stakeholders, value
 * hypothesis, relationship or route, dependencies, risks, evidence gaps,
 * and concrete next step. Grounded only in the opportunity's actual
 * signal/evidence/qualification -- never fabricates stakeholders or
 * routes not implied by what's been gathered. This drafts only; it never
 * commits anything itself -- proposeDevelopOpportunity below presents it
 * for Martin's approval, matching requiresApproval: true.
 *
 * Migrated to fetch the shared `opportunity-forward-planning` Skill.
 * `draftNextMove` below shares this exact grounding discipline ("build
 * only from established state, never invent") and is now its second
 * consumer (A1) -- that boundary was revisited with the rest of
 * Partnership Development/Growth & Market Development's prompts, so no
 * in-scope copy of this methodology remains inline anywhere in BD.
 */
interface DevelopmentDraft {
  stakeholders?: string;
  valueHypothesis?: string;
  route?: string;
  dependencies?: string;
  risks?: string;
  nextStep?: string;
}

async function draftDevelopOpportunity(env: Env, opportunity: BDOpportunityState): Promise<DevelopmentDraft | null> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered)";
  const skillContent = getSkillContent("opportunity_forward_planning");

  return generate<DevelopmentDraft>(env, {
    taskId: "business_development.develop_opportunity",
    mode: "json",
    parts: {
      persona: "You take a qualified Business Development opportunity forward by drafting its stakeholders, value hypothesis, relationship or route, dependencies, risks, and a concrete next step.",
      skillContent,
      situation: `Signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered:\n${evidenceText}\n\nQualification: ${opportunity.qualification ?? "(not yet qualified)"} -- ${opportunity.qualificationRationale ?? ""}\n\nReturn JSON:\n{"stakeholders": "<who's involved, grounded in what's known>", "valueHypothesis": "<why this could create value for ENIG>", "route": "<the plausible path forward>", "dependencies": "<what this depends on>", "risks": "<what could go wrong>", "nextStep": "<one concrete next action>"}`,
    },
    light: true,
  });
}

/**
 * Proposes (never auto-commits) a develop_* draft -- mirrors
 * proposeBDHandoff's preview/approval pattern exactly: build a preview
 * into pendingBDDevelop, present Telegram approve/reject buttons, and
 * only record it into bdOpportunity.developedState in
 * handleBDDevelopApproval once Martin approves. Generic across all three
 * BD Hats -- see proposeBDHandoff's doc comment. `hatFamily` scopes the
 * fallback bdOpportunity seed to whichever Hat is actually calling.
 */
async function proposeBDDevelopment(
  env: Env,
  state: WorkState,
  hatFamily: BDOpportunityState["hatFamily"],
  draftFn: (env: Env, opportunity: BDOpportunityState) => Promise<DevelopmentDraft | null> = draftDevelopOpportunity,
): Promise<WorkState> {
  const fromHat = state.hat ?? "Business Development";
  const opportunity = state.bdOpportunity ?? { hatFamily, signal: state.enquiryText ?? "", evidence: [] };
  const draft = await draftFn(env, opportunity);

  if (!draft) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: fromHat },
      "Couldn't draft a development plan from that -- try qualifying the opportunity first, or share more about it.",
    );
    return state;
  }

  const draftSummary = `Stakeholders: ${draft.stakeholders ?? "(not stated)"}\nValue hypothesis: ${draft.valueHypothesis ?? "(not stated)"}\nRoute: ${draft.route ?? "(not stated)"}\nDependencies: ${draft.dependencies ?? "(not stated)"}\nRisks: ${draft.risks ?? "(not stated)"}\nNext step: ${draft.nextStep ?? "(not stated)"}`;

  state.pendingBDDevelop = { draftSummary };

  await logActivity(env, {
    entry: "Business Development drafted a development plan -- pending approval",
    type: "Decision",
    area: "Business Development",
    decisionRationale: draftSummary,
    outcome: "Blocked",
  });

  const draftMessage = `*Draft development plan:*\n${draftSummary}\n\nThis is a draft, not yet committed. Approve this?`;
  const draftButtons = [
    [
      { text: "✅ Approve", callback_data: `bddevelop:${state.workId}:approve` },
      { text: "🚫 Discard", callback_data: `bddevelop:${state.workId}:reject` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, draftMessage, draftButtons);
  return state;
}

/**
 * Resolves develop_*'s approve/reject callback -- mirrors
 * handleBDHandoffApproval exactly. Approval records the draft into
 * bdOpportunity.developedState (the only thing this action's
 * requiresApproval: true actually gates); rejection discards it with no
 * state change. Generic across all three BD Hats.
 */
export async function handleBDDevelopApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const fromHat = state.hat ?? "Business Development";
  const pending = state.pendingBDDevelop;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "There's no pending development draft to act on.");
    return state;
  }

  if (!approved) {
    state.pendingBDDevelop = undefined;
    await logActivity(env, {
      entry: "Business Development development draft declined by Martin",
      type: "Decision",
      area: "Business Development",
      decisionRationale: "Martin chose not to commit this development plan.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "Okay -- that development plan wasn't committed.");
    return state;
  }

  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  state.bdOpportunity = { ...opportunity, developedState: pending.draftSummary };
  state.pendingBDDevelop = undefined;

  await logActivity(env, {
    entry: "Business Development development plan approved",
    type: "Activity",
    area: "Business Development",
    activity: `${fromHat} Hat's development draft approved by Martin.`,
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "Development plan committed.");
  return state;
}

// The callback_data prefix proposeBDDevelopment's own buttons are built
// with (see its "bddevelop:<workId>:approve/reject" literal, same shape
// as proposeBDHandoff's). Migrates onto HatManifest.callbackHandlers same
// as bdopportunityhandoff (PR #203) -- second prefix proven, same
// incremental-migration discipline as entryHandler's own rollout.
export const BD_DEVELOP_CALLBACK_PREFIX = "bddevelop" as const;

/**
 * Real next-action reasoning for determine_next_move, per the Hat
 * Definition's own Output contract (Notion): "one governed next move,
 * with rationale and any required human decision or approval." Drafts
 * only; proposeNextMove below presents it for Martin's approval,
 * matching requiresApproval: true.
 *
 * Migrated (A1) to resolve the shared `opportunity_forward_planning`
 * Skill through getSkillContent -- the second consumer predicted when
 * that Skill was registered (see draftDevelopOpportunity's doc comment).
 * The grounding rule ("build only from established state, never invent
 * a next move") and the "surface any human decision the plan depends on
 * explicitly" rule are the Skill's own methodology; this call keeps only
 * its role framing and its single-next-move output contract. Shared,
 * Hat-agnostic plumbing across all three BD Hats, so this one migration
 * covers determine_next_move on Opportunity, Partnership, and Growth &
 * Market Development at once.
 */
async function draftNextMove(env: Env, opportunity: BDOpportunityState): Promise<{ nextMove?: string; rationale?: string; requiresHumanDecision?: string } | null> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered)";
  const skillContent = getSkillContent("opportunity_forward_planning");

  return generate(env, {
    taskId: "business_development.determine_next_move",
    mode: "json",
    parts: {
      persona: "You identify the single next concrete action required to advance an active Business Development opportunity, based on the evidence already established and remaining gates.",
      skillContent,
      situation: `Signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered:\n${evidenceText}\n\nQualification: ${opportunity.qualification ?? "(not yet qualified)"} -- ${opportunity.qualificationRationale ?? ""}\n\nDevelopment state: ${opportunity.developedState ?? "(not yet developed)"}\n\nReturn JSON:\n{"nextMove": "<one concrete next action>", "rationale": "<why this is the right next move, grounded in what's known>", "requiresHumanDecision": "<any decision or approval Martin still needs to make before this can happen, or null if none>"}`,
    },
    light: true,
  });
}

/**
 * Proposes (never auto-commits) a determine_next_move recommendation --
 * mirrors proposeBDDevelopment's preview/approval pattern exactly: build
 * a preview into pendingBDNextMove, present Telegram approve/reject
 * buttons, and only record it into bdOpportunity.nextMove in
 * handleBDNextMoveApproval once Martin approves. Generic across all
 * three BD Hats.
 */
async function proposeNextMove(env: Env, state: WorkState, hatFamily: BDOpportunityState["hatFamily"]): Promise<WorkState> {
  const fromHat = state.hat ?? "Business Development";
  const opportunity = state.bdOpportunity ?? { hatFamily, signal: state.enquiryText ?? "", evidence: [] };
  const draft = await draftNextMove(env, opportunity);

  if (!draft || !draft.nextMove) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: fromHat },
      "Couldn't determine a next move from that -- try qualifying or developing the opportunity first, or share more about where it stands.",
    );
    return state;
  }

  const nextMoveSummary = `Next move: ${draft.nextMove}\n\nRationale: ${draft.rationale ?? "(not stated)"}${draft.requiresHumanDecision ? `\n\nRequires your decision: ${draft.requiresHumanDecision}` : ""}`;

  state.pendingBDNextMove = { nextMoveSummary };

  await logActivity(env, {
    entry: "Business Development recommended a next move -- pending approval",
    type: "Decision",
    area: "Business Development",
    decisionRationale: nextMoveSummary,
    outcome: "Blocked",
  });

  const nextMoveMessage = `*Recommended next move:*\n${nextMoveSummary}\n\nThis is a recommendation, not yet approved. Approve this?`;
  const nextMoveButtons = [
    [
      { text: "✅ Approve", callback_data: `bdnextmove:${state.workId}:approve` },
      { text: "🚫 Discard", callback_data: `bdnextmove:${state.workId}:reject` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, nextMoveMessage, nextMoveButtons);
  return state;
}

/**
 * Resolves determine_next_move's approve/reject callback -- mirrors
 * handleBDDevelopApproval exactly. Approval records the recommendation
 * into bdOpportunity.nextMove; rejection discards it with no state
 * change. Generic across all three BD Hats.
 */
export async function handleBDNextMoveApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const fromHat = state.hat ?? "Business Development";
  const pending = state.pendingBDNextMove;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "There's no pending next-move recommendation to act on.");
    return state;
  }

  if (!approved) {
    state.pendingBDNextMove = undefined;
    await logActivity(env, {
      entry: "Business Development next-move recommendation declined by Martin",
      type: "Decision",
      area: "Business Development",
      decisionRationale: "Martin chose not to commit this next move.",
      outcome: "Complete",
    });
    await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "Okay -- that next move wasn't committed.");
    return state;
  }

  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  state.bdOpportunity = { ...opportunity, nextMove: pending.nextMoveSummary };
  state.pendingBDNextMove = undefined;

  await logActivity(env, {
    entry: "Business Development next move approved",
    type: "Activity",
    area: "Business Development",
    activity: `${fromHat} Hat's next-move recommendation approved by Martin.`,
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: fromHat }, "Next move committed.");
  return state;
}

// The callback_data prefix proposeNextMove's own buttons are built with
// (see its "bdnextmove:<workId>:approve/reject" literal above). Migrates
// onto HatManifest.callbackHandlers same as bdopportunityhandoff (PR
// #203) and bddevelop (PR #204) -- third and final BD approval-callback
// prefix, all three now migrated off session.ts's hardcoded switch.
export const BD_NEXT_MOVE_CALLBACK_PREFIX = "bdnextmove" as const;

// Shared across all three BD Hats -- handleBDHandoffApproval,
// handleBDDevelopApproval, and handleBDNextMoveApproval are themselves
// already Hat-agnostic (derive fromHat from state.hat), so one object
// covers all three Hats for all three prefixes.
const businessDevelopmentHandoffCallbackHandlers: Record<string, ApprovalCallbackHandler> = {
  [BD_OPPORTUNITY_HANDOFF_CALLBACK_PREFIX]: handleBDHandoffApproval,
  [BD_DEVELOP_CALLBACK_PREFIX]: handleBDDevelopApproval,
  [BD_NEXT_MOVE_CALLBACK_PREFIX]: handleBDNextMoveApproval,
};

/**
 * Entry handler for Opportunity Development's "internal" and "write"
 * actions. qualify_opportunity routes here (not readHandler) because it
 * needs the WorkSession to pause/resume on Held -- see
 * runQualifyOpportunity. handoff_to_sales/handoff_to_strategy,
 * develop_opportunity, and determine_next_move only propose their
 * draft/preview here -- the actual state change happens in their
 * respective approval handlers once Martin approves.
 */
async function opportunityDevelopmentEntryHandler(
  env: Env,
  state: WorkState,
  actionName: OpportunityDevelopmentAction,
  text: string,
): Promise<WorkState> {
  if (actionName === "qualify_opportunity") {
    return runQualifyOpportunity(env, state, OPPORTUNITY_DEVELOPMENT_HAT_NAME);
  }

  if (actionName === "handoff_to_sales") {
    return proposeBDHandoff(env, state, "Sales", "Sales Executive", text);
  }

  if (actionName === "handoff_to_strategy") {
    return proposeBDHandoff(env, state, "Strategy", "Strategy Analyst", text);
  }

  if (actionName === "develop_opportunity") {
    return proposeBDDevelopment(env, state, "opportunity_development");
  }

  if (actionName === "determine_next_move") {
    return proposeNextMove(env, state, "opportunity_development");
  }

  // discover_opportunity/research_opportunity/assess_opportunity are
  // declared "read" -- dispatchAction never routes them here; reaching
  // this branch means the caller didn't respect the declared consequence.
  throw new Error(`${actionName}: not an internal/write action on Opportunity Development.`);
}

/**
 * Resumes a WorkSession held on qualify_opportunity's evidence gap --
 * appends the reply as new evidence and re-runs qualification, exactly
 * as the initial call does, rather than a separate, drifting
 * implementation of the same rule.
 */
async function resumeQualifyOpportunity(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: "", evidence: [] };
  state.bdOpportunity = { ...opportunity, evidence: [...opportunity.evidence, text] };
  return runQualifyOpportunity(env, state, OPPORTUNITY_DEVELOPMENT_HAT_NAME);
}

const opportunityDevelopmentAwaitingHandlers: HatManifest<OpportunityDevelopmentAction>["awaitingHandlers"] = {
  [EVIDENCE_GAP_AWAITING_STATE]: resumeQualifyOpportunity,
};

const opportunityDevelopmentHat: HatManifest<OpportunityDevelopmentAction> = {
  name: OPPORTUNITY_DEVELOPMENT_HAT_NAME,
  specialization: OPPORTUNITY_DEVELOPMENT_SPECIALIZATION,
  responsibility:
    "Own the development of specific opportunities that could create meaningful growth for ENIG. Turn an observed market, organisation, partnership, channel, offering, or relationship signal into an evidenced BD opportunity that can either be developed further or handed to the appropriate ENIG Unit. Does not own the client/entity lifecycle once an opportunity becomes a genuine client-acquisition opportunity -- that boundary belongs to Sales.",
  actions: opportunityDevelopmentActions,
  responsibilityId: "develop_opportunities",
  readHandler: opportunityDevelopmentReadHandler,
  entryHandler: opportunityDevelopmentEntryHandler,
  awaitingHandlers: opportunityDevelopmentAwaitingHandlers,
  callbackHandlers: businessDevelopmentHandoffCallbackHandlers,
};

// --- Partnership Development: built out real, mirroring Opportunity
// Development's implementation pattern exactly, but with its own
// partnership-flavored prompts per Notion's Hat Definition (a distinct
// specialized Hat, not an alias of Opportunity Development). Reuses the
// generic proposeBDHandoff/proposeBDDevelopment/proposeNextMove/
// handleBD*Approval plumbing (see their doc comments) since those derive
// the calling Hat's identity from state.hat rather than a hardcoded
// constant -- only the domain-specific discover/research/assess/qualify
// reasoning and the develop_partnership drafting prompt are Hat-specific.

type PartnershipDevelopmentAction =
  | "discover_partner"
  | "research_partner"
  | "assess_partnership"
  | "qualify_partnership"
  | "develop_partnership"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

// Matches BD_PARTNERSHIP_DEVELOPMENT's HatIdentity -- see
// OPPORTUNITY_DEVELOPMENT_HAT_NAME's comment above for the name/
// specialization split rationale.
const PARTNERSHIP_DEVELOPMENT_HAT_NAME = "Partnerships Manager";
const PARTNERSHIP_DEVELOPMENT_SPECIALIZATION = "Partnership Development";

const partnershipDevelopmentActions: ActionDefinition<PartnershipDevelopmentAction>[] = [
  { name: "discover_partner", responsibility: "develop_partnerships", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "discover_partner" }] }, description: "Identify a potential partner or strategic relationship." },
  { name: "research_partner", responsibility: "develop_partnerships", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "research_partner" }] }, description: "Research the organisation, stakeholders, capabilities, and relationship context." },
  { name: "assess_partnership", responsibility: "develop_partnerships", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "assess_partnership" }] }, description: "Assess mutual value, strategic fit, and relationship viability." },
  { name: "qualify_partnership", responsibility: "develop_partnerships", consequence: "internal", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "qualify_partnership" }] }, description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated." },
  { name: "develop_partnership", responsibility: "develop_partnerships", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "develop_partnership" }] }, description: "Develop a qualified partnership: stakeholders, value proposition, relationship model, route, dependencies, risks." },
  { name: "determine_next_move", responsibility: "develop_partnerships", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "determine_next_move" }] }, description: "Commit to the next concrete action for an active partnership opportunity." },
  { name: "handoff_to_sales", responsibility: "develop_partnerships", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "handoff_to_sales" }] }, description: "Governed transition to Sales once the partnership becomes a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", responsibility: "develop_partnerships", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "handoff_to_strategy" }] }, description: "Governed transition to Strategy when the partnership needs strategic diagnosis." },
];

/**
 * Real signal-identification reasoning for discover_partner, per the Hat
 * Definition's Output contract: "candidate partner or relationship with
 * the signal, why it may matter, and evidence still required." Same
 * discipline as discoverOpportunity -- never fabricates evidence.
 *
 * Migrated (A1) to resolve the shared `research_signal` Skill through
 * getSkillContent instead of restating its evidence discipline inline --
 * the identical Skill discoverOpportunity/researchOpportunity/
 * assessOpportunity already consume, so the partnership flavor lives only
 * in this call's own persona and output contract, never in a second copy
 * of the methodology.
 */
async function discoverPartner(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{ signal?: string; whyItMayMatter?: string; evidenceNeeded?: string[] }>(env, {
    taskId: "business_development.discover_partner",
    mode: "json",
    parts: {
      persona:
        "You identify potential partners and strategic relationships relevant to ENIG, where the relationship or partnership itself is the central business opportunity.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"signal": "<what was identified>", "whyItMayMatter": "<why this may matter to ENIG>", "evidenceNeeded": ["<specific evidence still missing>", ...]}\n- signal: a concise statement of the candidate partner or relationship itself.\n- whyItMayMatter: the plausible reason ENIG should care, grounded only in what was actually stated.\n- evidenceNeeded: what's still required to move this from a signal to a developed partnership -- never empty; discovery alone is never sufficient evidence.`,
    },
    light: true,
  });

  if (!result || !result.signal) {
    return "Couldn't identify a clear partner or relationship signal from that -- can you name the organisation or relationship you have in mind?";
  }

  const evidenceNeeded = result.evidenceNeeded && result.evidenceNeeded.length > 0 ? result.evidenceNeeded : ["supporting evidence for this signal"];
  return `Signal: ${result.signal}\n\nWhy it may matter: ${result.whyItMayMatter ?? "(not stated)"}\n\nEvidence still needed: ${evidenceNeeded.join(", ")}`;
}

/**
 * Real evidence-organization reasoning for research_partner, per the Hat
 * Definition's Output contract: "evidence-backed findings, implications,
 * limitations, and sources." Same no-fabrication discipline as
 * researchOpportunity -- BD has no live web-search/external-research
 * capability.
 *
 * Migrated (A1) to resolve the shared `research_signal` Skill through
 * getSkillContent -- the "never fabricate facts/statistics/claims" and
 * "name what isn't stated as a limitation" prose is the Skill's own
 * methodology, not duplicated here; the no-live-search capability
 * constraint stays in the persona since it is this action's own
 * authority framing, not methodology.
 */
async function researchPartner(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{ findings?: string[]; implications?: string; limitations?: string[]; sources?: string[] }>(env, {
    taskId: "business_development.research_partner",
    mode: "json",
    parts: {
      persona:
        "You research a named organisation, its stakeholders, capabilities, relationship context, and track record to establish relevant facts and evidence for a potential ENIG partnership. You have no live search or external research capability -- you may only organize, structure, and draw implications from facts Martin has actually stated in the request.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"findings": ["<fact actually stated, organized>", ...], "implications": "<what this may mean for a partnership with ENIG, grounded only in the findings>", "limitations": ["<relevant fact/evidence not available>", ...], "sources": ["<where each finding came from -- Martin's own account if no external source was cited>"]}\n- findings: only facts genuinely present in the input, restated clearly -- never invented.\n- limitations: what's still unknown or unverified; never empty if findings alone can't establish the relationship.\n- sources: attribute each finding honestly -- "Martin's own account" is a valid and expected source when no external evidence was cited.`,
    },
    light: true,
  });

  if (!result || !result.findings || result.findings.length === 0) {
    return "Couldn't extract any concrete findings from that -- can you share what you already know about this organisation or relationship?";
  }

  const limitations = result.limitations && result.limitations.length > 0 ? result.limitations.join(", ") : "(none stated)";
  const sources = result.sources && result.sources.length > 0 ? result.sources.join(", ") : "Martin's own account";
  return `Findings: ${result.findings.join("; ")}\n\nImplications: ${result.implications ?? "(not stated)"}\n\nLimitations: ${limitations}\n\nSources: ${sources}`;
}

/**
 * Real mutual-value/relationship-viability judgment for
 * assess_partnership, per the Hat Definition's Output contract:
 * "partnership assessment with evidence, implications, limitations, and
 * unresolved questions," examining mutual value, strategic fit,
 * complementary capabilities, risks, dependencies, and relationship
 * viability. Same evidence discipline as assessOpportunity.
 *
 * Migrated (A1) to resolve the shared `research_signal` Skill through
 * getSkillContent -- its fourth research-side consumer, since judging
 * mutual value/fit without inventing unstated capability claims is the
 * same evidence discipline, not a distinct methodology.
 */
async function assessPartnership(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{
    assessment?: string;
    mutualValue?: string;
    strategicFit?: string;
    complementaryCapabilities?: string;
    risksAndDependencies?: string;
    unresolvedQuestions?: string[];
  }>(env, {
    taskId: "business_development.assess_partnership",
    mode: "json",
    parts: {
      persona:
        "You determine whether a researched partnership has a substantive reason for ENIG to pursue it -- examining mutual value, strategic fit, complementary capabilities, risks, dependencies, and relationship viability.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"assessment": "<one-line verdict: substantive reason to pursue, or not, or too early to tell>", "mutualValue": "<brief -- value for both ENIG and the partner>", "strategicFit": "<brief>", "complementaryCapabilities": "<brief -- do the two sides' capabilities complement each other>", "risksAndDependencies": "<brief>", "unresolvedQuestions": ["<material unknown that still needs answering>", ...]}\n- unresolvedQuestions: never empty if any dimension above couldn't be judged from the input alone.`,
    },
    light: true,
  });

  if (!result || !result.assessment) {
    return "Couldn't complete an assessment from that -- can you share more about the mutual value or fit of this partnership?";
  }

  const unresolved = result.unresolvedQuestions && result.unresolvedQuestions.length > 0 ? result.unresolvedQuestions.join(", ") : "(none stated)";
  return `Assessment: ${result.assessment}\n\nMutual value: ${result.mutualValue ?? "(not stated)"}\nStrategic fit: ${result.strategicFit ?? "(not stated)"}\nComplementary capabilities: ${result.complementaryCapabilities ?? "(not stated)"}\nRisks and dependencies: ${result.risksAndDependencies ?? "(not stated)"}\n\nUnresolved questions: ${unresolved}`;
}

async function partnershipDevelopmentReadHandler(env: Env, actionName: PartnershipDevelopmentAction, text: string): Promise<string> {
  switch (actionName) {
    case "discover_partner":
      return discoverPartner(env, text);
    case "research_partner":
      return researchPartner(env, text);
    case "assess_partnership":
      return assessPartnership(env, text);
    default:
      throw new Error(`${actionName}: not a read action on Partnership Development.`);
  }
}

/**
 * Real evidence-sufficiency judgment for qualify_partnership -- same rule
 * and fail-closed-to-Held behaviour as judgeOpportunityQualification,
 * partnership-flavored persona/output contract.
 *
 * Migrated (A1) to resolve the shared `opportunity_qualification_gate`
 * Skill through getSkillContent instead of restating the threshold
 * discipline ("not enthusiasm/confidence/superficial fit; hold rather
 * than infer") inline -- same Skill qualify_opportunity already consumes.
 */
async function judgePartnershipQualification(env: Env, partnership: BDOpportunityState): Promise<QualificationJudgment> {
  const evidenceText = partnership.evidence.length > 0 ? partnership.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered yet)";
  const skillContent = getSkillContent("opportunity_qualification_gate");

  const result = await generate<{ qualification?: string; rationale?: string; missingEvidence?: string[] }>(env, {
    taskId: "business_development.qualify_partnership",
    mode: "json",
    parts: {
      persona: "You apply Business Development's evidence threshold for whether a potential partnership has sufficient evidence and value to justify further development.",
      skillContent,
      situation: `Partnership signal: ${partnership.signal || "(not stated)"}\n\nEvidence gathered so far:\n${evidenceText}\n\nReturn JSON:\n{"qualification": "Qualified" | "Held" | "Blocked", "rationale": "<brief rationale>", "missingEvidence": ["<specific missing evidence>", ...]}\n- Qualified: the evidence gathered gives a substantive, non-superficial reason to keep developing this partnership.\n- Held: there isn't yet enough evidence to judge either way -- missingEvidence must name specifically what's needed.\n- Blocked: the evidence gathered actively indicates this partnership should not be pursued.\n- missingEvidence: only when qualification is "Held"; omit or leave empty otherwise.`,
    },
    light: true,
  });

  if (!result || (result.qualification !== "Qualified" && result.qualification !== "Held" && result.qualification !== "Blocked")) {
    return {
      qualification: "Held",
      rationale: "Couldn't complete the evidence assessment -- please try again or share more detail.",
      missingEvidence: ["a retry of the evidence assessment"],
    };
  }

  return {
    qualification: result.qualification,
    rationale: result.rationale ?? "(no rationale given)",
    missingEvidence: result.qualification === "Held" ? (result.missingEvidence ?? []) : undefined,
  };
}

async function runQualifyPartnership(env: Env, state: WorkState): Promise<WorkState> {
  const partnership = state.bdOpportunity ?? { hatFamily: "partnership_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  const result = await judgePartnershipQualification(env, partnership);

  state.bdOpportunity = {
    ...partnership,
    qualification: result.qualification,
    qualificationRationale: result.rationale,
    missingEvidence: result.missingEvidence,
  };

  if (result.qualification === "Held") {
    state.awaiting = EVIDENCE_GAP_AWAITING_STATE;
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: PARTNERSHIP_DEVELOPMENT_HAT_NAME },
      `Held -- ${result.rationale}\n\nWhat evidence can you share for: ${result.missingEvidence?.join(", ") || "this partnership"}?`,
    );
    return state;
  }

  state.awaiting = undefined;
  if (result.qualification === "Blocked") {
    await sendWorkspaceHatMessage(env, { ...state, hat: PARTNERSHIP_DEVELOPMENT_HAT_NAME }, `Blocked -- ${result.rationale}`);
    return state;
  }

  await sendWorkspaceHatMessage(env, { ...state, hat: PARTNERSHIP_DEVELOPMENT_HAT_NAME }, `Qualified -- ${result.rationale}`);
  return state;
}

async function resumeQualifyPartnership(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const partnership = state.bdOpportunity ?? { hatFamily: "partnership_development" as const, signal: "", evidence: [] };
  state.bdOpportunity = { ...partnership, evidence: [...partnership.evidence, text] };
  return runQualifyPartnership(env, state);
}

/**
 * Real drafting reasoning for develop_partnership, per the Hat
 * Definition's Output contract: "developed partnership state and defined
 * next action," establishing stakeholders, value proposition,
 * relationship model, routes, dependencies, risks, and evidence gaps.
 * Same grounding discipline as draftDevelopOpportunity,
 * partnership-flavored persona/output contract.
 *
 * Migrated (A1) to resolve the shared `opportunity_forward_planning`
 * Skill through getSkillContent -- same Skill draftDevelopOpportunity
 * already consumes.
 */
async function draftDevelopPartnership(env: Env, partnership: BDOpportunityState): Promise<DevelopmentDraft | null> {
  const evidenceText = partnership.evidence.length > 0 ? partnership.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered)";
  const skillContent = getSkillContent("opportunity_forward_planning");

  return generate(env, {
    taskId: "business_development.develop_partnership",
    mode: "json",
    parts: {
      persona: "You develop a qualified partnership opportunity by establishing its stakeholders, value proposition, relationship model, route, dependencies, and risks.",
      skillContent,
      situation: `Signal: ${partnership.signal || "(not stated)"}\n\nEvidence gathered:\n${evidenceText}\n\nQualification: ${partnership.qualification ?? "(not yet qualified)"} -- ${partnership.qualificationRationale ?? ""}\n\nReturn JSON:\n{"stakeholders": "<who's involved, grounded in what's known>", "valueHypothesis": "<the value proposition for both sides>", "route": "<the plausible relationship model/path forward>", "dependencies": "<what this depends on>", "risks": "<what could go wrong>", "nextStep": "<one concrete next action>"}`,
    },
    light: true,
  });
}

async function partnershipDevelopmentEntryHandler(
  env: Env,
  state: WorkState,
  actionName: PartnershipDevelopmentAction,
  text: string,
): Promise<WorkState> {
  if (actionName === "qualify_partnership") {
    return runQualifyPartnership(env, state);
  }

  if (actionName === "handoff_to_sales") {
    return proposeBDHandoff(env, state, "Sales", "Sales Executive", text);
  }

  if (actionName === "handoff_to_strategy") {
    return proposeBDHandoff(env, state, "Strategy", "Strategy Analyst", text);
  }

  if (actionName === "develop_partnership") {
    return proposeBDDevelopment(env, state, "partnership_development", draftDevelopPartnership);
  }

  if (actionName === "determine_next_move") {
    return proposeNextMove(env, state, "partnership_development");
  }

  throw new Error(`${actionName}: not an internal/write action on Partnership Development.`);
}

const partnershipDevelopmentAwaitingHandlers: HatManifest<PartnershipDevelopmentAction>["awaitingHandlers"] = {
  [EVIDENCE_GAP_AWAITING_STATE]: resumeQualifyPartnership,
};

const partnershipDevelopmentHat: HatManifest<PartnershipDevelopmentAction> = {
  name: PARTNERSHIP_DEVELOPMENT_HAT_NAME,
  specialization: PARTNERSHIP_DEVELOPMENT_SPECIALIZATION,
  responsibility:
    "Own the development of strategic relationships and partnership opportunities that could create meaningful value for ENIG. Identify, assess, and develop relationships where the relationship or partnership itself is the central business opportunity. Does not automatically own client acquisition, strategic diagnosis, or execution responsibilities belonging to another ENIG Unit.",
  actions: partnershipDevelopmentActions,
  responsibilityId: "develop_partnerships",
  readHandler: partnershipDevelopmentReadHandler,
  entryHandler: partnershipDevelopmentEntryHandler,
  awaitingHandlers: partnershipDevelopmentAwaitingHandlers,
  callbackHandlers: businessDevelopmentHandoffCallbackHandlers,
};

type GrowthMarketDevelopmentAction =
  | "discover_growth_opportunity"
  | "research_market"
  | "assess_market_opportunity"
  | "qualify_growth_opportunity"
  | "develop_growth_opportunity"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

// Matches BD_GROWTH_MARKET_DEVELOPMENT's HatIdentity -- see
// OPPORTUNITY_DEVELOPMENT_HAT_NAME's comment above for the name/
// specialization split rationale.
const GROWTH_MARKET_DEVELOPMENT_HAT_NAME = "Growth & Market Development Manager";
const GROWTH_MARKET_DEVELOPMENT_SPECIALIZATION = "Growth & Market Development";

const growthMarketDevelopmentActions: ActionDefinition<GrowthMarketDevelopmentAction>[] = [
  { name: "discover_growth_opportunity", responsibility: "develop_growth", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "discover_growth_opportunity" }] }, description: "Identify a potential market, channel, offering, or growth space." },
  { name: "research_market", responsibility: "develop_growth", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "research_market" }] }, description: "Research market/industry signals, segments, channels, competitors, demand." },
  { name: "assess_market_opportunity", responsibility: "develop_growth", consequence: "read", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "assess_market_opportunity" }] }, description: "Assess market attractiveness, strategic/commercial relevance, capability fit." },
  { name: "qualify_growth_opportunity", responsibility: "develop_growth", consequence: "internal", requiresApproval: false, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "qualify_growth_opportunity" }] }, description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated." },
  { name: "develop_growth_opportunity", responsibility: "develop_growth", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "develop_growth_opportunity" }] }, description: "Develop a qualified growth opportunity: value hypothesis, requirements, route, risks." },
  { name: "determine_next_move", responsibility: "develop_growth", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "determine_next_move" }] }, description: "Commit to the next concrete action for an active growth opportunity." },
  { name: "handoff_to_sales", responsibility: "develop_growth", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "handoff_to_sales" }] }, description: "Governed transition to Sales once the growth opportunity becomes a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", responsibility: "develop_growth", consequence: "write", requiresApproval: true, applicability: { mode: "all", conditions: [{ source: "work", field: "requested_action", operator: "equals", value: "handoff_to_strategy" }] }, description: "Governed transition to Strategy when the growth opportunity needs strategic diagnosis." },
];

/**
 * Real signal-identification reasoning for discover_growth_opportunity,
 * per the Hat Definition's Output contract: "candidate
 * market/channel/offering with the signal, why it may matter, and
 * evidence still required." Same discipline as
 * discoverOpportunity/discoverPartner -- never fabricates evidence.
 *
 * Migrated (A1) to resolve the shared `research_signal` Skill through
 * getSkillContent -- the third Hat now consuming the same evidence
 * discipline instead of restating it inline.
 */
async function discoverGrowthOpportunity(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{ signal?: string; whyItMayMatter?: string; evidenceNeeded?: string[] }>(env, {
    taskId: "business_development.discover_growth_opportunity",
    mode: "json",
    parts: {
      persona:
        "You identify potential markets, channels, offerings, or growth directions relevant to ENIG's broader market position and future sources of growth.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"signal": "<what was identified>", "whyItMayMatter": "<why this may matter to ENIG>", "evidenceNeeded": ["<specific evidence still missing>", ...]}\n- signal: a concise statement of the candidate market, channel, offering, or growth direction itself.\n- whyItMayMatter: the plausible reason ENIG should care, grounded only in what was actually stated.\n- evidenceNeeded: what's still required to move this from a signal to a developed growth opportunity -- never empty; discovery alone is never sufficient evidence.`,
    },
    light: true,
  });

  if (!result || !result.signal) {
    return "Couldn't identify a clear market, channel, or growth signal from that -- can you name the market, channel, offering, or growth direction you have in mind?";
  }

  const evidenceNeeded = result.evidenceNeeded && result.evidenceNeeded.length > 0 ? result.evidenceNeeded : ["supporting evidence for this signal"];
  return `Signal: ${result.signal}\n\nWhy it may matter: ${result.whyItMayMatter ?? "(not stated)"}\n\nEvidence still needed: ${evidenceNeeded.join(", ")}`;
}

/**
 * Real evidence-organization reasoning for research_market, per the Hat
 * Definition's Output contract: "evidence-backed findings, implications,
 * limitations, and sources." Same no-fabrication discipline as
 * researchOpportunity/researchPartner -- BD has no live
 * web-search/external-research capability.
 *
 * Migrated (A1) to resolve the shared `research_signal` Skill through
 * getSkillContent; the no-live-search capability constraint stays in the
 * persona as this action's own authority framing.
 */
async function researchMarket(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{ findings?: string[]; implications?: string; limitations?: string[]; sources?: string[] }>(env, {
    taskId: "business_development.research_market",
    mode: "json",
    parts: {
      persona:
        "You research a named market, industry, segment, channel, competitor landscape, or demand signal to establish relevant facts and evidence for ENIG's potential growth direction. You have no live search or external research capability -- you may only organize, structure, and draw implications from facts Martin has actually stated in the request.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"findings": ["<fact actually stated, organized>", ...], "implications": "<what this may mean for ENIG's growth, grounded only in the findings>", "limitations": ["<relevant fact/evidence not available>", ...], "sources": ["<where each finding came from -- Martin's own account if no external source was cited>"]}\n- findings: only facts genuinely present in the input, restated clearly -- never invented.\n- limitations: what's still unknown or unverified; never empty if findings alone can't establish the opportunity.\n- sources: attribute each finding honestly -- "Martin's own account" is a valid and expected source when no external evidence was cited.`,
    },
    light: true,
  });

  if (!result || !result.findings || result.findings.length === 0) {
    return "Couldn't extract any concrete findings from that -- can you share what you already know about this market, channel, or growth direction?";
  }

  const limitations = result.limitations && result.limitations.length > 0 ? result.limitations.join(", ") : "(none stated)";
  const sources = result.sources && result.sources.length > 0 ? result.sources.join(", ") : "Martin's own account";
  return `Findings: ${result.findings.join("; ")}\n\nImplications: ${result.implications ?? "(not stated)"}\n\nLimitations: ${limitations}\n\nSources: ${sources}`;
}

/**
 * Real market-attractiveness/capability-fit judgment for
 * assess_market_opportunity, per the Hat Definition's Output contract:
 * "assessment with evidence, implications, limitations, and unresolved
 * questions," examining market attractiveness, strategic/commercial
 * relevance, and capability fit. Same evidence discipline as
 * assessOpportunity/assessPartnership.
 *
 * Migrated (A1) to resolve the shared `research_signal` Skill through
 * getSkillContent -- its research-side consumer on the third BD Hat.
 */
async function assessMarketOpportunity(env: Env, text: string): Promise<string> {
  const skillContent = getSkillContent("research_signal");
  const result = await generate<{
    assessment?: string;
    marketAttractiveness?: string;
    strategicCommercialRelevance?: string;
    capabilityFit?: string;
    unresolvedQuestions?: string[];
  }>(env, {
    taskId: "business_development.assess_market_opportunity",
    mode: "json",
    parts: {
      persona:
        "You determine whether a researched market, channel, offering, or growth direction has a substantive reason for ENIG to pursue it -- examining market attractiveness, strategic/commercial relevance, and fit with ENIG's actual capabilities.",
      skillContent,
      situation: `${text}\n\nReturn JSON:\n{"assessment": "<one-line verdict: substantive reason to pursue, or not, or too early to tell>", "marketAttractiveness": "<brief>", "strategicCommercialRelevance": "<brief>", "capabilityFit": "<brief -- does this fit ENIG's actual capabilities>", "unresolvedQuestions": ["<material unknown that still needs answering>", ...]}\n- unresolvedQuestions: never empty if any dimension above couldn't be judged from the input alone.`,
    },
    light: true,
  });

  if (!result || !result.assessment) {
    return "Couldn't complete an assessment from that -- can you share more about the market's attractiveness, or ENIG's fit for this growth direction?";
  }

  const unresolved = result.unresolvedQuestions && result.unresolvedQuestions.length > 0 ? result.unresolvedQuestions.join(", ") : "(none stated)";
  return `Assessment: ${result.assessment}\n\nMarket attractiveness: ${result.marketAttractiveness ?? "(not stated)"}\nStrategic/commercial relevance: ${result.strategicCommercialRelevance ?? "(not stated)"}\nCapability fit: ${result.capabilityFit ?? "(not stated)"}\n\nUnresolved questions: ${unresolved}`;
}

async function growthMarketDevelopmentReadHandler(env: Env, actionName: GrowthMarketDevelopmentAction, text: string): Promise<string> {
  switch (actionName) {
    case "discover_growth_opportunity":
      return discoverGrowthOpportunity(env, text);
    case "research_market":
      return researchMarket(env, text);
    case "assess_market_opportunity":
      return assessMarketOpportunity(env, text);
    default:
      throw new Error(`${actionName}: not a read action on Growth & Market Development.`);
  }
}

/**
 * Real evidence-sufficiency judgment for
 * qualify_growth_opportunity -- same rule and fail-closed-to-Held
 * behaviour as judgeOpportunityQualification/judgePartnershipQualification,
 * growth/market-flavored persona/output contract.
 *
 * Migrated (A1) to resolve the shared `opportunity_qualification_gate`
 * Skill through getSkillContent -- the threshold discipline is the
 * Skill's own methodology, not a third inline copy of it.
 */
async function judgeGrowthQualification(env: Env, opportunity: BDOpportunityState): Promise<QualificationJudgment> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered yet)";
  const skillContent = getSkillContent("opportunity_qualification_gate");

  const result = await generate<{ qualification?: string; rationale?: string; missingEvidence?: string[] }>(env, {
    taskId: "business_development.qualify_growth_opportunity",
    mode: "json",
    parts: {
      persona: "You apply Business Development's evidence threshold for whether a growth/market opportunity is sufficiently real to invest further effort in developing.",
      skillContent,
      situation: `Growth opportunity signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered so far:\n${evidenceText}\n\nReturn JSON:\n{"qualification": "Qualified" | "Held" | "Blocked", "rationale": "<brief rationale>", "missingEvidence": ["<specific missing evidence>", ...]}\n- Qualified: the evidence gathered gives a substantive, non-superficial reason to keep developing this growth opportunity.\n- Held: there isn't yet enough evidence to judge either way -- missingEvidence must name specifically what's needed.\n- Blocked: the evidence gathered actively indicates this growth opportunity should not be pursued.\n- missingEvidence: only when qualification is "Held"; omit or leave empty otherwise.`,
    },
    light: true,
  });

  if (!result || (result.qualification !== "Qualified" && result.qualification !== "Held" && result.qualification !== "Blocked")) {
    return {
      qualification: "Held",
      rationale: "Couldn't complete the evidence assessment -- please try again or share more detail.",
      missingEvidence: ["a retry of the evidence assessment"],
    };
  }

  return {
    qualification: result.qualification,
    rationale: result.rationale ?? "(no rationale given)",
    missingEvidence: result.qualification === "Held" ? (result.missingEvidence ?? []) : undefined,
  };
}

async function runQualifyGrowthOpportunity(env: Env, state: WorkState): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "growth_market_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  const result = await judgeGrowthQualification(env, opportunity);

  state.bdOpportunity = {
    ...opportunity,
    qualification: result.qualification,
    qualificationRationale: result.rationale,
    missingEvidence: result.missingEvidence,
  };

  if (result.qualification === "Held") {
    state.awaiting = EVIDENCE_GAP_AWAITING_STATE;
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: GROWTH_MARKET_DEVELOPMENT_HAT_NAME },
      `Held -- ${result.rationale}\n\nWhat evidence can you share for: ${result.missingEvidence?.join(", ") || "this growth opportunity"}?`,
    );
    return state;
  }

  state.awaiting = undefined;
  if (result.qualification === "Blocked") {
    await sendWorkspaceHatMessage(env, { ...state, hat: GROWTH_MARKET_DEVELOPMENT_HAT_NAME }, `Blocked -- ${result.rationale}`);
    return state;
  }

  await sendWorkspaceHatMessage(env, { ...state, hat: GROWTH_MARKET_DEVELOPMENT_HAT_NAME }, `Qualified -- ${result.rationale}`);
  return state;
}

async function resumeQualifyGrowthOpportunity(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "growth_market_development" as const, signal: "", evidence: [] };
  state.bdOpportunity = { ...opportunity, evidence: [...opportunity.evidence, text] };
  return runQualifyGrowthOpportunity(env, state);
}

/**
 * Real drafting reasoning for develop_growth_opportunity, per the Hat
 * Definition's Output contract: "developed growth opportunity state and
 * defined next action," establishing value hypothesis, requirements,
 * route, dependencies, and risks. Same grounding discipline as
 * draftDevelopOpportunity/draftDevelopPartnership, growth/market-flavored
 * persona/output contract.
 *
 * Migrated (A1) to resolve the shared `opportunity_forward_planning`
 * Skill through getSkillContent -- the forward-planning discipline is
 * the Skill's own methodology, not a third inline copy of it.
 */
async function draftDevelopGrowthOpportunity(env: Env, opportunity: BDOpportunityState): Promise<DevelopmentDraft | null> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered)";
  const skillContent = getSkillContent("opportunity_forward_planning");

  return generate(env, {
    taskId: "business_development.develop_growth_opportunity",
    mode: "json",
    parts: {
      persona: "You take a qualified growth/market opportunity forward by drafting its stakeholders, value hypothesis, requirements, route, dependencies, and risks.",
      skillContent,
      situation: `Signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered:\n${evidenceText}\n\nQualification: ${opportunity.qualification ?? "(not yet qualified)"} -- ${opportunity.qualificationRationale ?? ""}\n\nReturn JSON:\n{"stakeholders": "<who's involved, grounded in what's known>", "valueHypothesis": "<why this could create value for ENIG>", "route": "<the plausible path forward -- market entry, channel, offering build-out>", "dependencies": "<what this depends on>", "risks": "<what could go wrong>", "nextStep": "<one concrete next action>"}`,
    },
    light: true,
  });
}

async function growthMarketDevelopmentEntryHandler(
  env: Env,
  state: WorkState,
  actionName: GrowthMarketDevelopmentAction,
  text: string,
): Promise<WorkState> {
  if (actionName === "qualify_growth_opportunity") {
    return runQualifyGrowthOpportunity(env, state);
  }

  if (actionName === "handoff_to_sales") {
    return proposeBDHandoff(env, state, "Sales", "Sales Executive", text);
  }

  if (actionName === "handoff_to_strategy") {
    return proposeBDHandoff(env, state, "Strategy", "Strategy Analyst", text);
  }

  if (actionName === "develop_growth_opportunity") {
    return proposeBDDevelopment(env, state, "growth_market_development", draftDevelopGrowthOpportunity);
  }

  if (actionName === "determine_next_move") {
    return proposeNextMove(env, state, "growth_market_development");
  }

  throw new Error(`${actionName}: not an internal/write action on Growth & Market Development.`);
}

const growthMarketDevelopmentAwaitingHandlers: HatManifest<GrowthMarketDevelopmentAction>["awaitingHandlers"] = {
  [EVIDENCE_GAP_AWAITING_STATE]: resumeQualifyGrowthOpportunity,
};

const growthMarketDevelopmentHat: HatManifest<GrowthMarketDevelopmentAction> = {
  name: GROWTH_MARKET_DEVELOPMENT_HAT_NAME,
  specialization: GROWTH_MARKET_DEVELOPMENT_SPECIALIZATION,
  responsibility:
    "Own the identification and development of broader opportunities for ENIG's growth across markets, channels, offerings, and growth directions. Identify, research, assess, and develop growth directions where the central question concerns ENIG's broader market position, expansion, channels, offerings, or future sources of growth. Does not automatically own client acquisition, strategic diagnosis, or execution responsibilities belonging to another ENIG Unit.",
  actions: growthMarketDevelopmentActions,
  responsibilityId: "develop_growth",
  readHandler: growthMarketDevelopmentReadHandler,
  entryHandler: growthMarketDevelopmentEntryHandler,
  awaitingHandlers: growthMarketDevelopmentAwaitingHandlers,
  callbackHandlers: businessDevelopmentHandoffCallbackHandlers,
};

export const businessDevelopmentManifest: UnitManifest = {
  unit: "Business Development",
  hats: {
    [opportunityDevelopmentHat.name]: opportunityDevelopmentHat,
    [partnershipDevelopmentHat.name]: partnershipDevelopmentHat,
    [growthMarketDevelopmentHat.name]: growthMarketDevelopmentHat,
  },
  // Registered in dataBoundary/types.ts + registry.ts, but NOT yet
  // classified in PRODUCTION_TASK_SENSITIVITY (dataBoundary/policy.ts) --
  // pending Architect review. Calls against these taskIds fail closed
  // (UNRESOLVED_POLICY_HOLD) until that classification lands; this
  // manifest is wired into dispatch but not yet live end-to-end.
  intakeClassificationTaskId: "business_development.intake_classification",
  intakeIntroLine: "You route incoming Business Development requests for ENIG, among its three parallel specialist Hats.",
  actionClassificationTaskId: "business_development.hat_action_decision",
};
