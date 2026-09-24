import type { Env, WorkState, Unit } from "../../types";
import type { ActionDefinition } from "../../hats/actionRegistry";
import type { BDOpportunityState } from "./types";
import type { HatManifest, UnitManifest } from "../unitManifest";
import { createHandoff } from "../../handoffWriter";
import { title, richText, select } from "../../notion";
import { sendWorkspaceHatMessage } from "../../telegram";
import { logActivity } from "../../log";
import { aiJson } from "../../ai";

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
 * STATUS: Opportunity Development is built out close to real -- its
 * qualify_opportunity hold/resume flow is real (against BDOpportunityState),
 * and handoff_to_sales/handoff_to_strategy follow the same preview +
 * Martin-approval + createHandoff pattern Strategy's routeToUnit/
 * handleStrategyHandoffApproval and R&I's routeToConsumingHat/
 * handleResearchHandoffApproval already use -- not a parallel, weaker
 * path for BD. (An earlier draft of this file called
 * evaluateHandoffContext with a made-up SemanticTaskId here, which was
 * simply the wrong pattern: that function validates *inbound* context
 * for a Handoff pickup or direct request, e.g. strategy.diagnosis --
 * it's never used to gate an *outbound* Handoff creation, which is a
 * preview object + Telegram approve/reject buttons + createHandoff only
 * on approval, no SemanticTaskId involved at all. Corrected here; no
 * governance decision was actually needed.)
 *
 * Partnership Development and Growth & Market Development are present --
 * so Hat resolution genuinely exercises three Hats, not one -- but their
 * handlers are explicit stubs pending the same treatment.
 *
 * All four of this Hat's evidence-pipeline actions have real, registered
 * AI reasoning: discover_opportunity, research_opportunity,
 * assess_opportunity, and qualify_opportunity (discoverOpportunity/
 * researchOpportunity/assessOpportunity/judgeOpportunityQualification) --
 * all classified business_sensitive (Architect-approved). BD has no live
 * web-search/external-research capability wired up (unlike R&I or Lead
 * Discovery) -- research_opportunity/assess_opportunity only reason over
 * facts Martin has actually supplied, never fabricating external
 * evidence, capability claims, or market facts.
 *
 * develop_opportunity and determine_next_move are also real now
 * (draftDevelopOpportunity/proposeDevelopOpportunity/
 * handleBDOpportunityDevelopApproval and draftNextMove/proposeNextMove/
 * handleBDOpportunityNextMoveApproval) -- unlike the read actions above,
 * both are "write" actions with requiresApproval: true, so they follow
 * the same preview + Martin-approval pattern as handoff_to_sales/
 * handoff_to_strategy (build a draft into pendingBDDevelop/
 * pendingBDNextMove, present approve/reject buttons, only record into
 * bdOpportunity.developedState/nextMove once Martin approves) -- not the
 * stateless single-reply shape the read actions use. develop_opportunity
 * is classified business_sensitive (Architect-approved); determine_next_move
 * (business_development.determine_next_move) is classified
 * business_sensitive pending Architect review (same payload category:
 * the opportunity's signal + evidence + qualification + developed state,
 * all Martin-derived text), UNCLASSIFIED in PRODUCTION_TASK_SENSITIVITY
 * until then (fails closed).
 *
 * Every action on Opportunity Development now has real implementation --
 * the remaining open items are Partnership Development/Growth & Market
 * Development's stubbed Hats (below).
 *
 * NOTE: dispatch wiring (four chokepoints, including the approval
 * callback) is done -- see units/dispatch.ts, units/registry.ts, and
 * router.ts/session.ts's generic manifest lookups.
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

const OPPORTUNITY_DEVELOPMENT_HAT_NAME = "Business Development Manager — Opportunity Development";
const EVIDENCE_GAP_AWAITING_STATE = "bd_opportunity_evidence_gap" as const;

const opportunityDevelopmentActions: ActionDefinition<OpportunityDevelopmentAction>[] = [
  { name: "discover_opportunity", consequence: "read", description: "Identify a candidate BD opportunity from a signal, market, organisation, or relationship." },
  { name: "research_opportunity", consequence: "read", description: "Gather evidence-backed findings on a named opportunity signal." },
  { name: "assess_opportunity", consequence: "read", description: "Determine whether a researched signal has a substantive reason for ENIG to pursue it." },
  {
    name: "qualify_opportunity",
    consequence: "internal",
    description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated.",
  },
  { name: "develop_opportunity", consequence: "write", requiresApproval: true, description: "Take a qualified opportunity forward: stakeholders, value hypothesis, route, dependencies, risks, next step." },
  { name: "determine_next_move", consequence: "write", requiresApproval: true, description: "Commit to the next concrete action for an active opportunity." },
  { name: "handoff_to_sales", consequence: "write", requiresApproval: true, description: "Governed transition to Sales once the opportunity is a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", consequence: "write", requiresApproval: true, description: "Governed transition to Strategy when the opportunity needs strategic diagnosis rather than client-acquisition progression." },
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
 */
async function discoverOpportunity(env: Env, text: string): Promise<string> {
  const result = await aiJson<{ signal?: string; whyItMayMatter?: string; evidenceNeeded?: string[] }>(env, {
    taskId: "business_development.discover_opportunity",
    system: `You identify potential Business Development opportunities for ENIG from explicit user direction, market signals, organisations, industries, geographies, partnerships, channels, offerings, or strategic relationships.

Never invent or infer evidence that isn't in the request -- name what's still needed instead of assuming it.

Return JSON:
{"signal": "<what was identified>", "whyItMayMatter": "<why this may matter to ENIG>", "evidenceNeeded": ["<specific evidence still missing>", ...]}
- signal: a concise statement of the candidate opportunity itself.
- whyItMayMatter: the plausible reason ENIG should care, grounded only in what was actually stated.
- evidenceNeeded: what's still required to move this from a signal to a developed opportunity -- never empty; discovery alone is never sufficient evidence.`,
    user: text,
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
 * live web-search/external-research capability wired up (unlike R&I or
 * Lead Discovery) -- this organizes and draws implications only from
 * what Martin has actually supplied in the request, never fabricating
 * facts, statistics, or claims not present in the input. Anything not
 * actually stated is named as a limitation, not inferred or guessed.
 * Stateless (a "read" action), same as discoverOpportunity above.
 */
async function researchOpportunity(env: Env, text: string): Promise<string> {
  const result = await aiJson<{ findings?: string[]; implications?: string; limitations?: string[]; sources?: string[] }>(env, {
    taskId: "business_development.research_opportunity",
    system: `You research a named organisation, market, industry, relationship, partnership, channel, or offering to establish relevant facts and evidence for a Business Development opportunity.

You have no live search or external research capability -- you may only organize, structure, and draw implications from facts Martin has actually stated in the request. Never fabricate facts, statistics, claims, or sources not present in the input. Anything relevant but not actually stated must be named as a limitation, never inferred or assumed.

Return JSON:
{"findings": ["<fact actually stated, organized>", ...], "implications": "<what this may mean for ENIG, grounded only in the findings>", "limitations": ["<relevant fact/evidence not available>", ...], "sources": ["<where each finding came from -- Martin's own account if no external source was cited>"]}
- findings: only facts genuinely present in the input, restated clearly -- never invented.
- limitations: what's still unknown or unverified; never empty if findings alone can't establish the opportunity.
- sources: attribute each finding honestly -- "Martin's own account" is a valid and expected source when no external evidence was cited.`,
    user: text,
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
 */
async function assessOpportunity(env: Env, text: string): Promise<string> {
  const result = await aiJson<{
    assessment?: string;
    strategicRelevance?: string;
    commercialRelevance?: string;
    capabilityFit?: string;
    evidenceQuality?: string;
    unresolvedQuestions?: string[];
  }>(env, {
    taskId: "business_development.assess_opportunity",
    system: `You determine whether a researched Business Development signal has a substantive reason for ENIG to pursue it -- examining strategic relevance, commercial relevance, plausible value to ENIG, fit with ENIG's capabilities, evidence quality, and material unknowns.

Base this only on what has actually been stated -- never invent evidence, capability claims, or market facts not present in the input. If a dimension can't be judged from what's given, say so as an unresolved question rather than guessing.

Return JSON:
{"assessment": "<one-line verdict: substantive reason to pursue, or not, or too early to tell>", "strategicRelevance": "<brief>", "commercialRelevance": "<brief>", "capabilityFit": "<brief -- does this fit ENIG's actual capabilities>", "evidenceQuality": "<brief -- how strong is what's been stated so far>", "unresolvedQuestions": ["<material unknown that still needs answering>", ...]}
- unresolvedQuestions: never empty if any dimension above couldn't be judged from the input alone.`,
    user: text,
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
 */
async function judgeOpportunityQualification(env: Env, opportunity: BDOpportunityState): Promise<QualificationJudgment> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered yet)";

  const result = await aiJson<{ qualification?: string; rationale?: string; missingEvidence?: string[] }>(env, {
    taskId: "business_development.opportunity_qualification",
    system: `You apply Business Development's evidence threshold for whether a BD opportunity is sufficiently real to invest further effort in developing.

Qualification must not be based on enthusiasm, confidence, or superficial fit -- it must be based on the actual evidence gathered. If required evidence is missing to make this judgment, hold rather than infer or guess.

Return JSON:
{"qualification": "Qualified" | "Held" | "Blocked", "rationale": "<brief rationale>", "missingEvidence": ["<specific missing evidence>", ...]}
- Qualified: the evidence gathered gives a substantive, non-superficial reason to keep developing this opportunity.
- Held: there isn't yet enough evidence to judge either way -- missingEvidence must name specifically what's needed.
- Blocked: the evidence gathered actively indicates this opportunity should not be pursued.
- missingEvidence: only when qualification is "Held"; omit or leave empty otherwise.`,
    user: `Opportunity signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered so far:\n${evidenceText}`,
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
 * handoff -- mirrors Strategy's routeToUnit / R&I's routeToConsumingHat
 * exactly: build a preview into pendingBDHandoff, present Telegram
 * approve/reject buttons, and only create the Handoff in
 * handleBDOpportunityHandoffApproval once Martin approves. No
 * SemanticTaskId or evaluateHandoffContext involved -- that machinery is
 * for validating inbound context, not gating an outbound Handoff.
 */
async function proposeOpportunityHandoff(env: Env, state: WorkState, targetUnit: Unit, targetHat: string, text: string): Promise<WorkState> {
  const opportunity = state.bdOpportunity;
  const opportunitySummary = (opportunity?.qualificationRationale ?? text).slice(0, 1900);
  const reason = `Business Development's Opportunity Development Hat judged this opportunity ready for ${targetHat}'s ownership.`;

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
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, handoffMessage, handoffButtons);
  return state;
}

/**
 * Resolves handoff_to_sales/handoff_to_strategy's approve/reject callback
 * -- mirrors handleStrategyHandoffApproval/handleResearchHandoffApproval
 * exactly. Pre-Entity, same as Lead Discovery's own pre-Entity Handoffs
 * (leadGenerationDiscovery.ts): BD never resolves a real Entity/Matter,
 * so this uses the same "E-UNBOUND"/"M-UNBOUND" placeholder tokens
 * rather than leaving the required fields empty.
 */
export async function handleBDOpportunityHandoffApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingBDHandoff;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "There's no pending handoff to act on.");
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
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, `Okay -- this opportunity wasn't sent to *${pending.hat}*.`);
    return state;
  }

  await createHandoff(
    env,
    {
      Handoff: title(pending.handoffTitle),
      "From Unit": select("Business Development"),
      "From Hat": richText(OPPORTUNITY_DEVELOPMENT_HAT_NAME),
      "To Unit": select(pending.unit),
      "To Hat": richText(pending.hat),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(pending.reason),
      "Verified Facts & Sources": richText(pending.opportunitySummary),
    },
    { entityToken: "E-UNBOUND", matterToken: "M-UNBOUND" },
  );
  await logActivity(env, {
    entry: `Business Development handed off opportunity to ${pending.hat}`,
    type: "Activity",
    area: "Business Development",
    activity: `Opportunity Development Hat's handoff to ${pending.hat} approved by Martin.`,
    outcome: "Active",
  });
  state.pendingBDHandoff = undefined;
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, `Sent to *${pending.hat}*.`);
  return state;
}

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
 */
async function draftDevelopOpportunity(
  env: Env,
  opportunity: BDOpportunityState,
): Promise<{ stakeholders?: string; valueHypothesis?: string; route?: string; dependencies?: string; risks?: string; nextStep?: string } | null> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered)";

  return aiJson(env, {
    taskId: "business_development.develop_opportunity",
    system: `You take a qualified Business Development opportunity forward by drafting its stakeholders, value hypothesis, relationship or route, dependencies, risks, and a concrete next step.

Ground everything only in the opportunity's actual signal, gathered evidence, and qualification rationale -- never invent stakeholders, routes, or facts not implied by what's actually been established. Where something can't be determined from what's given, say so plainly rather than guessing.

Return JSON:
{"stakeholders": "<who's involved, grounded in what's known>", "valueHypothesis": "<why this could create value for ENIG>", "route": "<the plausible path forward>", "dependencies": "<what this depends on>", "risks": "<what could go wrong>", "nextStep": "<one concrete next action>"}`,
    user: `Signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered:\n${evidenceText}\n\nQualification: ${opportunity.qualification ?? "(not yet qualified)"} -- ${opportunity.qualificationRationale ?? ""}`,
    light: true,
  });
}

/**
 * Proposes (never auto-commits) a develop_opportunity draft -- mirrors
 * proposeOpportunityHandoff's preview/approval pattern exactly: build a
 * preview into pendingBDDevelop, present Telegram approve/reject
 * buttons, and only record it into bdOpportunity.developedState in
 * handleBDOpportunityDevelopApproval once Martin approves.
 */
async function proposeDevelopOpportunity(env: Env, state: WorkState): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  const draft = await draftDevelopOpportunity(env, opportunity);

  if (!draft) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME },
      "Couldn't draft a development plan from that -- try qualifying the opportunity first, or share more about it.",
    );
    return state;
  }

  const draftSummary = `Stakeholders: ${draft.stakeholders ?? "(not stated)"}\nValue hypothesis: ${draft.valueHypothesis ?? "(not stated)"}\nRoute: ${draft.route ?? "(not stated)"}\nDependencies: ${draft.dependencies ?? "(not stated)"}\nRisks: ${draft.risks ?? "(not stated)"}\nNext step: ${draft.nextStep ?? "(not stated)"}`;

  state.pendingBDDevelop = { draftSummary };

  await logActivity(env, {
    entry: "Business Development drafted an opportunity development plan -- pending approval",
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
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, draftMessage, draftButtons);
  return state;
}

/**
 * Resolves develop_opportunity's approve/reject callback -- mirrors
 * handleBDOpportunityHandoffApproval exactly. Approval records the draft
 * into bdOpportunity.developedState (the only thing this action's
 * requiresApproval: true actually gates); rejection discards it with no
 * state change.
 */
export async function handleBDOpportunityDevelopApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingBDDevelop;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "There's no pending development draft to act on.");
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
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "Okay -- that development plan wasn't committed.");
    return state;
  }

  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  state.bdOpportunity = { ...opportunity, developedState: pending.draftSummary };
  state.pendingBDDevelop = undefined;

  await logActivity(env, {
    entry: "Business Development opportunity development plan approved",
    type: "Activity",
    area: "Business Development",
    activity: "Opportunity Development Hat's development draft approved by Martin.",
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "Development plan committed.");
  return state;
}

/**
 * Real next-action reasoning for determine_next_move, per the Hat
 * Definition's own Output contract (Notion): "one governed next move,
 * with rationale and any required human decision or approval." Grounded
 * only in the opportunity's actual signal/evidence/qualification/
 * developed state -- never invents a next move not implied by what's
 * been established. Drafts only; proposeNextMove below presents it for
 * Martin's approval, matching requiresApproval: true.
 */
async function draftNextMove(env: Env, opportunity: BDOpportunityState): Promise<{ nextMove?: string; rationale?: string; requiresHumanDecision?: string } | null> {
  const evidenceText = opportunity.evidence.length > 0 ? opportunity.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n") : "(none gathered)";

  return aiJson(env, {
    taskId: "business_development.determine_next_move",
    system: `You identify the single next concrete action required to advance an active Business Development opportunity, based on the evidence already established and remaining gates.

Ground this only in the opportunity's actual signal, evidence, qualification, and development state -- never invent a next move not implied by what's actually been established. If a human decision or approval beyond this recommendation is required before the move can happen, name it explicitly.

Return JSON:
{"nextMove": "<one concrete next action>", "rationale": "<why this is the right next move, grounded in what's known>", "requiresHumanDecision": "<any decision or approval Martin still needs to make before this can happen, or null if none>"}`,
    user: `Signal: ${opportunity.signal || "(not stated)"}\n\nEvidence gathered:\n${evidenceText}\n\nQualification: ${opportunity.qualification ?? "(not yet qualified)"} -- ${opportunity.qualificationRationale ?? ""}\n\nDevelopment state: ${opportunity.developedState ?? "(not yet developed)"}`,
    light: true,
  });
}

/**
 * Proposes (never auto-commits) a determine_next_move recommendation --
 * mirrors proposeDevelopOpportunity's preview/approval pattern exactly:
 * build a preview into pendingBDNextMove, present Telegram
 * approve/reject buttons, and only record it into
 * bdOpportunity.nextMove in handleBDOpportunityNextMoveApproval once
 * Martin approves.
 */
async function proposeNextMove(env: Env, state: WorkState): Promise<WorkState> {
  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  const draft = await draftNextMove(env, opportunity);

  if (!draft || !draft.nextMove) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME },
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
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, nextMoveMessage, nextMoveButtons);
  return state;
}

/**
 * Resolves determine_next_move's approve/reject callback -- mirrors
 * handleBDOpportunityDevelopApproval exactly. Approval records the
 * recommendation into bdOpportunity.nextMove; rejection discards it with
 * no state change.
 */
export async function handleBDOpportunityNextMoveApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  const pending = state.pendingBDNextMove;

  if (!pending) {
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "There's no pending next-move recommendation to act on.");
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
    await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "Okay -- that next move wasn't committed.");
    return state;
  }

  const opportunity = state.bdOpportunity ?? { hatFamily: "opportunity_development" as const, signal: state.enquiryText ?? "", evidence: [] };
  state.bdOpportunity = { ...opportunity, nextMove: pending.nextMoveSummary };
  state.pendingBDNextMove = undefined;

  await logActivity(env, {
    entry: "Business Development next move approved",
    type: "Activity",
    area: "Business Development",
    activity: "Opportunity Development Hat's next-move recommendation approved by Martin.",
    outcome: "Active",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: OPPORTUNITY_DEVELOPMENT_HAT_NAME }, "Next move committed.");
  return state;
}

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
    return proposeOpportunityHandoff(env, state, "Sales", "Sales Executive", text);
  }

  if (actionName === "handoff_to_strategy") {
    return proposeOpportunityHandoff(env, state, "Strategy", "Strategy Analyst", text);
  }

  if (actionName === "develop_opportunity") {
    return proposeDevelopOpportunity(env, state);
  }

  if (actionName === "determine_next_move") {
    return proposeNextMove(env, state);
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
  responsibility:
    "Own the development of specific opportunities that could create meaningful growth for ENIG. Turn an observed market, organisation, partnership, channel, offering, or relationship signal into an evidenced BD opportunity that can either be developed further or handed to the appropriate ENIG Unit. Does not own the client/entity lifecycle once an opportunity becomes a genuine client-acquisition opportunity -- that boundary belongs to Sales.",
  actions: opportunityDevelopmentActions,
  readHandler: opportunityDevelopmentReadHandler,
  entryHandler: opportunityDevelopmentEntryHandler,
  awaitingHandlers: opportunityDevelopmentAwaitingHandlers,
};

// --- Partnership Development and Growth & Market Development: present so
// Hat resolution genuinely exercises three Hats (not one), but stubbed --
// same 8-action shape as Opportunity Development per their Notion Hat
// Definitions, pending the same real-implementation pass (including the
// same internal/write split qualify_partnership/qualify_growth_opportunity
// will need once built out).

type PartnershipDevelopmentAction =
  | "discover_partner"
  | "research_partner"
  | "assess_partnership"
  | "qualify_partnership"
  | "develop_partnership"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

const partnershipDevelopmentActions: ActionDefinition<PartnershipDevelopmentAction>[] = [
  { name: "discover_partner", consequence: "read", description: "Identify a potential partner or strategic relationship." },
  { name: "research_partner", consequence: "read", description: "Research the organisation, stakeholders, capabilities, and relationship context." },
  { name: "assess_partnership", consequence: "read", description: "Assess mutual value, strategic fit, and relationship viability." },
  { name: "qualify_partnership", consequence: "internal", description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated." },
  { name: "develop_partnership", consequence: "write", requiresApproval: true, description: "Develop a qualified partnership: stakeholders, value proposition, route, dependencies, risks." },
  { name: "determine_next_move", consequence: "write", requiresApproval: true, description: "Commit to the next concrete action for an active partnership opportunity." },
  { name: "handoff_to_sales", consequence: "write", requiresApproval: true, description: "Governed transition to Sales once the partnership becomes a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", consequence: "write", requiresApproval: true, description: "Governed transition to Strategy when the partnership needs strategic diagnosis." },
];

function notYetImplementedHat<A extends string>(hatName: string, responsibility: string, actions: ActionDefinition<A>[]): HatManifest<A> {
  return {
    name: hatName,
    responsibility,
    actions,
    readHandler: async (_env, actionName) => {
      throw new Error(`${hatName}.${actionName}: read handler not yet implemented -- draft manifest only.`);
    },
    entryHandler: async (_env, _state, actionName) => {
      throw new Error(`${hatName}.${actionName}: entry handler not yet implemented -- draft manifest only.`);
    },
    awaitingHandlers: {},
  };
}

const partnershipDevelopmentHat = notYetImplementedHat(
  "Partnerships Manager — Partnership Development",
  "Own the development of strategic relationships and partnership opportunities that could create meaningful value for ENIG. Identify, assess, and develop relationships where the relationship or partnership itself is the central business opportunity. Does not automatically own client acquisition, strategic diagnosis, or execution responsibilities belonging to another ENIG Unit.",
  partnershipDevelopmentActions,
);

type GrowthMarketDevelopmentAction =
  | "discover_growth_opportunity"
  | "research_market"
  | "assess_market_opportunity"
  | "qualify_growth_opportunity"
  | "develop_growth_opportunity"
  | "determine_next_move"
  | "handoff_to_sales"
  | "handoff_to_strategy";

const growthMarketDevelopmentActions: ActionDefinition<GrowthMarketDevelopmentAction>[] = [
  { name: "discover_growth_opportunity", consequence: "read", description: "Identify a potential market, channel, offering, or growth space." },
  { name: "research_market", consequence: "read", description: "Research market/industry signals, segments, channels, competitors, demand." },
  { name: "assess_market_opportunity", consequence: "read", description: "Assess market attractiveness, strategic/commercial relevance, capability fit." },
  { name: "qualify_growth_opportunity", consequence: "internal", description: "Apply the evidence threshold for Qualified / Held / Blocked. Held pauses on missing evidence -- execution state, never approval-gated." },
  { name: "develop_growth_opportunity", consequence: "write", requiresApproval: true, description: "Develop a qualified growth opportunity: value hypothesis, requirements, route, risks." },
  { name: "determine_next_move", consequence: "write", requiresApproval: true, description: "Commit to the next concrete action for an active growth opportunity." },
  { name: "handoff_to_sales", consequence: "write", requiresApproval: true, description: "Governed transition to Sales once the growth opportunity becomes a genuine client-acquisition opportunity." },
  { name: "handoff_to_strategy", consequence: "write", requiresApproval: true, description: "Governed transition to Strategy when the growth opportunity needs strategic diagnosis." },
];

const growthMarketDevelopmentHat = notYetImplementedHat(
  "Growth & Market Development Manager — Growth & Market Development",
  "Own the identification and development of broader opportunities for ENIG's growth across markets, channels, offerings, and growth directions. Identify, research, assess, and develop growth directions where the central question concerns ENIG's broader market position, expansion, channels, offerings, or future sources of growth. Does not automatically own client acquisition, strategic diagnosis, or execution responsibilities belonging to another ENIG Unit.",
  growthMarketDevelopmentActions,
);

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
