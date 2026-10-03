import type {
  Env,
  WorkState,
  QualificationResult,
  QualificationConditionResult,
  CommercialEvidence,
  ValueAtStake,
  EvidenceType,
  InvestmentToleranceContext,
  MeasurementBaseline,
} from "../../types";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import { mintApprovalProof, workSessionContext, workSessionReadContext } from "../../access";
import { recordWorkAction } from "../dispatch";
import type { ApprovalProof } from "../../types";
import {
  createPage,
  getPage,
  plainText,
  queryDataSource,
  relation,
  richText,
  select,
  title,
  uniqueId,
  updatePage,
} from "../../notion";
import { createHandoff, updateHandoff } from "../../handoffWriter";
import { generate, type GeneratePromptParts } from "../../ai";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage, sendOperationsMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult, SemanticTaskId } from "../../dataBoundary/types";
import { claimPendingHandoff } from "../../handoffLifecycle";
import { resolveEntityMatterFromTokens } from "../../identityResolution";
import { retrieveAndConsumeCallNotes } from "./callNotesRecord";

// Canonical Notion governance sources for this Hat. Explicit page IDs, not
// title search, per the Universal Role Contract's evidence rule (a
// consequential source must be attributable, not guessed at by name match).
const SALES_EXECUTIVE_HAT_DEFINITION_PAGE_ID = "3cfcb004-e583-810f-8281-c448edaa5de6";
// Only needed where an Agent call performs the actual Entity lifecycle
// judgment (qualification) — not fetched for stages where Entity handling
// is already mechanically enforced by code.
const ENTITY_BUSINESS_OBJECT_PAGE_ID = "3cecb004-e583-81a9-b95e-e6ab79a3e5f3";

// Plain-English labels for the Telegram-facing qualification message —
// the raw condition slugs (within_specialization, etc.) stay in the
// Activity Log's decisionRationale for traceability, but Martin shouldn't
// have to read snake_case.
const CONDITION_LABELS: Record<QualificationConditionResult["condition"], string> = {
  within_specialization: "Within our specialization",
  allows_diagnosis_first: "Open to a diagnosis-first approach",
  commercial_value_evidence: "Attributable commercial-value evidence",
  open_to_ballpark_amount_and_time: "Open to discussing budget & timeline",
  ready_to_commit_required_resources: "Ready to commit the resources needed",
};

// The four conditions the qualification AI call is trusted to judge
// directly. commercial_value_evidence is deliberately excluded -- per the
// Commercial Value & Pricing Operating Model, that condition's assessment
// is never taken from the AI's own say-so (see evaluateCommercialValueEvidence
// below); it's computed deterministically from state.commercialEvidence and
// spliced in regardless of what the AI returns for it.
const AI_JUDGED_CONDITIONS: QualificationConditionResult["condition"][] = [
  "within_specialization",
  "allows_diagnosis_first",
  "open_to_ballpark_amount_and_time",
  "ready_to_commit_required_resources",
];

function computeOverallQualification(
  conditions: QualificationConditionResult[],
): QualificationResult["overall"] {
  if (conditions.every((c) => c.assessment === "Satisfied")) return "Qualified";
  if (conditions.some((c) => c.assessment === "Not Satisfied")) return "Not Qualified";
  return "More Information Required";
}

function formatQualificationEvidence(conditions: QualificationConditionResult[]): string {
  return conditions
    .map((c) => {
      const label = CONDITION_LABELS[c.condition] ?? c.condition;
      const heading = c.assessment === "Satisfied" ? label : `${label} — ${c.assessment.toLowerCase()}`;
      return `• *${heading}*\n   ${c.evidence}`;
    })
    .join("\n\n");
}

interface SalesExecutiveGovernance {
  hatDefinition: string;
  universalRoleContract: string;
  entitySpecification?: string;
}

/**
 * Retrieves the governance this Hat operates under, at the granularity each
 * call site actually needs — Hat Definition + URC always; the Entity
 * specification only where the caller says it's performing a judgment the
 * Entity lifecycle governs. Returns null if any required source can't be
 * retrieved; callers must treat null as "cannot proceed," never substitute
 * hardcoded text in its place (mirrors Finance's getGovernance contract).
 */
async function getSalesExecutiveGovernance(
  env: Env,
  options: { includeEntitySpecification?: boolean } = {},
): Promise<SalesExecutiveGovernance | null> {
  const [hatDefinition, universalRoleContract, entitySpecification] = await Promise.all([
    getGovernance(env, SALES_EXECUTIVE_HAT_DEFINITION_PAGE_ID, "Sales Executive Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
    options.includeEntitySpecification
      ? getGovernance(env, ENTITY_BUSINESS_OBJECT_PAGE_ID, "Entity Business Object specification")
      : Promise.resolve(null),
  ]);
  if (!hatDefinition || !universalRoleContract) return null;
  if (options.includeEntitySpecification && !entitySpecification) return null;
  return { hatDefinition, universalRoleContract, entitySpecification: entitySpecification ?? undefined };
}

function buildSalesCallPrepPromptParts(hatDefinition: string, universalRoleContract: string): Pick<GeneratePromptParts, "persona" | "behavior" | "skillContent"> {
  return {
    persona:
      "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for this role — follow them exactly as written.",
    behavior: ["=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===", universalRoleContract, "=== HAT DEFINITION ===", hatDefinition].join("\n\n"),
    skillContent: [
      "=== TASK (execution context — not part of the governance above) ===",
      "Prepare Martin for a sales call: what we know, what's still unknown, and questions to ask to test the Hat Definition's canonical qualification conditions above. Keep it under 200 words, plain text, no markdown headers.",
    ].join("\n\n"),
  };
}

function buildQualificationPromptParts(
  hatDefinition: string,
  universalRoleContract: string,
  entitySpecification: string,
): Pick<GeneratePromptParts, "persona" | "behavior" | "context"> {
  return {
    persona:
      "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract, Hat Definition, and Entity Business Object specification are authoritative for evaluating the four canonical qualification conditions — follow them exactly as written. Never infer missing evidence.",
    behavior: [
      "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
      universalRoleContract,
      "=== HAT DEFINITION ===",
      hatDefinition,
      "=== ENTITY BUSINESS OBJECT SPECIFICATION ===",
      entitySpecification,
    ].join("\n\n"),
    context: [
      "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
      'Evaluate the within_specialization, allows_diagnosis_first, open_to_ballpark_amount_and_time, and ready_to_commit_required_resources conditions named above, strictly from the evidence given. Do NOT evaluate commercial_value_evidence -- that condition is assessed separately by a deterministic process and any assessment you give for it will be discarded. Return JSON: {"conditions":[{"condition":"<canonical condition key, exactly as given above>","evidence":"...","assessment":"Satisfied|Not Satisfied|Insufficient Evidence"}, ...for the four conditions listed above only...], "overall":"Qualified|Not Qualified|More Information Required"}. Your "overall" value is advisory only and will be recomputed once the commercial_value_evidence condition is spliced in.',
    ].join("\n\n"),
  };
}

interface RawValueAtStake {
  value?: number;
  low?: number;
  high?: number;
  currency?: string;
  period?: string;
  evidence_type?: string;
  source?: string;
  evidence_quality?: string;
  assumptions?: string;
  limitations?: string;
}

interface RawCommercialEvidenceExtraction {
  financial_consequence?: string;
  value_at_stake?: RawValueAtStake;
  cost_of_inaction?: RawValueAtStake;
  affected_revenue_or_opportunity?: string;
  desired_measurable_outcome?: string;
  uncertainty?: string;
  // Extracted separately from value evidence and never merged into it --
  // see InvestmentToleranceContext's doc comment for why.
  investment_tolerance_context?: {
    low?: number;
    high?: number;
    currency?: string;
    period?: string;
  };
}

const VALID_EVIDENCE_TYPES: EvidenceType[] = ["directly_measured", "client_estimated", "derived", "assumption"];

function normalizeValueAtStake(raw: RawValueAtStake | undefined): ValueAtStake | undefined {
  if (!raw) return undefined;
  const evidenceType = VALID_EVIDENCE_TYPES.includes(raw.evidence_type as EvidenceType)
    ? (raw.evidence_type as EvidenceType)
    : undefined;
  return {
    value: typeof raw.value === "number" ? raw.value : undefined,
    low: typeof raw.low === "number" ? raw.low : undefined,
    high: typeof raw.high === "number" ? raw.high : undefined,
    currency: raw.currency || undefined,
    period: raw.period || undefined,
    evidenceType,
    source: raw.source || undefined,
    evidenceQuality: raw.evidence_quality || undefined,
    assumptions: raw.assumptions || undefined,
    limitations: raw.limitations || undefined,
  };
}

function normalizeCommercialEvidence(raw: RawCommercialEvidenceExtraction | null): CommercialEvidence {
  return {
    financialConsequence: raw?.financial_consequence || undefined,
    valueAtStake: normalizeValueAtStake(raw?.value_at_stake),
    costOfInaction: normalizeValueAtStake(raw?.cost_of_inaction),
    affectedRevenueOrOpportunity: raw?.affected_revenue_or_opportunity || undefined,
    desiredMeasurableOutcome: raw?.desired_measurable_outcome || undefined,
    uncertainty: raw?.uncertainty || undefined,
  };
}

function normalizeInvestmentToleranceContext(
  raw: RawCommercialEvidenceExtraction | null,
): InvestmentToleranceContext | undefined {
  const t = raw?.investment_tolerance_context;
  if (!t) return undefined;
  if (typeof t.low !== "number" && typeof t.high !== "number") return undefined;
  return { low: t.low, high: t.high, currency: t.currency || undefined, period: t.period || undefined };
}

function buildCommercialEvidenceExtractionSystemPrompt(): string {
  return [
    "Extract structured commercial-value evidence from the supplied enquiry text and call notes, per ENIG's Commercial Value & Pricing Operating Model.",
    "Extract ONLY what is explicitly present in the text. Never invent, infer, or estimate a number that isn't attributable to something the client or Martin actually said. If a figure is genuinely absent, omit that field entirely rather than filling it with a guess, a percentage-of-revenue inference, or a derived assumption presented as fact.",
    "Distinguish evidence_type strictly: 'directly_measured' only if the text describes an actual measured/tracked figure (e.g. from records); 'client_estimated' if the client explicitly gave the figure as their own estimate; 'derived' only if the text shows the figure being calculated from other attributable figures also present in the text (state the derivation in 'assumptions'); 'assumption' if the figure has no real attribution at all -- including any figure YOU would have to infer or infer a percentage for. Never mark your own inference as directly_measured or client_estimated.",
    "Investment tolerance (what the client might be willing to invest) is NOT commercial-value evidence -- extract it separately into investment_tolerance_context, never into value_at_stake or cost_of_inaction. Annual turnover alone, a disclosed budget alone, or a bare willingness-to-pay statement are NOT value-at-stake or cost-of-inaction evidence either -- do not populate those fields from turnover/budget/WTP statements unless the text also ties a number to the specific business problem or opportunity.",
    "Respond with JSON: {\"financial_consequence\": \"...\", \"value_at_stake\": {\"value\":n|null,\"low\":n|null,\"high\":n|null,\"currency\":\"...\",\"period\":\"...\",\"evidence_type\":\"directly_measured|client_estimated|derived|assumption\",\"source\":\"...\",\"evidence_quality\":\"...\",\"assumptions\":\"...\",\"limitations\":\"...\"}, \"cost_of_inaction\": {...same shape...}, \"affected_revenue_or_opportunity\": \"...\", \"desired_measurable_outcome\": \"...\", \"uncertainty\": \"...\", \"investment_tolerance_context\": {\"low\":n|null,\"high\":n|null,\"currency\":\"...\",\"period\":\"...\"}}. Omit any field/sub-field you have no attributable evidence for -- do not fill it with null-as-a-guess or a placeholder string.",
  ].join("\n\n");
}

/**
 * Deterministically evaluates whether state.commercialEvidence satisfies
 * the commercial_value_evidence qualification condition. This is the sole
 * authority for that condition's assessment -- the qualification AI call's
 * own opinion of this condition (if it ventures one) is discarded and
 * replaced with this result, per the Commercial Value & Pricing Operating
 * Model's rule that missing/assumption-only numerical evidence must not be
 * filled or waved through by inference.
 */
function evaluateCommercialValueEvidence(evidence: CommercialEvidence | undefined): {
  assessment: QualificationConditionResult["assessment"];
  evidenceText: string;
} {
  const candidates = [evidence?.valueAtStake, evidence?.costOfInaction].filter(
    (v): v is ValueAtStake => v !== undefined,
  );
  const withNumber = candidates.filter((v) => typeof v.value === "number" || typeof v.low === "number" || typeof v.high === "number");

  if (withNumber.length === 0) {
    return {
      assessment: "Insufficient Evidence",
      evidenceText: "No numerical value connected to the business problem or opportunity has been established.",
    };
  }

  // Prefer a non-assumption candidate if one exists; an assumption-only
  // figure can never satisfy this condition on its own, even if a number
  // is technically present.
  const primary = withNumber.find((v) => v.evidenceType && v.evidenceType !== "assumption") ?? withNumber[0];

  if (!primary.evidenceType) {
    return {
      assessment: "Insufficient Evidence",
      evidenceText: "A numerical value is present but its evidence type (measured/client-estimated/derived/assumption) was not established.",
    };
  }
  if (primary.evidenceType === "assumption") {
    return {
      assessment: "Insufficient Evidence",
      evidenceText: "The only numerical value available is an unsupported assumption -- assumption-only evidence cannot satisfy this condition on its own.",
    };
  }
  if (!primary.source) {
    return {
      assessment: "Insufficient Evidence",
      evidenceText: "A numerical value is present but has no attributable source.",
    };
  }
  if (!primary.period) {
    return {
      assessment: "Insufficient Evidence",
      evidenceText: "A numerical value is present but its applicable time period is unknown, which the model requires for responsible judgment.",
    };
  }

  const amount =
    typeof primary.value === "number"
      ? String(primary.value)
      : primary.low !== undefined && primary.high !== undefined
        ? `${primary.low}-${primary.high}`
        : "unspecified amount";
  return {
    assessment: "Satisfied",
    evidenceText: `${primary.currency ?? ""} ${amount} over ${primary.period}, evidence type: ${primary.evidenceType}, source: ${primary.source}.`.trim(),
  };
}

/**
 * Preserves the commercial baseline established during qualification, for
 * later measurement per the Commercial Value & Pricing Operating Model's
 * Section 8. Deliberately does not invent a target/measurement period --
 * those aren't established yet at Lead->Prospect time; only what's already
 * known (the baseline itself) is carried forward.
 */
function buildMeasurementBaseline(evidence: CommercialEvidence | undefined): MeasurementBaseline | undefined {
  const primary = evidence?.valueAtStake?.value !== undefined || evidence?.valueAtStake?.low !== undefined
    ? evidence?.valueAtStake
    : evidence?.costOfInaction;
  if (!primary) return undefined;
  const baselineValue =
    typeof primary.value === "number"
      ? String(primary.value)
      : primary.low !== undefined && primary.high !== undefined
        ? `${primary.low}-${primary.high}`
        : undefined;
  if (!baselineValue) return undefined;
  return {
    baselineMetric: evidence?.affectedRevenueOrOpportunity ?? evidence?.financialConsequence,
    baselineValue: `${primary.currency ?? ""} ${baselineValue}`.trim(),
    baselinePeriod: primary.period,
    source: primary.source,
    evidenceQuality: primary.evidenceType,
    targetOutcome: evidence?.desiredMeasurableOutcome,
    assumptions: primary.assumptions,
    limitations: primary.limitations,
  };
}

function formatMeasurementBaselineText(baseline: MeasurementBaseline): string {
  return [
    "Commercial baseline (Measurement Baseline, Commercial Value & Pricing Operating Model §8):",
    baseline.baselineMetric ? `Metric: ${baseline.baselineMetric}` : null,
    baseline.baselineValue ? `Baseline value: ${baseline.baselineValue}` : null,
    baseline.baselinePeriod ? `Period: ${baseline.baselinePeriod}` : null,
    baseline.source ? `Source: ${baseline.source}` : null,
    baseline.evidenceQuality ? `Evidence type: ${baseline.evidenceQuality}` : null,
    baseline.targetOutcome ? `Desired measurable outcome: ${baseline.targetOutcome}` : null,
    baseline.assumptions ? `Assumptions: ${baseline.assumptions}` : null,
    baseline.limitations ? `Limitations: ${baseline.limitations}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Formats the structured commercial-value evidence for the Sales -> Finance
 * Handoff's "Verified Facts & Sources" text -- per the Commercial Value &
 * Pricing Operating Model, this is what carries the pricing basis to
 * Finance. Investment tolerance is included as an explicitly separate,
 * clearly-labeled context-only block -- never merged into the evidence
 * block above it, and never presented as if it were part of the pricing
 * basis.
 */
function formatCommercialEvidenceForHandoff(
  evidence: CommercialEvidence | undefined,
  investmentTolerance: InvestmentToleranceContext | undefined,
): string {
  const formatValueAtStake = (label: string, v: ValueAtStake | undefined): string | null => {
    if (!v) return null;
    const amount = typeof v.value === "number" ? String(v.value) : v.low !== undefined && v.high !== undefined ? `${v.low}-${v.high}` : null;
    if (!amount) return null;
    return [
      `${label}: ${v.currency ?? ""} ${amount}`.trim(),
      v.period ? `  period: ${v.period}` : null,
      v.evidenceType ? `  evidence type: ${v.evidenceType}` : null,
      v.source ? `  source: ${v.source}` : null,
      v.evidenceQuality ? `  evidence quality: ${v.evidenceQuality}` : null,
      v.assumptions ? `  assumptions: ${v.assumptions}` : null,
      v.limitations ? `  limitations: ${v.limitations}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const lines = [
    "=== Commercial-value evidence (pricing basis) ===",
    evidence?.financialConsequence ? `Financial consequence: ${evidence.financialConsequence}` : null,
    formatValueAtStake("Value at stake", evidence?.valueAtStake),
    formatValueAtStake("Cost of inaction", evidence?.costOfInaction),
    evidence?.affectedRevenueOrOpportunity ? `Affected revenue/opportunity: ${evidence.affectedRevenueOrOpportunity}` : null,
    evidence?.desiredMeasurableOutcome ? `Desired measurable outcome: ${evidence.desiredMeasurableOutcome}` : null,
    evidence?.uncertainty ? `Uncertainty: ${evidence.uncertainty}` : null,
    "=== Investment tolerance (CONTEXT ONLY -- never the pricing basis, never a substitute for the evidence above) ===",
    investmentTolerance && (investmentTolerance.low !== undefined || investmentTolerance.high !== undefined)
      ? `${investmentTolerance.currency ?? ""} ${investmentTolerance.low ?? "?"}-${investmentTolerance.high ?? "?"}${investmentTolerance.period ? ` (${investmentTolerance.period})` : ""}`.trim()
      : "None disclosed on record.",
  ].filter(Boolean);
  return lines.join("\n");
}

// REMOVED (2026-09-30, ENIG Operating Model implementation): the legacy
// identity-bearing Proposal path.
//
//   handleProposalApproval, handleProposalFeedback, and
//   buildProposalRevisionPromptParts
//
// It created Proposals DB records carrying Entity/Matter *relations* --
// real page ids for real people and organisations -- which directly
// contradicts the canonical token-safe Runtime Proposal model
// (tokenSafeProposal.ts), whose records carry Entity Token / Matter Token
// only. Two Proposal models writing structurally different records to one
// data source is the contradiction this removal resolves: there is now
// exactly one.
//
// It was also unreachable. The only code that ever sent a
// "proposal:<workId>:approve|revise" button was handleProposalFeedback,
// which is reachable only once state.awaiting === "proposal_feedback" --
// and that is set only by handleProposalApproval's reject branch, which is
// reachable only once state.stage === "awaiting_proposal_approval" --
// which is set only by handleProposalFeedback. A closed cycle with no entry
// point, so no legitimate Sales Executive responsibility is lost: proposal
// drafting, submission, approval, and revision are all served by the
// canonical flow, under the proposal_draft / proposal_submit /
// proposal_approve / proposal_revision Actions.


export async function handleIncomingEnquiry(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.enquiryText = text;
  state.entryType = "inbound_enquiry";
  await logActivity(env, {
    entry: `Incoming enquiry — work ${state.workId}`,
    type: "Activity",
    area: "Sales",
    activity: text,
    outcome: "Active",
  });

  // RUNTIME SALES IDENTITY BOUNDARY (Architect decision): Runtime Sales is
  // permanently token/identity-safe only. It used to extract name/email/phone
  // from the enquiry (sales.enquiry_extraction) and query the Entity store by
  // those properties -- both assumptions are stale: Name/Email/Phone were
  // removed from the operational Entity schema when the Identity Resolution
  // Registry was decided, and Runtime has no authority to establish or match
  // real-world identity (that is the isolated Sales Executive project's job).
  //
  // The only sanctioned way this Worker identifies an Entity is the
  // token-safe mechanism in identityResolution.ts (Entity_Token/Matter_Token
  // -> page IDs, deterministic, never a guess). A raw enquiry carries no
  // token, so there is nothing for that mechanism to resolve. Fail closed
  // here: no identity query, no Registry fallback, no invented record.
  await logActivity(env, {
    entry: `Sales enquiry held at the Runtime identity boundary — work ${state.workId}`,
    type: "Blocker",
    area: "Sales",
    decisionRationale:
      "Runtime Sales is token/identity-safe only: a raw enquiry carries no Entity/Matter token, so no Entity can be resolved through the sanctioned token-safe mechanism. Establishing and matching real-world identity belongs to the isolated Sales Executive project.",
    outcome: "Blocked",
  });
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `*New enquiry held — Runtime Sales identity boundary*\n\n` +
      `I can't take this further from here: Runtime Sales is token/identity-safe only, so it can't match or create an operational Entity from real-world identity (name / email / phone). ` +
      `Establishing and matching identity belongs to the isolated Sales Executive project, which hands Runtime a token-safe Handoff to pick up.\n\n` +
      `No Entity record was queried or created, and nothing was written to the Entity store.`,
  );
  state.stage = "identity_boundary_hold";
  state.awaiting = undefined;
  return state;
}

export async function handleEntityChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    return presentEntityDraft(env, state);
  }

  const page = await getPage(env, choice, workSessionContext(state));
  state.entityId = page.id;
  // Sanctioned identity-safe field only: the operational Entity schema has
  // no Name property (Identity Resolution Registry decision), so reading one
  // here would return nothing. `Entity Record` is the identity-safe title
  // the schema actually defines.
  state.entityName = plainText(page.properties["Entity Record"]);
  return proceedToMatterIdentification(env, state);
}

/**
 * Shows the drafted new-Entity record to Martin for approval before it's
 * created — per the Universal Role Contract's rule that drafted content is
 * shown in chat for approval before being written to Notion. Nothing is
 * written until handleEntityCreationApproval confirms it.
 */
async function presentEntityDraft(env: Env, state: WorkState): Promise<WorkState> {
  const draft = state.entityDraft ?? { name: "New contact", email: "", phone: "", type: "Individual" };
  state.entityDraft = draft;

  const details = [
    `Name: ${draft.name}`,
    `Type: ${draft.type}`,
    draft.email ? `Email: ${draft.email}` : null,
    draft.phone ? `Phone: ${draft.phone}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const entityDraftMessage = `*Proposed new Entity*\n\n${details}\n\nCreate this Entity?`;
  const entityDraftButtons = [
    [
      { text: "✅ Approve", callback_data: `entitynew:${state.workId}:approve` },
      { text: "🔁 Redo", callback_data: `entitynew:${state.workId}:redo` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: "Sales Executive" }, entityDraftMessage, entityDraftButtons);
  state.pendingActionSummary = {
    label: `New Entity: ${draft.name}`,
    message: entityDraftMessage,
    buttons: entityDraftButtons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_entity_creation_approval";
  state.awaiting = undefined;
  return state;
}

/**
 * The Access context for an operation performed on behalf of this Work item's
 * own recorded Action, optionally carrying an ApprovalProof a verified
 * approval callback has just minted.
 *
 * The Action is NOT named here -- it is read off the Work by
 * `workSessionContext(state)`. The `new_enquiry` flow performs several
 * distinct registered operations, and the Work records which one it is
 * performing; this helper cannot choose a different one.
 *
 * `assertedActionName` is a cross-check for the privileged commit:
 * `handleMatterCreationApproval` advances the Work to `create_matter` and
 * then asserts the name it just recorded. If the two ever disagree, Access
 * fails closed instead of committing the record under an Action that was not
 * the one approved. (`handleEntityCreationApproval` no longer commits --
 * Runtime Sales is token/identity-safe only, so the Entity create is refused
 * rather than performed; see the Runtime Sales identity boundary note there.)
 *
 * Everything else the flow touches -- status advances on records this work
 * item already owns, its outbound Finance Handoff's lifecycle, the
 * Sales -> Strategy Handoff -- is ungated bookkeeping, and is ungated because
 * each of those is now the operation it actually is, not because it was
 * exempted from a gate that applied to something else.
 */
function salesExecutiveAccess(state: WorkState, proof?: ApprovalProof, assertedActionName?: string) {
  return workSessionContext(state, proof, assertedActionName);
}

/**
 * Sales Executive's Action names, as registered on the Hat (see
 * salesManifest.ts).
 *
 * Named as constants rather than repeated as literals so the Action a
 * governed write is performed under, the Action recorded on the Work at that
 * moment, the Action named in the ApprovalProof, and the Action the call site
 * asserts as a cross-check all reference one value -- they cannot drift into
 * four different names for the same operation, and `recordWorkAction`
 * validates every one of them against the manifest before any is stored.
 *
 * There is deliberately no `create_entity` constant here: Runtime Sales is
 * token/identity-safe only, so it never performs the Entity create (the
 * manifest still declares the Action and its approval handler, but that
 * handler refuses the write -- see handleEntityCreationApproval).
 */
const NEW_ENQUIRY_ACTION = "new_enquiry" as const;
const CREATE_MATTER_ACTION = "create_matter" as const;

export async function handleEntityCreationApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!state.entityDraft) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "This Entity proposal has already been resolved -- nothing to do.",
    );
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "Got it — what should change about this Entity? Tell me what's off or what to take into account, and I'll redraft it.",
    );
    state.stage = "entity_redo_requested";
    state.awaiting = "entity_redo_reason";
    return state;
  }

  state.entityDraft = undefined;

  // RUNTIME SALES IDENTITY BOUNDARY (Architect decision): Runtime Sales does
  // not create operational Entity records. The operational Entity record holds
  // no real-world identity, while the staged draft carries exactly the identity
  // (name/email/phone) that only the isolated Sales Executive project is the
  // authority to establish and match -- and the properties this create used to
  // write (Name/Email/Phone) no longer exist on the Entity schema at all.
  //
  // So the governed create is refused fail-closed: no createPage, no
  // ApprovalProof minted, no Action recorded for a write that never happens.
  await logActivity(env, {
    entry: `Sales Entity creation refused at the Runtime identity boundary — work ${state.workId}`,
    type: "Blocker",
    area: "Sales",
    decisionRationale:
      "Runtime Sales is token/identity-safe only: an operational Entity may not be created from identity drafted out of an enquiry, and the Entity schema carries no Name/Email/Phone to write. Identity establishment belongs to the isolated Sales Executive project.",
    outcome: "Blocked",
  });
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `*Entity creation refused — Runtime Sales identity boundary*\n\n` +
      `Runtime Sales won't create this Entity: it's token/identity-safe only, and the operational Entity record doesn't carry real-world identity anyway. ` +
      `Raise it with the isolated Sales Executive project, which establishes the Entity and hands Runtime a token-safe Handoff.\n\n` +
      `No Entity record was created.`,
  );
  state.stage = "identity_boundary_hold";
  state.awaiting = undefined;
  return state;
}

export async function handleEntityRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const previous = state.entityDraft;
  const extracted = await generate<{ name?: string; organisation?: string; email?: string; phone?: string }>(env, {
    taskId: "sales.enquiry_extraction",
    mode: "json",
    parts: {
      persona: "Extract the sender's identifying details for a business Entity record. Return JSON: {name, organisation, email, phone}. Use empty string for anything not present. Never invent a value.",
      situation: `Original enquiry: ${state.enquiryText ?? ""}\n\nPrevious draft: ${JSON.stringify(previous ?? {})}\n\nMartin's redo reasoning: ${reasonText}`,
    },
    light: true,
  });
  const name = extracted?.organisation || extracted?.name || previous?.name || "New contact";
  state.entityDraft = {
    name,
    email: extracted?.email || previous?.email || "",
    phone: extracted?.phone || previous?.phone || "",
    type: extracted?.organisation ? "Organisation" : previous?.type || "Individual",
  };
  return presentEntityDraft(env, state);
}

async function proceedToMatterIdentification(env: Env, state: WorkState): Promise<WorkState> {
  const matters = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, workSessionReadContext(),  {
    property: "Entity",
    relation: { contains: state.entityId },
  });
  const openMatters = matters.filter((m) => {
    const status = plainText(m.properties.Status);
    return status !== "Closed" && status !== "Converted";
  });
  state.candidateMatters = openMatters.map((m) => ({ id: m.id, name: plainText(m.properties.Matter) }));

  const buttons = [
    ...openMatters.map((m) => [
      { text: `Use: ${plainText(m.properties.Matter)}`, callback_data: `matter:${state.workId}:${m.id}` },
    ]),
    [{ text: "➕ New Matter (distinct commercial work)", callback_data: `matter:${state.workId}:new` }],
  ];

  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `Entity: *${state.entityName}*.\n\nIs this enquiry part of existing commercial work, or a new Matter?`,
    buttons,
  );
  state.stage = "awaiting_matter_pick";
  state.awaiting = "matter_pick";
  return state;
}

export async function handleMatterChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    return draftNewMatter(env, state, state.enquiryText ?? "");
  }

  const page = await getPage(env, choice, workSessionContext(state));
  state.matterId = page.id;
  state.matterName = plainText(page.properties.Matter);
  await ensureEntityIsAtLeastLead(env, state);
  return prepareSalesCall(env, state);
}

/**
 * Drafts a new Matter's title + stated need and presents it to Martin for
 * approval — per the Sales AI Project Instructions' Matter identification
 * rule ("pass through the applicable creation authorization gate before
 * creating the Matter record"). Nothing is written to Notion until
 * handleMatterCreationApproval confirms it.
 */
async function draftNewMatter(env: Env, state: WorkState, guidance: string): Promise<WorkState> {
  const summary = await generate<{ name: string; stated_need: string }>(env, {
    taskId: "sales.matter_summary_drafting",
    mode: "json",
    parts: {
      persona: "From the enquiry text, produce a short Matter title (max 8 words) and a one-sentence Stated_need. Return JSON {name, stated_need}.",
      situation: guidance,
    },
    light: true,
  });
  const name = summary?.name || `Enquiry — ${state.entityName}`;
  const statedNeed = summary?.stated_need || state.enquiryText || "";
  state.matterDraft = { name, statedNeed };

  const matterDraftMessage = `*Proposed new Matter*\n\n*${name}*\n${statedNeed}\n\nCreate this Matter?`;
  const matterDraftButtons = [
    [
      { text: "✅ Approve", callback_data: `matternew:${state.workId}:approve` },
      { text: "🔁 Redo", callback_data: `matternew:${state.workId}:redo` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: "Sales Executive" }, matterDraftMessage, matterDraftButtons);
  state.pendingActionSummary = {
    label: `New Matter: ${name}`,
    message: matterDraftMessage,
    buttons: matterDraftButtons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_matter_creation_approval";
  state.awaiting = undefined;
  return state;
}

export async function handleMatterCreationApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!state.matterDraft) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "This Matter proposal has already been resolved -- nothing to do.",
    );
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "Got it — what should change about this Matter? Tell me what's off or what to take into account, and I'll redraft it.",
    );
    state.stage = "matter_redo_requested";
    state.awaiting = "matter_redo_reason";
    return state;
  }

  const draft = state.matterDraft!;
  // Same shape as the Entity gate above, for the same reason: the Work moves
  // from the enquiry workflow to the distinct operation of committing the
  // Matter record, and the proof is bound to that operation.
  recordWorkAction(state, CREATE_MATTER_ACTION);
  // The Matter record exists only because Martin approved this specific
  // draft, so minting happens here and the resulting proof is what
  // authorizes the governed create.
  const proof = mintApprovalProof({
    workId: state.workId,
    actionName: CREATE_MATTER_ACTION,
    targetDataSourceId: env.MATTERS_DATA_SOURCE_ID,
  });
  const page = await createPage(env, env.MATTERS_DATA_SOURCE_ID, {
    Matter: title(draft.name),
    Entity: relation([state.entityId!]),
    Status: select("Open"),
    Stated_need: richText(draft.statedNeed),
    Next_action: richText("Arrange sales call with Martin"),
    Evidence_source: richText(`Telegram enquiry, ${new Date().toISOString()}`),
  }, salesExecutiveAccess(state, proof, CREATE_MATTER_ACTION));
  state.matterId = page.id;
  state.matterName = draft.name;
  state.matterDraft = undefined;
  recordWorkAction(state, NEW_ENQUIRY_ACTION);
  await logActivity(env, {
    entry: `Matter created: ${draft.name}`,
    type: "Decision",
    area: "Sales",
    decisions: `New distinct unit of commercial work identified for ${state.entityName}.`,
    decisionRationale: "Approved by Martin.",
    outcome: "Complete",
  });

  await ensureEntityIsAtLeastLead(env, state);
  return prepareSalesCall(env, state);
}

export async function handleMatterRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const previous = state.matterDraft;
  const guidance = previous
    ? `Original enquiry: ${state.enquiryText ?? ""}\n\nPrevious draft: ${previous.name} — ${previous.statedNeed}\n\nMartin's redo reasoning: ${reasonText}`
    : `${state.enquiryText ?? ""}\n\nMartin's redo reasoning: ${reasonText}`;
  return draftNewMatter(env, state, guidance);
}

async function ensureEntityIsAtLeastLead(env: Env, state: WorkState): Promise<void> {
  const page = await getPage(env, state.entityId!, workSessionContext(state));
  const status = plainText(page.properties.Status);
  if (!status) {
    await updatePage(env, state.entityId!, { Status: select("Lead") }, salesExecutiveAccess(state));
  }
}

async function prepareSalesCall(env: Env, state: WorkState): Promise<WorkState> {
  const governance = await getSalesExecutiveGovernance(env);
  if (!governance) {
    console.error(`Sales Executive call-prep blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Sales-call preparation blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition and/or Universal Role Contract from Notion. Refusing to prepare the call brief without it.",
      outcome: "Blocked",
    });
    // No automatic retry trigger exists at this point in the flow (unlike
    // call notes or proposal feedback, nothing the user sends re-invokes
    // this step) — documented as a known limitation, not solved here.
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't prepare the sales-call brief for *${state.entityName}* — couldn't retrieve canonical governance from Notion. There's no automatic retry for this step; please try again once resolved.`,
    );
    return state;
  }

  const brief = await generate(env, {
    taskId: "sales.call_prep_briefing",
    mode: "text",
    parts: { ...buildSalesCallPrepPromptParts(governance.hatDefinition, governance.universalRoleContract), situation: `Entity: ${state.entityName}\nMatter: ${state.matterName}\nEnquiry: ${state.enquiryText}` },
  });

  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `*Sales call prep — ${state.entityName}*\n\n${brief}\n\nWhen the call is done, send me the call notes / insights as a message and I'll process qualification.`,
    [[{ text: "📞 Pull latest Read.ai call", callback_data: `pullcall:${state.workId}:` }]],
  );
  await logActivity(env, {
    entry: `Sales call prep sent for ${state.entityName}`,
    type: "Activity",
    area: "Sales",
    activity: brief,
    nextActions: "Awaiting Martin's sales call notes.",
    outcome: "Active",
  });
  state.stage = "awaiting_call";
  state.awaiting = "call_notes";
  return state;
}

/**
 * The shared commercial-value-evidence-extraction + qualification pipeline
 * -- used by both the live in-chat call-notes path (handleCallNotes) and
 * the token-safe Handoff pickup path (handleCallNotesHandoffPickup, for
 * the isolated Sales Executive project's Section 6A call-notes Handoffs).
 * Runs the same two AI calls and condition-merge logic against whatever
 * combinedText the caller supplies -- raw enquiry+call-notes text for the
 * live path, a Handoff's already de-identified sanitizedContext for the
 * pickup path -- so qualification reasoning behaves identically regardless
 * of where the call notes originated. Returns null when the AI assessment
 * was inconclusive; the caller decides how to surface that.
 *
 * taskIds is caller-supplied, not hardcoded, because the two call sites
 * are NOT the same trust level: handleCallNotes still feeds raw,
 * pre-tokenization text, so it must keep using the client_confidential
 * sales.commercial_evidence_extraction/sales.call_qualification taskIds;
 * handleCallNotesHandoffPickup's content is provably token-safe, so it
 * uses the business_sensitive _handoff siblings instead. Re-rating the
 * shared taskId itself would have made the still-raw live-chat path
 * eligible for a real provider too -- see dataBoundary/policy.ts's
 * PRODUCTION_TASK_SENSITIVITY doc comment.
 */
async function runQualificationAssessment(
  env: Env,
  state: WorkState,
  combinedText: string,
  governance: { hatDefinition: string; universalRoleContract: string; entitySpecification?: string },
  taskIds: { evidenceExtraction: SemanticTaskId; qualification: SemanticTaskId },
): Promise<{ qualification: QualificationResult; evidenceText: string } | null> {
  // Structured commercial-value evidence extraction, per the Commercial
  // Value & Pricing Operating Model -- run before qualification so the
  // deterministic evidence gate below has something to judge. Extraction
  // failure (null) is treated as "no evidence extracted," not a blocker --
  // evaluateCommercialValueEvidence already fails closed on empty input.
  const extraction = await generate<RawCommercialEvidenceExtraction>(env, {
    taskId: taskIds.evidenceExtraction,
    mode: "json",
    parts: { persona: buildCommercialEvidenceExtractionSystemPrompt(), situation: combinedText },
    light: true,
  });
  state.commercialEvidence = normalizeCommercialEvidence(extraction);
  state.investmentToleranceContext = normalizeInvestmentToleranceContext(extraction);
  const commercialValueResult = evaluateCommercialValueEvidence(state.commercialEvidence);
  await logActivity(env, {
    entry: `Commercial-value evidence gate: ${commercialValueResult.assessment} — ${state.entityName ?? state.matterToken ?? state.entityToken}`,
    type: "Decision",
    area: "Sales",
    decisionRationale: commercialValueResult.evidenceText,
    outcome: "Active",
  });

  const qualification = await generate<QualificationResult>(env, {
    taskId: taskIds.qualification,
    mode: "json",
    parts: { ...buildQualificationPromptParts(governance.hatDefinition, governance.universalRoleContract, governance.entitySpecification!), situation: combinedText },
  });

  const aiConditions = (qualification?.conditions ?? []).filter((c) => AI_JUDGED_CONDITIONS.includes(c.condition));
  if (!qualification || aiConditions.length !== AI_JUDGED_CONDITIONS.length) {
    return null;
  }

  // commercial_value_evidence is never taken from the AI's own output --
  // spliced in from the deterministic evaluation above, regardless of
  // whether/what the AI returned for that condition.
  const conditions: QualificationConditionResult[] = [
    ...aiConditions,
    { condition: "commercial_value_evidence", assessment: commercialValueResult.assessment, evidence: commercialValueResult.evidenceText },
  ];
  const overall = computeOverallQualification(conditions);
  qualification.conditions = conditions;
  qualification.overall = overall;
  state.qualification = qualification;

  await logActivity(env, {
    entry: `Qualification evaluated: ${qualification.overall}`,
    type: "Decision",
    area: "Sales",
    decisionRationale: qualification.conditions.map((c) => `${c.condition}: ${c.assessment} — ${c.evidence}`).join("\n"),
    outcome: qualification.overall === "Qualified" ? "Active" : "Complete",
  });

  if (qualification.overall === "Qualified") {
    // Preserve the commercial baseline for later measurement, per the
    // Commercial Value & Pricing Operating Model's Section 8 -- captured
    // once here, at the point qualification is established, rather than
    // re-derived downstream from whatever state happens to still be set.
    state.measurementBaseline = buildMeasurementBaseline(state.commercialEvidence);
  }

  return { qualification, evidenceText: formatQualificationEvidence(qualification.conditions) };
}

export async function handleCallNotes(env: Env, state: WorkState, notes: string): Promise<WorkState> {
  state.callNotes = state.callNotes ? `${state.callNotes}\n\n${notes}` : notes;

  await updatePage(env, state.matterId!, {
    Current_understanding: richText(state.callNotes.slice(0, 1900)),
  }, salesExecutiveAccess(state));

  const governance = await getSalesExecutiveGovernance(env, { includeEntitySpecification: true });
  if (!governance) {
    console.error(`Sales Executive qualification blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Qualification blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition, Universal Role Contract, and/or Entity Business Object specification from Notion. Refusing to evaluate qualification without it.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't evaluate qualification for *${state.entityName}* — couldn't retrieve canonical governance from Notion. Not proceeding without it. Send the call notes again once resolved and I'll re-evaluate.`,
    );
    state.awaiting = "call_notes";
    return state;
  }

  const combinedText = `Enquiry: ${state.enquiryText ?? ""}\n\nCall notes: ${state.callNotes}`;
  const result = await runQualificationAssessment(env, state, combinedText, governance, {
    evidenceExtraction: "sales.commercial_evidence_extraction",
    qualification: "sales.call_qualification",
  });

  if (!result) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "I couldn't determine qualification from the evidence given — the assessment was inconclusive. Please send additional call notes or clarification.",
    );
    state.awaiting = "call_notes";
    state.stage = "awaiting_call_clarification";
    return state;
  }

  const { qualification, evidenceText } = result;

  if (qualification.overall === "Qualified") {
    const qualifyMessage = `*Qualification: Qualified* — all five conditions met.\n\n${evidenceText}\n\nApprove Lead → Prospect for *${state.entityName}*?`;
    const qualifyButtons = [
      [
        { text: "✅ Approve Lead→Prospect", callback_data: `qualify:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `qualify:${state.workId}:redo` },
      ],
    ];
    await sendWorkspaceHatMessage(env, { ...state, hat: "Sales Executive" }, qualifyMessage, qualifyButtons);
    state.pendingActionSummary = {
      label: `Lead→Prospect: ${state.entityName}`,
      message: qualifyMessage,
      buttons: qualifyButtons,
      createdAt: new Date().toISOString(),
    };
    state.stage = "awaiting_qualification_approval";
    state.awaiting = undefined;
  } else if (qualification.overall === "More Information Required") {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `*Qualification: More Information Required*\n\n${evidenceText}\n\nSend the missing information and I'll re-evaluate.`,
    );
    state.stage = "awaiting_more_info";
    state.awaiting = "call_notes";
  } else {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `*Qualification: Not Qualified*\n\n${evidenceText}`,
    );
    await logActivity(env, {
      entry: `Work item closed — Not Qualified: ${state.entityName}`,
      type: "Activity",
      area: "Sales",
      outcome: "Complete",
    });
    state.stage = "closed_not_qualified";
    state.awaiting = undefined;
  }
  return state;
}

/**
 * Resolves a call-notes Handoff's token-safe business context, mirroring
 * Finance's resolveHandoffBusinessContext (valueBasedPricingAssessor.ts)
 * exactly -- reads Entity_Token/Matter_Token and the de-identified
 * narrative the isolated Sales Executive Claude project wrote to
 * "Verified Facts & Sources" (per this project's Section 6A Handoff-to-
 * Runtime-Sales-Executive procedure), and validates it through the same
 * closed-context contract every other Handoff pickup uses. Never resolves
 * entityToken/matterToken to a real Notion page -- per
 * HandoffContextContract's own rule, they are reference identifiers only,
 * never lookup keys into a controlled database.
 */
export async function resolveCallNotesHandoffContext(env: Env, handoffId: string): Promise<HandoffContextEvaluationResult> {
  try {
    const handoff = await getPage(env, handoffId, workSessionReadContext());
    const sanitizedContext = plainText(handoff.properties["Verified Facts & Sources"]);
    const entityToken = plainText(handoff.properties.Entity_Token);
    const matterToken = plainText(handoff.properties.Matter_Token);

    return evaluateHandoffContext(
      {
        handoffId,
        entityToken,
        matterToken,
        sanitizedContext,
        provenance: `notion:handoff:${handoffId}`,
        requiredCategory: "de-identified call notes for commercial qualification",
      },
      "sales.call_qualification_handoff",
    );
  } catch (err) {
    console.error(`Call-notes Handoff business-context reconstruction failed for ${handoffId}`, err);
    return {
      success: false,
      insufficientContext: {
        isInsufficient: true,
        category: "handoff record access",
        reason: `Insufficient execution context: unable to access Handoff record ${handoffId}.`,
      },
    };
  }
}

/**
 * Presents the live Telegram Lead->Prospect Approve/Redo decision for a
 * Qualified call-notes Handoff pickup -- extracted from
 * handleCallNotesHandoffPickup so it can be unit-tested directly, since
 * runQualificationAssessment's AI calls are policy-gated to zero eligible
 * providers in this environment today (pre-existing, out of scope; see
 * this file's own test suite for that constraint's documentation) and so
 * cannot be driven through in a test. Resolves the Handoff's own
 * Entity_Token/Matter_Token to their real page IDs (now authorized, per
 * the identity architecture decision recorded in Notion) and mirrors
 * handleCallNotes's own Qualified branch exactly -- entityName/matterName
 * are set to the tokens themselves, never a real name. A token that
 * doesn't resolve notifies Operations rather than presenting a decision
 * Runtime can't actually apply (it has no real entityId/matterId to write
 * Prospect/Qualified status to).
 */
export async function presentQualifiedCallNotesForApproval(
  env: Env,
  state: WorkState,
  entityToken: string,
  matterToken: string,
  displayToken: string,
  evidenceText: string,
): Promise<WorkState> {
  const resolved = await resolveEntityMatterFromTokens(env, entityToken, matterToken);
  if (!resolved) {
    await sendOperationsMessage(
      env,
      `⚠️ Sales qualification Qualified for ${displayToken}, but Lead→Prospect approval couldn't be presented -- Entity_Token/Matter_Token did not resolve to a real, related Entity/Matter record. Needs manual handling.`,
    ).catch((err) => console.error("Failed to send Lead-to-Prospect-not-presented Operations notice", err));
    state.stage = "handoff_closed_qualification_complete";
    return state;
  }

  state.entityId = resolved.entityId;
  state.matterId = resolved.matterId;
  state.entityName = entityToken;
  state.matterName = matterToken;
  const qualifyMessage = `*Qualification: Qualified* — all five conditions met.\n\n${evidenceText}\n\nApprove Lead → Prospect for *${displayToken}*?`;
  const qualifyButtons = [
    [
      { text: "✅ Approve Lead→Prospect", callback_data: `qualify:${state.workId}:approve` },
      { text: "🔁 Redo", callback_data: `qualify:${state.workId}:redo` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: "Sales Executive" }, qualifyMessage, qualifyButtons);
  state.pendingActionSummary = {
    label: `Lead→Prospect: ${displayToken}`,
    message: qualifyMessage,
    buttons: qualifyButtons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_qualification_approval";
  state.awaiting = undefined;
  return state;
}

/**
 * Runtime Sales Executive's pickup of a call-notes Handoff created by the
 * isolated Sales Executive Claude project (Section 6A of its Project
 * Instructions).
 *
 * **The Handoff is a routing/reference carrier, not the evidence.** It names
 * the governed Call Notes record to read via its `Call_Notes_ID` reference;
 * `retrieveAndConsumeCallNotes` resolves that reference to a single `Ready`
 * record, proves its Entity/Matter relations and its recorded
 * `Approval Attestation` against that record, and transitions it
 * `Ready -> Consumed`. Only the consumed record's own registry fields are then
 * passed into the same commercial-value-evidence-extraction and qualification
 * reasoning `handleCallNotes` runs for a live chat.
 *
 * The Handoff's de-identified narrative in `Verified Facts & Sources` is still
 * read and validated through `evaluateHandoffContext` -- it is what proves the
 * Handoff itself is identity-safe -- but its content is no longer qualified as
 * evidence. When the governed reference is present there is no fallback to it:
 * if the record cannot be retrieved and consumed, the Handoff is held and
 * nothing is qualified. That is the difference between the Handoff describing
 * which record to read and the Handoff pretending to be the record.
 *
 * On a Qualified result, this now presents the live Telegram Approve/Redo
 * buttons directly (the same handleLeadToProspectApproval flow
 * handleCallNotes uses) rather than only writing the result back to the
 * Handoff for the isolated project to complete separately. Per the
 * identity architecture decision recorded in Notion (Sept 2026), Runtime
 * is authorized to resolve a Handoff's own Entity_Token/Matter_Token to
 * their real operational page IDs directly (resolveEntityMatterFromTokens)
 * -- the premise that blocked this (no real Entity/Matter page access) no
 * longer holds. entityName/matterName are set to the tokens themselves,
 * never a real name. A token that doesn't resolve still writes back to
 * the Handoff (Held) for manual handling, exactly as before.
 * More-Information-Required and Not-Qualified outcomes are unchanged --
 * only Qualified needed a live Entity/Matter transition.
 *
 * Invoked only by checkHandoffs.ts's Sales discovery, never directly.
 */
export async function handleCallNotesHandoffPickup(env: Env, state: WorkState, _skills: ResolvedActionSkillSet): Promise<WorkState> {
  const claim = await claimPendingHandoff(env, state.handoffId!, workSessionContext(state));
  if (!claim.claimed) {
    console.error(`Sales call-notes pickup: refused -- ${claim.reason}`);
    await logActivity(env, {
      entry: `Sales call-notes pickup rejected — invalid Handoff state`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: claim.reason,
      outcome: "Blocked",
    });
    return state;
  }

  // PICKUP-ORIGIN PROVENANCE (Architect decision): the claim above is the
  // moment this Work item's origin becomes a fact -- Sales discovery created
  // the session for THIS Handoff and the Handoff accepted the claim. Record
  // it on the Work item now so it survives in the DO-backed WorkState through
  // qualification, the approval callback, and into handleInterventionText's
  // provenance gate.
  //
  // `handoff_pickup` is the existing provenance value for exactly this origin
  // (WorkOrigin in runtime/workContract.ts); it is read off the claim, never
  // synthesised, so a session that did not claim a real Handoff still has no
  // provenance and stays fail-closed at that gate. It is deliberately not
  // "direct_request": that value means work originated in chat rather than
  // via an upstream Handoff -- the opposite of what happened here.
  state.entryType = "handoff_pickup";

  const evalResult = await resolveCallNotesHandoffContext(env, state.handoffId!);
  if (!evalResult.success) {
    console.error(`Sales call-notes pickup: context evaluation failed for handoff ${state.handoffId}: ${evalResult.insufficientContext.reason}`);
    await logActivity(env, {
      entry: `Sales call-notes pickup blocked [Insufficient Context] — ${evalResult.insufficientContext.category}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(evalResult.insufficientContext.reason.slice(0, 1900)),
    }, workSessionContext(state)).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
    await sendOperationsMessage(
      env,
      `⚠️ Sales couldn't pick up a call-notes Handoff (${state.handoffId}): ${evalResult.insufficientContext.reason}`,
    ).catch((err) => console.error("Failed to send call-notes pickup Operations notice", err));
    state.stage = "handoff_held";
    return state;
  }

  const { contract } = evalResult;
  state.entityToken = contract.entityToken;
  state.matterToken = contract.matterToken;
  const displayToken = contract.matterToken ?? contract.entityToken;

  await updateHandoff(env, state.handoffId!, { Status: select("Picked-up") }, workSessionContext(state));

  // GOVERNED CALL NOTES CONSUMPTION (Architect decision): the Handoff now
  // carries a REFERENCE to the record, not the record's substance.
  // retrieveAndConsumeCallNotes resolves that reference to exactly one Ready
  // Call Notes record, proves the record's Entity/Matter relations and its
  // recorded Approval Attestation against that record, and only then advances
  // it Ready -> Consumed. Every one of those gates failing closed lands here,
  // on a held Handoff, with nothing qualified -- there is deliberately no
  // fallback to the Handoff's own narrative as Call Notes evidence once a
  // governed reference exists, because silently qualifying the old free-text
  // payload is the exact behaviour this path replaces.
  const consumption = await retrieveAndConsumeCallNotes(
    env,
    state.handoffId!,
    { entityToken: contract.entityToken, matterToken: contract.matterToken ?? "" },
    workSessionContext(state),
  );
  if (!consumption.ok) {
    console.error(`Sales call-notes pickup: ${consumption.reason}`);
    await logActivity(env, {
      entry: `Sales call-notes pickup blocked [Call Notes consumption] — ${displayToken}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: consumption.reason,
      outcome: "Blocked",
    });
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(consumption.reason.slice(0, 1900)),
    }, workSessionContext(state)).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
    await sendOperationsMessage(
      env,
      `⚠️ Sales couldn't consume the governed Call Notes record for ${displayToken}: ${consumption.reason}`,
    ).catch((err) => console.error("Failed to send call-notes consumption-failure Operations notice", err));
    state.stage = "handoff_held";
    return state;
  }

  // GATE 3 CONTINUATION (Architect decision): the consumed Call Notes
  // record's own registry fields become this session's business context, so a
  // legitimate pickup can satisfy handleInterventionText's Gate 3 (value-
  // relevant context) instead of reaching it with neither enquiry text nor
  // call notes.
  //
  // Why this is permitted and nothing else is: `consumption.evidenceText` is
  // built from the record this Handoff's Call_Notes_ID reference resolved to
  // -- the exact record whose Status was just advanced to Consumed, whose
  // Entity/Matter relations were compared to this Handoff's own tokens, and
  // whose Approval Attestation was re-hashed against those very fields. It is
  // never contract.sanitizedContext: the Handoff's narrative still proves the
  // Handoff is identity-safe upstream, but it is not Call Notes evidence, so
  // nothing is copied from it into the session. If the governed path had
  // failed we would already have returned above, so this assignment can never
  // be reached as a fallback -- and if the text were ever empty, callNotes
  // simply stays unset and Gate 3 refuses as it always did.
  state.callNotes = consumption.evidenceText;

  const governance = await getSalesExecutiveGovernance(env, { includeEntitySpecification: true });
  if (!governance) {
    console.error(`Sales call-notes pickup blocked — governance retrieval failed for handoff ${state.handoffId}`);
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(
        "Could not retrieve canonical Sales Executive Hat Definition, Universal Role Contract, and/or Entity Business Object specification from Notion.",
      ),
    }, workSessionContext(state)).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
    await sendOperationsMessage(
      env,
      `⚠️ Sales couldn't evaluate call notes for ${displayToken}: governance retrieval failed. Handoff held for retry.`,
    ).catch((err) => console.error("Failed to send call-notes governance-failure Operations notice", err));
    state.stage = "handoff_held";
    return state;
  }

  const result = await runQualificationAssessment(env, state, consumption.evidenceText, governance, {
    evidenceExtraction: "sales.commercial_evidence_extraction_handoff",
    qualification: "sales.call_qualification_handoff",
  });

  if (!result) {
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(
        "Qualification assessment was inconclusive from the consumed Call Notes record's registry fields. Re-open the record (and its Evidence Package) and re-submit.",
      ),
    }, workSessionContext(state)).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
    await sendOperationsMessage(
      env,
      `Sales qualification inconclusive for ${displayToken} — Handoff held, needs a richer Call Notes record.`,
    ).catch((err) => console.error("Failed to send inconclusive-qualification Operations notice", err));
    state.stage = "handoff_held";
    return state;
  }

  const { qualification, evidenceText } = result;

  await updateHandoff(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText(`Qualification: ${qualification.overall}\n\n${evidenceText}`.slice(0, 1900)),
  }, workSessionContext(state));
  await logActivity(env, {
    entry: `Call-notes Handoff closed — Qualification: ${qualification.overall}: ${displayToken}`,
    type: "Activity",
    area: "Sales",
    outcome: "Complete",
  });

  if (qualification.overall === "Qualified") {
    return presentQualifiedCallNotesForApproval(env, state, contract.entityToken, contract.matterToken ?? "", displayToken, evidenceText);
  }

  await sendOperationsMessage(
    env,
    `*Runtime Sales Executive qualification complete* — ${displayToken}: ${qualification.overall}.\n\nResult written back to the call-notes Handoff (${state.handoffId}).`,
  ).catch((err) => console.error("Failed to send qualification-complete Operations notice", err));

  state.stage = "handoff_closed_qualification_complete";
  return state;
}

export async function handleLeadToProspectApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (state.stage !== "awaiting_qualification_approval") {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "This qualification approval has already been resolved -- nothing to do.",
    );
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Got it — why isn't *${state.entityName}* ready to progress yet? Send what's missing or what to reconsider, and I'll re-evaluate qualification.`,
    );
    await logActivity(env, {
      entry: `Lead→Prospect redo requested: ${state.entityName}`,
      type: "Decision",
      area: "Sales",
      decisionRationale: "Martin requested a redo of the qualification assessment.",
      outcome: "Blocked",
    });
    state.stage = "qualification_hold";
    state.awaiting = "call_notes";
    return state;
  }

  await updatePage(env, state.entityId!, { Status: select("Prospect") }, salesExecutiveAccess(state));
  await updatePage(env, state.matterId!, {
    Status: select("Qualified"),
    // Preserves the commercial baseline on the Matter record itself (not
    // just in-memory WorkState) so it survives past this work item's
    // lifetime -- per the Commercial Value & Pricing Operating Model's
    // Section 8, using the existing Current_understanding field rather
    // than inventing a new Notion property.
    ...(state.measurementBaseline
      ? { Current_understanding: richText(`${state.callNotes ?? ""}\n\n${formatMeasurementBaselineText(state.measurementBaseline)}`.slice(0, 1900)) }
      : {}),
  }, salesExecutiveAccess(state));
  await logActivity(env, {
    entry: `Entity progressed to Prospect: ${state.entityName}`,
    type: "Decision",
    area: "Sales",
    decisions: "Lead→Prospect approved by Martin.",
    outcome: "Complete",
  });

  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `*${state.entityName}* is now a Prospect. What's the commercial situation Strategy should diagnose (the problem/opportunity, in your own words)? Send it as a message — no pricing/budget figures, just the situation.`,
  );
  state.stage = "awaiting_intervention";
  state.awaiting = "intervention";
  return state;
}

/**
 * The entry provenance values handleInterventionText will accept on the
 * Handoff. Typed against `WorkState["entryType"]` so the compiler rejects a
 * value here the Work type does not declare. The gate below checks membership
 * rather than mere truthiness, so a stray or fabricated provenance string
 * fails closed instead of riding through as "present" -- and because the
 * literal is checked against the union, removing a declared value is a
 * compile error while adding one only ever widens what must be proven here.
 */
const VALID_ENTRY_TYPES: ReadonlyArray<NonNullable<WorkState["entryType"]>> = [
  "inbound_enquiry",
  "outbound_outreach",
  "direct_request",
  "handoff_pickup",
];

/**
 * Creates the Sales -> Strategy Handoff after Martin approves Entity/
 * Prospect progression -- per the canonical commercial flow (Inbound ->
 * Sales -> Strategy -> Finance -> Sales), this REPLACES the obsolete
 * direct Sales -> Finance entry point. No intervention is sent to Finance
 * at this point -- Strategy owns diagnosing the situation and developing a
 * proposed intervention; Finance is reached only after Martin approves
 * that intervention (see strategyAnalyst.ts's handleInterventionApproval).
 * Sales's responsibility for this work session ends here; the runtime
 * waits for Strategy (via the existing discoverPendingStrategyHandoffs
 * discovery, never invoked in-process from this call).
 */
export async function handleInterventionText(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const trimmedSituation = text.trim();
  state.proposedIntervention = trimmedSituation;

  // Fail-closed gate 1: entry_type is required on the Handoff and must never
  // be invented or defaulted. In this Worker's current code paths it's set
  // either by handleIncomingEnquiry (inbound_enquiry) or by a Handoff pickup
  // that actually claimed its Handoff (handoff_pickup) -- if it is missing or
  // is not one of the declared provenance values, that's a code-path defect,
  // not something Martin can fix by sending a message, so this is logged as a
  // Blocker rather than treated as an awaiting-reply gap. The value is never
  // echoed back into the log: only the fact that it is missing or invalid.
  const entryTypeMissing = !state.entryType;
  if (!state.entryType || !VALID_ENTRY_TYPES.includes(state.entryType)) {
    console.error(`Sales Executive Handoff blocked -- ${entryTypeMissing ? "missing" : "invalid"} entry_type for work ${state.workId}`);
    await logActivity(env, {
      entry: `Sales -> Strategy Handoff blocked -- ${entryTypeMissing ? "missing" : "invalid"} entry_type: ${state.matterName ?? state.workId}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        `entry_type is ${entryTypeMissing ? "not set" : "not one of the declared provenance values"} on this work item before Handoff creation was attempted (${VALID_ENTRY_TYPES.join(" | ")}) -- refusing to invent one.`,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't route *${state.matterName}* to Strategy -- this work item is ${entryTypeMissing ? "missing" : "missing a valid"} entry type (how it originated). Not proceeding without it.`,
    );
    return state;
  }

  // Fail-closed gate 2: a description of the commercial situation is a
  // required Strategy input -- an empty/whitespace-only message must not
  // produce a Handoff with nothing for Strategy to diagnose.
  if (!trimmedSituation) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "That looked empty -- what's the commercial situation Strategy should diagnose? Send it as a message — no pricing/budget figures, just the situation.",
    );
    return state;
  }

  // Fail-closed gate 3: value-relevant context (the other required Strategy
  // input) must exist in some form -- enquiry text, call notes, or both.
  // Without it there is nothing for Strategy to diagnose against, and Sales
  // must not substitute or invent context to fill the gap.
  const valueContext = [state.enquiryText, state.callNotes].filter((v) => v && v.trim().length > 0).join("\n\n");
  if (!valueContext) {
    console.error(`Sales Executive Handoff blocked -- no value-relevant context for work ${state.workId}`);
    await logActivity(env, {
      entry: `Sales -> Strategy Handoff blocked -- no value-relevant context: ${state.matterName ?? state.workId}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: "Neither enquiry text nor call notes are present -- Strategy has nothing to diagnose against.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't route *${state.matterName}* to Strategy -- there's no value-relevant context on record (no enquiry text or call notes). Send call notes first, then I'll route it.`,
    );
    return state;
  }

  await updatePage(env, state.matterId!, {
    Status: select("Commercial Development"),
    Next_action: richText("Awaiting Strategy diagnosis"),
  }, salesExecutiveAccess(state));

  const identityTokens = await resolveIdentityTokens(env, state.entityId!, state.matterId!);
  state.entityToken = identityTokens.entityToken;
  state.matterToken = identityTokens.matterToken;

  const strategyHandoffIdentity = {
    entityToken: identityTokens.entityToken,
    matterToken: identityTokens.matterToken,
    entityName: state.entityName,
    matterName: state.matterName,
    email: state.entityDraft?.email,
    phone: state.entityDraft?.phone,
    contactName: state.entityDraft?.type === "Individual" ? state.entityDraft?.name : undefined,
  };

  const { page: handoff, sourceBoundaryAttestation } = await createHandoff(
    env,
    {
      Handoff: title(`Commercial diagnosis — ${identityTokens.matterToken}`),
      "From Unit": select("Sales"),
      "From Hat": richText("Sales Executive"),
      "To Unit": select("Strategy"),
      "To Hat": richText("Strategy Analyst"),
      Type: select("Work"),
      Status: select("Pending"),
      Reason: richText(`Commercial fit/progression approved for ${identityTokens.matterToken}. Entry type: ${state.entryType}.`),
      "Expected Output": richText("A strategic diagnosis and, where evidence supports one, a proposed intervention for Finance to price -- or an explicit Held status naming the specific blocker."),
      "Required Next Action": richText(
        "Diagnose the commercial situation (Symptom -> Problem -> Cause -> Constraint -> Consequence) and develop a proposed intervention where the evidence supports one. Do not send anything to Finance directly -- the proposed intervention requires Martin's explicit approval first.",
      ),
      "Acceptance Criteria": richText(
        "A diagnosis following Symptom -> Problem -> Cause -> Constraint -> Consequence, with either a defensible proposed intervention or an explicit Held status naming the specific blocker.",
      ),
      Entity_Token: richText(identityTokens.entityToken),
      Matter_Token: richText(identityTokens.matterToken),
      Assumptions: richText(
        "No disclosed budget or willingness-to-pay figure has been provided, and none should be used as a pricing input downstream.",
      ),
      "Verified Facts & Sources": richText(
        `Commercial situation: ${trimmedSituation}\n\n${formatCommercialEvidenceForHandoff(state.commercialEvidence, state.investmentToleranceContext)}\n\nRaw value context (enquiry + call notes):\n${valueContext}`.slice(
          0,
          1900,
        ),
      ),
    },
    strategyHandoffIdentity,
    salesExecutiveAccess(state),
  );

  // createHandoff already computed this attestation from exactly the
  // identity it validated strategyHandoffIdentity against -- see
  // handoffWriter.ts's HandoffSourceBoundaryAttestation. The DURABLE copy
  // of the same evidence is the marker createHandoff wrote into the
  // Handoff record itself (the fail-closed transport a fresh receiving
  // session reads); this WorkState copy is kept because the same-session
  // path still benefits from it, and for audit. See
  // WorkState.strategySourceBoundaryAttestation's own doc comment.
  state.strategySourceBoundaryAttestation = sourceBoundaryAttestation;

  state.handoffId = handoff.id;
  // Sales's execution ends here. Strategy is a separate Unit and must
  // discover and pick up this Handoff independently (see the scheduled
  // discoverPendingStrategyHandoffs run in index.ts) rather than being
  // invoked in-process from this call. This mapping is how that later,
  // separate invocation finds its way back to this work item.
  await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, state.workId);
  await logActivity(env, {
    entry: `Handoff to Strategy created: ${state.matterName}`,
    type: "Activity",
    area: "Sales",
    activity: `Handoff ${handoff.id} — commercial diagnosis requested. Source-boundary check result: ${sourceBoundaryAttestation.result} (secondary audit only -- the authoritative evidence is the attestation marker on the Handoff record itself).`,
    nextActions: "Strategy to pick up, diagnose, and propose an intervention for Martin's approval.",
    outcome: "Active",
  });

  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `Got it — routing *${state.matterName}* to Strategy for diagnosis. I'll let you know here once Strategy responds.`,
  );
  // Tells the caller (router.ts/index.ts) to trigger the existing
  // /checkhandoffs continuation immediately, in this same chat/thread,
  // rather than waiting for the next scheduled discovery cycle -- see
  // WorkState.pendingHandoffAutoCheck's doc comment.
  state.pendingHandoffAutoCheck = true;

  state.stage = "awaiting_strategy";
  state.awaiting = undefined;
  return state;
}

/**
 * Reads the Entity's and Matter's Unique ID tokens (e.g. "E-47", "M-12")
 * for embedding directly on a Handoff record. This is what lets Finance
 * (and any other Hat receiving a Handoff) identify the Entity/Matter
 * without ever reading the Entity or Matter page itself — the token is
 * carried on the Handoff, not resolved by the receiving Unit.
 */
async function resolveIdentityTokens(env: Env, entityId: string, matterId: string): Promise<{ entityToken: string; matterToken: string }> {
  const [entity, matter] = await Promise.all([getPage(env, entityId, workSessionReadContext()), getPage(env, matterId, workSessionReadContext())]);
  return {
    entityToken: uniqueId(entity.properties.Entity_ID),
    matterToken: uniqueId(matter.properties.Matter_ID),
  };
}

export async function handleMoreValueContext(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.proposedIntervention = `${state.proposedIntervention}\n\nAdditional value context: ${text}`;
  // Sales's authority here is mechanical only: record the new content and
  // make the Handoff queue-eligible again. This is not a determination that
  // Finance's Hold gate is resolved -- Finance's own judgment in
  // handlePickup (invoked only via independent discovery, never from here)
  // remains the sole authority over sufficiency and the resulting
  // Held/Closed outcome. Sales's execution ends here.
  await updateHandoff(
    env,
    state.handoffId!,
    {
      "Verified Facts & Sources": richText(
        `Proposed intervention + value context:\n${state.proposedIntervention}`.slice(0, 1900),
      ),
      Status: select("Pending"),
    },
    salesExecutiveAccess(state),
    {
      entityToken: state.entityToken ?? "",
      matterToken: state.matterToken ?? "",
      entityName: state.entityName,
      matterName: state.matterName,
    },
  );
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `Got it — added to the Handoff for *${state.entityName}* and queued for Finance to reassess. I'll let you know here once Finance responds.`,
  );
  return state;
}

// REMOVED (2026-09-30, ENIG Operating Model implementation): the legacy
// identity-bearing Proposal path.
//
//   handleProposalApproval, handleProposalFeedback, and
//   buildProposalRevisionPromptParts
//
// It created Proposals DB records carrying Entity/Matter *relations* --
// real page ids for real people and organisations -- which directly
// contradicts the canonical token-safe Runtime Proposal model
// (tokenSafeProposal.ts), whose records carry Entity Token / Matter Token
// only. Two Proposal models writing structurally different records to one
// data source is the contradiction this removal resolves: there is now
// exactly one.
//
// It was also unreachable. The only code that ever sent a
// "proposal:<workId>:approve|revise" button was handleProposalFeedback,
// which is reachable only once state.awaiting === "proposal_feedback" --
// and that is set only by handleProposalApproval's reject branch, which is
// reachable only once state.stage === "awaiting_proposal_approval" --
// which is set only by handleProposalFeedback. A closed cycle with no entry
// point, so no legitimate Sales Executive responsibility is lost: proposal
// drafting, submission, approval, and revision are all served by the
// canonical flow, under the proposal_draft / proposal_submit /
// proposal_approve / proposal_revision Actions.

// REMOVED (2026-10-02, RUNTIME SALES IDENTITY BOUNDARY decision): the
// identity-matching helpers
//
//   findEntityMatch, EntityMatchResult
//
// They queried the operational Entity store by Email, Phone, and Name -- all
// three properties removed from the Entity schema by the Identity Resolution
// Registry decision, so every query was a stale schema assumption (and a
// Notion 400 when it ran). They also encoded the very act Runtime Sales is
// now permanently barred from: establishing or matching real-world identity.
// Entity identification at Runtime is the token-safe mechanism in
// identityResolution.ts only; a work item that cannot be resolved through it
// fails closed (see handleIncomingEnquiry) rather than falling back to
// identity matching or the Identity Resolution Registry.

// Exported for unit testing only -- these are the deterministic Commercial
// Value & Pricing Operating Model helpers (evidence normalization, the
// evidence-quality gate, the measurement baseline, and the Handoff evidence
// formatting). No other module imports these; handleCallNotes and
// handleInterventionText remain the only production call sites.
export {
  normalizeCommercialEvidence,
  normalizeInvestmentToleranceContext,
  evaluateCommercialValueEvidence,
  computeOverallQualification,
  buildMeasurementBaseline,
  formatCommercialEvidenceForHandoff,
};
