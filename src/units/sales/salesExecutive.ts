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
import { createHandoff, updateHandoff, identityFieldsPresent } from "../../handoffWriter";
import { aiJson, aiText } from "../../ai";
import { logActivity } from "../../log";
import { sendWorkspaceHatMessage, sendOperationsMessage } from "../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../governance";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import type { HandoffContextEvaluationResult } from "../../dataBoundary/types";
import { claimPendingHandoff } from "../../handoffLifecycle";

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

/**
 * Reads the authoritative quote back off the Finance -> Sales Handoff's own
 * "Verified Facts & Sources" field, per the same context_transfer discipline
 * Finance's own resolveHandoffBusinessContext applies in the other
 * direction — the receiving Unit reconstructs from the Handoff record
 * itself, never trusts the sending Unit's (or its own prior) session state
 * for a value that crossed a Unit boundary. Returns null on any parse
 * failure; callers must treat null as "cannot proceed."
 */
function parseAuthoritativeQuote(verifiedFactsAndSources: string): { price: number; currency?: string; rationale: string } | null {
  // Matches both the current "Authoritative quote: <CURRENCY> <amount>"
  // format (e.g. "GHS 420000") and the legacy "$<amount>" format still
  // possible on an in-flight Handoff created before currency was carried
  // through explicitly -- a bare "$" is read as USD for that legacy case
  // only, never assumed for a currency-code-prefixed quote.
  const priceMatch = verifiedFactsAndSources.match(/Authoritative quote:\s*(?:([A-Za-z]{2,5})\s+)?(\$)?\s*([\d,]+(?:\.\d+)?)/);
  if (!priceMatch) return null;
  const price = Number(priceMatch[3].replace(/,/g, ""));
  if (!Number.isFinite(price)) return null;
  const currency = priceMatch[1] ?? (priceMatch[2] ? "USD" : undefined);
  const rationaleMatch = verifiedFactsAndSources.match(/Rationale:\s*([\s\S]*)/);
  return { price, currency, rationale: rationaleMatch ? rationaleMatch[1].trim() : "" };
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

function buildSalesCallPrepSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for this role — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution context — not part of the governance above) ===",
    "Prepare Martin for a sales call: what we know, what's still unknown, and questions to ask to test the Hat Definition's canonical qualification conditions above. Keep it under 200 words, plain text, no markdown headers.",
  ].join("\n\n");
}

function buildQualificationSystemPrompt(
  hatDefinition: string,
  universalRoleContract: string,
  entitySpecification: string,
): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract, Hat Definition, and Entity Business Object specification are authoritative for evaluating the four canonical qualification conditions — follow them exactly as written. Never infer missing evidence.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== ENTITY BUSINESS OBJECT SPECIFICATION ===",
    entitySpecification,
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    'Evaluate the within_specialization, allows_diagnosis_first, open_to_ballpark_amount_and_time, and ready_to_commit_required_resources conditions named above, strictly from the evidence given. Do NOT evaluate commercial_value_evidence -- that condition is assessed separately by a deterministic process and any assessment you give for it will be discarded. Return JSON: {"conditions":[{"condition":"<canonical condition key, exactly as given above>","evidence":"...","assessment":"Satisfied|Not Satisfied|Insufficient Evidence"}, ...for the four conditions listed above only...], "overall":"Qualified|Not Qualified|More Information Required"}. Your "overall" value is advisory only and will be recomputed once the commercial_value_evidence condition is spliced in.',
  ].join("\n\n");
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

function buildProposalDraftingSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for the Draft Proposal's required content, structure, and authority limits — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution context — not part of the governance above) ===",
    "Draft the complete client-facing Draft Proposal for the entity/matter/quote data given below, following the Hat Definition's proposal_content_standard exactly (section headers, order, and content rules) and its authority_limits (the quoted price must not be altered, converted, or reinterpreted; internal Finance reasoning not intended for the client must not be disclosed). Keep it concise and professional.",
  ].join("\n\n");
}

function buildProposalRevisionSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for how this Draft Proposal may be revised and for the authority limits that apply — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution context — not part of the governance above) ===",
    "Revise the current Draft Proposal below according to Martin's feedback, keeping the same section structure per the Hat Definition's proposal_content_standard. Per the Hat Definition's authority_limits, you have no authority to change the quoted price — if Martin's feedback appears to require a price change, do not apply it: keep the existing price and add a note prefixed 'NOTE TO MARTIN:' explaining the conflict.",
  ].join("\n\n");
}

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

  const extracted = await aiJson<{ name?: string; organisation?: string; email?: string; phone?: string }>(env, {
    taskId: "sales.enquiry_extraction",
    system:
      "Extract the sender's identifying details from an incoming business enquiry. Return JSON: {name, organisation, email, phone}. Use empty string for anything not present. Never invent a value.",
    user: text,
    light: true,
  });

  const name = extracted?.organisation || extracted?.name || "";
  const email = extracted?.email || "";
  const phone = extracted?.phone || "";

  const match = await findEntityMatch(env, name, email, phone);

  // one_determinate_match: use existing Entity directly — a clean email or
  // phone match doesn't need a confirmation click per the Sales AI Project
  // Instructions' entity_identification outcomes.
  if (match.determinate) {
    const page = await getPage(env, match.determinate.id);
    state.entityId = page.id;
    state.entityName = plainText(page.properties.Name);
    await logActivity(env, {
      entry: `Entity matched: ${state.entityName}`,
      type: "Activity",
      area: "Sales",
      activity: `Determinate match (email/phone) for incoming enquiry — using existing Entity.`,
      outcome: "Active",
    });
    return proceedToMatterIdentification(env, state);
  }

  const candidates = match.plausible;
  state.candidateEntities = candidates.map((c) => ({ id: c.id, name: c.name }));

  const buttons = [
    ...candidates.map((c) => [{ text: `Use: ${c.name}`, callback_data: `entity:${state.workId}:${c.id}` }]),
    [{ text: `➕ Create new Entity${name ? `: ${name}` : ""}`, callback_data: `entity:${state.workId}:new` }],
  ];

  state.entityDraft = { name: name || "New contact", email, phone, type: extracted?.organisation ? "Organisation" : "Individual" };

  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `*New enquiry*\n\n${text}\n\nIs this an existing Entity, or should I create a new one?`,
    buttons,
  );
  state.stage = "awaiting_entity_pick";
  state.awaiting = "entity_pick";
  return state;
}

export async function handleEntityChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    return presentEntityDraft(env, state);
  }

  const page = await getPage(env, choice);
  state.entityId = page.id;
  state.entityName = plainText(page.properties.Name);
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

  const draft = state.entityDraft!;
  const page = await createPage(env, env.ENTITY_DATA_SOURCE_ID, {
    Name: title(draft.name),
    "Entity Type": select(draft.type),
    Status: select("Lead"),
    ...(draft.email ? { Email: { email: draft.email } } : {}),
    ...(draft.phone ? { Phone: { phone_number: draft.phone } } : {}),
  });
  state.entityId = page.id;
  state.entityName = draft.name;
  state.entityDraft = undefined;
  await logActivity(env, {
    entry: `Entity created: ${draft.name}`,
    type: "Decision",
    area: "Sales",
    decisions: `Created new Entity for work ${state.workId}`,
    decisionRationale: "No existing Entity record matched the incoming enquiry. Approved by Martin.",
    outcome: "Complete",
  });

  return proceedToMatterIdentification(env, state);
}

export async function handleEntityRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const previous = state.entityDraft;
  const extracted = await aiJson<{ name?: string; organisation?: string; email?: string; phone?: string }>(env, {
    taskId: "sales.enquiry_extraction",
    system:
      "Extract the sender's identifying details for a business Entity record. Return JSON: {name, organisation, email, phone}. Use empty string for anything not present. Never invent a value.",
    user: `Original enquiry: ${state.enquiryText ?? ""}\n\nPrevious draft: ${JSON.stringify(previous ?? {})}\n\nMartin's redo reasoning: ${reasonText}`,
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
  const matters = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, {
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

  const page = await getPage(env, choice);
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
  const summary = await aiJson<{ name: string; stated_need: string }>(env, {
    taskId: "sales.matter_summary_drafting",
    system:
      "From the enquiry text, produce a short Matter title (max 8 words) and a one-sentence Stated_need. Return JSON {name, stated_need}.",
    user: guidance,
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
  const page = await createPage(env, env.MATTERS_DATA_SOURCE_ID, {
    Matter: title(draft.name),
    Entity: relation([state.entityId!]),
    Status: select("Open"),
    Stated_need: richText(draft.statedNeed),
    Next_action: richText("Arrange sales call with Martin"),
    Evidence_source: richText(`Telegram enquiry, ${new Date().toISOString()}`),
  });
  state.matterId = page.id;
  state.matterName = draft.name;
  state.matterDraft = undefined;
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
  const page = await getPage(env, state.entityId!);
  const status = plainText(page.properties.Status);
  if (!status) {
    await updatePage(env, state.entityId!, { Status: select("Lead") });
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

  const brief = await aiText(
    env,
    "sales.call_prep_briefing",
    buildSalesCallPrepSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    `Entity: ${state.entityName}\nMatter: ${state.matterName}\nEnquiry: ${state.enquiryText}`,
  );

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
 */
async function runQualificationAssessment(
  env: Env,
  state: WorkState,
  combinedText: string,
  governance: { hatDefinition: string; universalRoleContract: string; entitySpecification?: string },
): Promise<{ qualification: QualificationResult; evidenceText: string } | null> {
  // Structured commercial-value evidence extraction, per the Commercial
  // Value & Pricing Operating Model -- run before qualification so the
  // deterministic evidence gate below has something to judge. Extraction
  // failure (null) is treated as "no evidence extracted," not a blocker --
  // evaluateCommercialValueEvidence already fails closed on empty input.
  const extraction = await aiJson<RawCommercialEvidenceExtraction>(env, {
    taskId: "sales.commercial_evidence_extraction",
    system: buildCommercialEvidenceExtractionSystemPrompt(),
    user: combinedText,
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

  const qualification = await aiJson<QualificationResult>(env, {
    taskId: "sales.call_qualification",
    system: buildQualificationSystemPrompt(governance.hatDefinition, governance.universalRoleContract, governance.entitySpecification!),
    user: combinedText,
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
  });

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
  const result = await runQualificationAssessment(env, state, combinedText, governance);

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
    const handoff = await getPage(env, handoffId);
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
      "sales.call_qualification",
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
 * Runtime Sales Executive's pickup of a call-notes Handoff created by the
 * isolated Sales Executive Claude project (Section 6A of its Project
 * Instructions). The de-identified narrative it produced is already
 * token-safe, so this runs the same commercial-value-evidence-extraction
 * and qualification reasoning handleCallNotes runs for a live chat, just
 * against contract.sanitizedContext instead of raw enquiry/call-notes
 * text.
 *
 * Deliberately does NOT offer a live Telegram Approve/Redo button or
 * attempt a Lead->Prospect Entity.Status transition the way handleCallNotes
 * does: this session never resolves a real Entity/Matter page (only
 * entityToken/matterToken), and HandoffContextContract's own rule forbids
 * treating a token as a lookup key into a controlled database. Instead the
 * qualification result is written back to THIS Handoff only (Closed, token-
 * safe Work Completed) for the isolated Sales Executive project -- which
 * already holds legitimate real-identity access -- to pick up on its own
 * next Handoff check and complete any Lead->Prospect approval with Martin
 * itself, per the Entity Business Object's own lifecycle.
 *
 * Invoked only by checkHandoffs.ts's Sales discovery, never directly.
 */
export async function handleCallNotesHandoffPickup(env: Env, state: WorkState): Promise<WorkState> {
  const claim = await claimPendingHandoff(env, state.handoffId!);
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
    }).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
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

  await updateHandoff(env, state.handoffId!, { Status: select("Picked-up") });

  const governance = await getSalesExecutiveGovernance(env, { includeEntitySpecification: true });
  if (!governance) {
    console.error(`Sales call-notes pickup blocked — governance retrieval failed for handoff ${state.handoffId}`);
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(
        "Could not retrieve canonical Sales Executive Hat Definition, Universal Role Contract, and/or Entity Business Object specification from Notion.",
      ),
    }).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
    await sendOperationsMessage(
      env,
      `⚠️ Sales couldn't evaluate call notes for ${displayToken}: governance retrieval failed. Handoff held for retry.`,
    ).catch((err) => console.error("Failed to send call-notes governance-failure Operations notice", err));
    state.stage = "handoff_held";
    return state;
  }

  const result = await runQualificationAssessment(env, state, contract.sanitizedContext, governance);

  if (!result) {
    await updateHandoff(env, state.handoffId!, {
      Status: select("Held"),
      "Open Questions": richText(
        "Qualification assessment was inconclusive from the supplied call notes. Send additional de-identified call notes and re-submit.",
      ),
    }).catch((err) => console.error(`Sales: failed to mark call-notes Handoff ${state.handoffId} Held`, err));
    await sendOperationsMessage(
      env,
      `Sales qualification inconclusive for ${displayToken} — Handoff held, needs additional call notes.`,
    ).catch((err) => console.error("Failed to send inconclusive-qualification Operations notice", err));
    state.stage = "handoff_held";
    return state;
  }

  const { qualification, evidenceText } = result;

  await updateHandoff(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText(`Qualification: ${qualification.overall}\n\n${evidenceText}`.slice(0, 1900)),
  });
  await logActivity(env, {
    entry: `Call-notes Handoff closed — Qualification: ${qualification.overall}: ${displayToken}`,
    type: "Activity",
    area: "Sales",
    outcome: "Complete",
  });
  await sendOperationsMessage(
    env,
    `*Runtime Sales Executive qualification complete* — ${displayToken}: ${qualification.overall}.\n\nResult written back to the call-notes Handoff (${state.handoffId}) for the isolated Sales Executive project to review and, if Qualified, complete the Lead→Prospect approval with Martin.`,
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

  await updatePage(env, state.entityId!, { Status: select("Prospect") });
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
  });
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
  // by handleIncomingEnquiry (inbound_enquiry) -- if it's missing, that's a
  // code-path defect, not something Martin can fix by sending a message, so
  // this is logged as a Blocker rather than treated as an awaiting-reply gap.
  if (!state.entryType) {
    console.error(`Sales Executive Handoff blocked -- missing entry_type for work ${state.workId}`);
    await logActivity(env, {
      entry: `Sales -> Strategy Handoff blocked -- missing entry_type: ${state.matterName ?? state.workId}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        "entry_type (inbound_enquiry | outbound_outreach) was not set on this work item before Handoff creation was attempted -- refusing to invent one.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't route *${state.matterName}* to Strategy -- this work item is missing its entry type (how it originated). Not proceeding without it.`,
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
  });

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

  const handoff = await createHandoff(
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
  );

  // The Handoff write above already ran createHandoff's known-identity
  // check (findViolation, via handoffWriter.ts) against exactly
  // strategyHandoffIdentity -- reaching this line means it passed (a
  // violation throws before createPage is ever called, so this line is
  // never reached on failure). This records WHICH known-identity fields
  // were actually available and checked at that moment -- never the
  // values themselves -- so presentStrategyProposalForApproval can later
  // honestly attest that the Strategy Proposal was checked against the
  // same known-identity set the source boundary already was. See
  // WorkState.strategySourceBoundaryAttestation's own doc comment.
  state.strategySourceBoundaryAttestation = {
    handoffId: handoff.id,
    checked: true,
    identityFieldsChecked: identityFieldsPresent(strategyHandoffIdentity),
  };

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
    activity: `Handoff ${handoff.id} — commercial diagnosis requested.`,
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
  const [entity, matter] = await Promise.all([getPage(env, entityId), getPage(env, matterId)]);
  return {
    entityToken: uniqueId(entity.properties["Entity ID"]),
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

/**
 * The Sales side of the Finance -> Sales execution boundary. Invoked only
 * via runProposalDrafting, itself only invoked by index.ts's scheduled
 * Sales-Handoff discovery once a Pending Handoff (the quote Martin
 * approved) addressed to Sales is found — never called in-process from
 * Finance's own approval handler.
 */
export async function handleQuoteReceived(env: Env, state: WorkState): Promise<WorkState> {
  const handoff = await getPage(env, state.handoffId!);
  const rawFacts = plainText(handoff.properties["Verified Facts & Sources"]);
  const entityToken = plainText(handoff.properties.Entity_Token);
  const matterToken = plainText(handoff.properties.Matter_Token);

  const evalResult = evaluateHandoffContext(
    {
      handoffId: state.handoffId!,
      entityToken,
      matterToken,
      sanitizedContext: rawFacts,
      provenance: `notion:handoff:${state.handoffId!}`,
      requiredCategory: "authoritative quote and proposal scope",
    },
    "sales.proposal_drafting",
  );

  if (!evalResult.success) {
    console.error(`Sales Executive proposal drafting blocked — context evaluation failed for Handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Draft Proposal blocked [Insufficient Context] — ${evalResult.insufficientContext.category}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: evalResult.insufficientContext.reason,
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't prepare Draft Proposal for *${state.entityName}*: ${evalResult.insufficientContext.reason}\n\nNot proceeding without required sanitized context — will retry automatically once supplied.`,
    );
    return state;
  }

  const quote = parseAuthoritativeQuote(evalResult.contract.sanitizedContext);
  if (!quote) {
    console.error(`Sales Executive proposal drafting blocked — could not read the authoritative quote from Handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Draft Proposal blocked — quote unreadable from Handoff: ${state.entityName}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        "Could not read the authoritative Finance quote from the Handoff's own Notion record. Refusing to proceed without it; Handoff left Pending for automatic retry.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't read the Finance quote for *${state.entityName}* from its Handoff record. Not proceeding without it — will retry automatically on the next discovery cycle.`,
    );
    return state;
  }

  const governance = await getSalesExecutiveGovernance(env);
  if (!governance) {
    console.error(`Sales Executive proposal drafting blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Proposal drafting blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition and/or Universal Role Contract from Notion. Refusing to draft the Proposal without it; Handoff left Pending for automatic retry.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't prepare the Draft Proposal for *${state.entityName}* — couldn't retrieve canonical governance from Notion. Will retry automatically on the next discovery cycle.`,
    );
    return state;
  }

  // Both checks above must pass BEFORE marking Picked-up, so a transient
  // failure leaves the Handoff Pending for automatic retry rather than
  // stuck — mirrors Finance's own handlePickup ordering.
  state.quote = quote;
  await updateHandoff(env, state.handoffId!, { Status: select("Picked-up") });

  const draft = await aiText(
    env,
    "sales.proposal_drafting",
    buildProposalDraftingSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    `Entity: ${state.entityName}\nMatter: ${state.matterName}\nProposed intervention: ${state.proposedIntervention}\nVerified context: ${state.enquiryText}\n${state.callNotes}\nAuthoritative quote: ${state.quote.currency ?? ""} ${state.quote.price} — rationale: ${state.quote.rationale}`,
    { maxTokens: 3000 },
  );

  state.proposalDraft = draft;
  state.proposalRevisionCount = 0;

  await updateHandoff(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText("Draft Proposal prepared and presented to Martin for review."),
  });

  const proposalMessage = `*Draft Proposal — ${state.entityName}*\n\n${draft}`;
  const proposalButtons = [
    [
      { text: "✅ Approve & create Proposal", callback_data: `proposal:${state.workId}:approve` },
      { text: "✏️ Request changes", callback_data: `proposal:${state.workId}:revise` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: "Sales Executive" }, proposalMessage, proposalButtons);
  state.pendingActionSummary = {
    label: `Draft Proposal: ${state.entityName}`,
    message: proposalMessage,
    buttons: proposalButtons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_proposal_approval";
  state.awaiting = undefined;
  return state;
}

export async function handleProposalApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (state.stage !== "awaiting_proposal_approval") {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "This Proposal approval has already been resolved -- nothing to do.",
    );
    return state;
  }
  state.pendingActionSummary = undefined;

  if (!approved) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      "What should change in the draft? Send your feedback as a message.",
    );
    state.stage = "awaiting_proposal_revision";
    state.awaiting = "proposal_feedback";
    return state;
  }

  const page = await createPage(env, env.PROPOSALS_DATA_SOURCE_ID, {
    Proposal: title(`Proposal — ${state.matterName}`),
    Entity: relation([state.entityId!]),
    Matter: relation([state.matterId!]),
    Handoff: relation([state.handoffId!]),
    Status: select("Draft"),
    // No dedicated currency property exists on the Proposals database (not
    // introduced here -- adding one is a schema change outside this fix's
    // scope), so the currency is stated in the rationale text instead of
    // being silently lost off the bare "Quoted Price" number.
    "Quoted Price": { number: state.quote?.price ?? 0 },
    "Quote Rationale": richText(`${state.quote?.currency ? `Currency: ${state.quote.currency}. ` : ""}${state.quote?.rationale ?? ""}`),
  });

  await updatePage(env, state.matterId!, { Status: select("Proposal") });
  await logActivity(env, {
    entry: `Proposal authorized and created (Draft): ${state.matterName}`,
    type: "Decision",
    area: "Sales",
    decisions: "Martin authorized the complete Draft Proposal.",
    outcome: "Complete",
  });

  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: "Sales Executive" },
    `Proposal created in Draft status: ${page.url}`,
  );
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

export async function handleProposalFeedback(env: Env, state: WorkState, feedback: string): Promise<WorkState> {
  const governance = await getSalesExecutiveGovernance(env);
  if (!governance) {
    console.error(`Sales Executive proposal revision blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Proposal revision blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition and/or Universal Role Contract from Notion. Refusing to revise the Proposal without it.",
      outcome: "Blocked",
    });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: "Sales Executive" },
      `Couldn't revise the Draft Proposal for *${state.entityName}* — couldn't retrieve canonical governance from Notion. Send your feedback again once resolved and I'll re-apply it.`,
    );
    state.awaiting = "proposal_feedback";
    return state;
  }

  const revised = await aiText(
    env,
    "sales.proposal_revision",
    buildProposalRevisionSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    `Current draft:\n${state.proposalDraft}\n\nMartin's feedback:\n${feedback}`,
    { maxTokens: 3000 },
  );
  state.proposalDraft = revised;
  state.proposalRevisionCount = (state.proposalRevisionCount ?? 0) + 1;
  const revisedProposalMessage = `*Revised Draft Proposal*\n\n${revised}`;
  const revisedProposalButtons = [
    [
      { text: "✅ Approve & create Proposal", callback_data: `proposal:${state.workId}:approve` },
      { text: "✏️ Request changes", callback_data: `proposal:${state.workId}:revise` },
    ],
  ];
  await sendWorkspaceHatMessage(env, { ...state, hat: "Sales Executive" }, revisedProposalMessage, revisedProposalButtons);
  state.pendingActionSummary = {
    label: `Draft Proposal: ${state.entityName}`,
    message: revisedProposalMessage,
    buttons: revisedProposalButtons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_proposal_approval";
  state.awaiting = undefined;
  return state;
}

interface EntityMatchResult {
  // Set only when exactly one record matched on a determinate identity
  // signal (email or phone) — per the Entity identification rule's
  // one_determinate_match outcome, this is used directly with no
  // confirmation click. Multiple determinate-signal matches, or any
  // name-only match, are never determinate — they always go to `plausible`
  // for Martin to confirm or reject, per the "never auto-select" rule.
  determinate?: { id: string; name: string };
  plausible: { id: string; name: string }[];
}

async function findEntityMatch(env: Env, name: string, email: string, phone: string): Promise<EntityMatchResult> {
  const determinateMatches: { id: string; name: string }[] = [];
  if (email) {
    const byEmail = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Email",
      email: { equals: email },
    });
    for (const p of byEmail) determinateMatches.push({ id: p.id, name: plainText(p.properties.Name) });
  }
  if (phone) {
    const byPhone = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Phone",
      phone_number: { equals: phone },
    });
    for (const p of byPhone) {
      if (!determinateMatches.some((m) => m.id === p.id)) {
        determinateMatches.push({ id: p.id, name: plainText(p.properties.Name) });
      }
    }
  }

  if (determinateMatches.length === 1) return { determinate: determinateMatches[0], plausible: [] };
  if (determinateMatches.length > 1) return { plausible: determinateMatches.slice(0, 5) };

  // No determinate signal matched — fall back to a fuzzy name search. This
  // is never determinate (a substring match isn't reliable identity
  // evidence), so even a single result here still goes to Martin to
  // confirm rather than being auto-selected.
  if (name) {
    const byName = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Name",
      title: { contains: name },
    });
    return { plausible: byName.map((p) => ({ id: p.id, name: plainText(p.properties.Name) })).slice(0, 5) };
  }
  return { plausible: [] };
}

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
