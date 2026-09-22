import type { Env, WorkState } from "../../types";
import type { StrategyProposal } from "../strategy/strategyAnalyst";
import {
  appendTextBlocks,
  createPage,
  getPage,
  number,
  plainText,
  queryDataSource,
  relation,
  richText,
  richTextLong,
  select,
  title,
  uniqueId,
  updatePage,
  type NotionPage,
} from "../../notion";
import { updateHandoff, findIdentityViolation, type HandoffIdentity } from "../../handoffWriter";
import { logActivity } from "../../log";
import { getWorkspaceTarget, sendOperationsMessage, sendWorkspaceHatMessage, type InlineButton } from "../../telegram";
import { evaluateHandoffContext } from "../../dataBoundary/policy";

/**
 * Runtime Sales Proposal production for a Finance -> Sales Handoff.
 *
 * HO (Finance -> Sales, Pending) -> this module -> exactly one canonical,
 * token-safe Proposal record (Approval Status: Pending Approval) -> Martin
 * reviews the complete Proposal in the Workspace (Conversation) stream ->
 * Martin authorizes the exact Proposal ID + Version -> Approved, Artifact
 * Status: Pending Identity Resolution. The Identity & Artifact environment
 * consumes the approved record from there; nothing in this module creates a
 * Handoff (no Sales -> Sales Work Handoff), resolves Entity_Token /
 * Matter_Token to a real identity, reads the Entity/Matters databases, or
 * touches Drive/Gmail.
 *
 * The Proposal is composed deterministically from upstream records only:
 * the authoritative Finance quote and rationale read from the Handoff's own
 * Notion record, and the Martin-approved Strategic Intervention Proposal
 * already held by this work item (the same WorkSession carries Strategy ->
 * Finance -> Sales via handoff_workitem). No AI call is made -- nothing is
 * paraphrased, inferred or invented, and a required fact that is missing
 * fails closed with the exact gap named.
 */

const HAT = "Sales Executive";
const FINANCE_FROM_UNIT = "Finance";
const FINANCE_FROM_HAT = "Value-Based Pricing Assessor";

export const APPROVAL_STATUSES = ["Draft", "Pending Approval", "Approved"] as const;
export type ProposalApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const ARTIFACT_STATUSES = ["Not Requested", "Pending Identity Resolution", "Created", "Delivered", "Held"] as const;
export type ProposalArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** Telegram callback action for a Runtime Sales Proposal decision. Value is "<proposalNumber>.<version>.<a|r>". */
export const PROPOSAL_CALLBACK_ACTION = "salesprop";

// Opaque token shape (e.g. "E-20", "MAT-20"). Anything else in a token field
// is refused rather than written onto the Proposal as if it were a token.
const TOKEN_PATTERN = /^[A-Z]{1,6}-\d+$/;

export interface ProposalQuote {
  price: number;
  currency: string;
  rationale: string;
}

export interface InvestmentToleranceNote {
  low: number;
  high: number;
  currency: string;
  source: string;
}

/** Everything the Proposal is composed from -- all token-safe, all read from upstream records. */
export interface ProposalFacts {
  handoffId: string;
  handoffRef: string;
  entityToken: string;
  matterToken: string;
  quote: ProposalQuote;
  strategyProposalId: string;
  strategyProposalVersion: number;
  strategy: StrategyProposal;
  investmentTolerance?: InvestmentToleranceNote;
}

export interface ProposalVersionRecord {
  version: number;
  content: string;
  contentHash: string;
  createdAt: string;
  origin: "generated" | "revision";
}

export interface RuntimeSalesProposal {
  pageId: string;
  pageUrl: string;
  /** Display form of the Notion "Proposal ID" unique ID, e.g. "PROP-3" (or "3" when the property has no prefix). */
  proposalId: string;
  proposalNumber: number;
  handoffId: string;
  handoffRef: string;
  entityToken: string;
  matterToken: string;
  currentVersion: number;
  approvalStatus: ProposalApprovalStatus;
  approvedVersion?: number;
  artifactStatus: ProposalArtifactStatus;
  versions: ProposalVersionRecord[];
  /** Martin's directed changes, verbatim, each tagged with the version that introduced it. */
  amendments: { version: number; text: string }[];
  facts?: ProposalFacts;
}

export function versionLabel(version: number): string {
  return `v${version}`;
}

function parseVersionLabel(label: string): number | null {
  const m = label.trim().match(/^v(\d+)$/);
  return m ? Number(m[1]) : null;
}

export async function hashContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function formatMoney(currency: string, amount: number): string {
  const [whole, fraction] = String(amount).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${fraction ? `${grouped}.${fraction}` : grouped}`;
}

/**
 * Strict read of the authoritative Finance quote from a Finance -> Sales
 * Handoff's Verified Facts & Sources. Exactly one "Authoritative quote:"
 * line, an explicit currency, a positive amount and a non-empty rationale
 * are all required -- anything else is missing or ambiguous and returns a
 * reason instead of a quote.
 */
export function parseFinanceQuote(text: string): { quote: ProposalQuote } | { missing: string } {
  const matches = [...text.matchAll(/Authoritative quote:\s*(?:([A-Za-z]{2,5})\s+)?(\$)?\s*([\d,]+(?:\.\d+)?)/g)];
  if (matches.length === 0) return { missing: "the authoritative Finance quote (no 'Authoritative quote:' line on the Handoff)" };
  if (matches.length > 1) return { missing: "an unambiguous Finance quote (the Handoff carries more than one 'Authoritative quote:' line)" };
  const m = matches[0];
  const price = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return { missing: "a valid Finance quote amount" };
  const currency = m[1]?.toUpperCase() ?? (m[2] ? "USD" : undefined);
  if (!currency) return { missing: "the Finance quote currency" };
  const rationaleMatch = text.match(/Rationale:\s*([\s\S]*)/);
  const rationale = rationaleMatch ? rationaleMatch[1].trim() : "";
  if (!rationale) return { missing: "the Finance pricing rationale" };
  return { quote: { price, currency, rationale } };
}

/**
 * Extracts only a client-disclosed planning range (low/high/currency) from a
 * Sales -> Strategy Handoff's text -- the labeled "Investment boundary" line
 * written by the Sales Executive project, or this runtime's own "Investment
 * tolerance (CONTEXT ONLY ...)" block. Nothing else from that text is used.
 */
export function extractInvestmentTolerance(text: string): { low: number; high: number; currency: string } | null {
  const patterns = [
    /Investment boundary[^:\n]*:\s*([A-Z]{3})\s*([\d,]+)\s*[-–]\s*([\d,]+)/,
    /Investment tolerance \(CONTEXT ONLY[^\n]*\n\s*([A-Z]{3})\s*([\d,]+)\s*[-–]\s*([\d,]+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;
    const low = Number(m[2].replace(/,/g, ""));
    const high = Number(m[3].replace(/,/g, ""));
    if (Number.isFinite(low) && Number.isFinite(high)) return { low, high, currency: m[1] };
  }
  return null;
}

function clean(items: (string | undefined)[] | undefined): string[] {
  return (items ?? []).map((i) => (i ?? "").trim()).filter(Boolean);
}

/** A labelled bullet list, or null when there is nothing to list -- empty lists are omitted, never padded with placeholder text. */
function labeledList(label: string, items: (string | undefined)[] | undefined): string | null {
  const c = clean(items);
  return c.length ? `${label}:\n${c.map((i) => `- ${i}`).join("\n")}` : null;
}

function field(label: string, value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? `${label}: ${v}` : null;
}

function joinLines(lines: (string | null | undefined)[]): string {
  return lines.filter((l): l is string => !!l && l.length > 0).join("\n");
}

/**
 * Names every fact a faithful Proposal needs that the approved Strategy
 * proposal does not supply. Empty means the Proposal can be composed.
 */
export function findMissingStrategyFacts(strategy: StrategyProposal | undefined): string[] {
  if (!strategy) return ["the Martin-approved Strategic Intervention Proposal"];
  const missing: string[] = [];
  const s: any = strategy;
  if (!s.executiveSummary?.businessSituation?.trim()) missing.push("business situation (executiveSummary.businessSituation)");
  if (!s.executiveSummary?.strategicProblem?.trim()) missing.push("strategic problem (executiveSummary.strategicProblem)");
  if (!s.diagnosis?.problem?.trim() && !s.diagnosis?.diagnosticConclusion?.trim()) missing.push("diagnosis (diagnosis.problem / diagnosis.diagnosticConclusion)");
  if (!s.strategicObjective?.objective?.trim()) missing.push("strategic objective (strategicObjective.objective)");
  if (!s.proposedIntervention?.interventionName?.trim()) missing.push("approved intervention name (proposedIntervention.interventionName)");
  if (!s.proposedIntervention?.interventionSummary?.trim()) missing.push("approved intervention summary (proposedIntervention.interventionSummary)");
  const workstreams = s.proposedIntervention?.workstreams ?? [];
  const deliverables = s.deliverables ?? [];
  if (workstreams.length === 0 && deliverables.length === 0) missing.push("scope -- at least one workstream or deliverable");
  return missing;
}

/**
 * Composes the canonical, token-safe Proposal Content, following the Sales
 * Executive Hat Definition's proposal_content_standard section order, from
 * upstream facts only. Deterministic: the same facts, identity and
 * amendments always yield the same text.
 *
 * This is exactly what is stored in "Proposal Content", hashed, approved
 * and consumed by the Identity & Artifact environment -- so it carries
 * commercial proposal substance only. Internal review material (the
 * client's planning range, open items, source references, governance
 * wording) is produced separately by buildReviewNotes and is never part of
 * this text. A section with nothing established upstream is omitted rather
 * than filled with placeholder wording; buildReviewNotes lists it instead.
 */
export function buildProposalContent(
  facts: ProposalFacts,
  identity: { proposalId: string; version: number; amendments: { version: number; text: string }[] },
): string {
  const s: any = facts.strategy;
  const es = s.executiveSummary ?? {};
  const challenge = s.strategicChallenge ?? {};
  const opportunity = s.strategicOpportunity ?? {};
  const diagnosis = s.diagnosis ?? {};
  const objective = s.strategicObjective ?? {};
  const direction = s.recommendedDirection ?? {};
  const intervention = s.proposedIntervention ?? {};
  const workstreams: any[] = intervention.workstreams ?? [];
  const deliverables: any[] = s.deliverables ?? [];
  const timeline = s.timeline ?? {};
  const phases: any[] = timeline.phases ?? [];
  const inputs = s.entityInputs ?? {};
  const scope = s.commercialScope ?? {};
  const effect = s.expectedBusinessEffect ?? {};
  const success: any[] = s.successCriteria ?? [];
  const assumptions: any[] = s.assumptions ?? [];
  const dependencies: any[] = s.dependencies ?? [];
  const risks: any[] = s.risksAndConstraints?.risks ?? [];
  const constraints: any[] = s.risksAndConstraints?.constraints ?? [];

  const body: [string, string][] = [];
  const add = (heading: string, lines: (string | null | undefined)[]) => {
    const text = joinLines(lines);
    if (text) body.push([heading, text]);
  };

  add("PROPOSAL IDENTIFICATION", [
    `Proposal ID: ${identity.proposalId}`,
    `Version: ${versionLabel(identity.version)}`,
    `Entity_Token: ${facts.entityToken}`,
    `Matter_Token: ${facts.matterToken}`,
  ]);
  add("EXECUTIVE SUMMARY / CONTEXT", [
    field("Business situation", es.businessSituation),
    field("Strategic problem", es.strategicProblem),
    field("Recommended direction", es.recommendedDirection),
    field("Proposed intervention", es.proposedIntervention),
    field("Expected business effect", es.expectedBusinessEffect),
  ]);
  add("STRATEGIC PROBLEM / OPPORTUNITY", [
    field("Business objective", challenge.businessObjective),
    field("Observed situation", challenge.observedSituation),
    field("Strategic question", challenge.strategicQuestion),
    field("Why it matters", challenge.whyItMatters),
    field("Opportunity", opportunity.opportunity),
    field("Basis", opportunity.basis),
    field("Relevance to the business objective", opportunity.relevanceToBusinessObjective),
  ]);
  add("DIAGNOSIS", [
    field("Symptom", diagnosis.symptom),
    field("Problem", diagnosis.problem),
    labeledList("Causes", diagnosis.causes),
    labeledList("Constraints", diagnosis.constraints),
    labeledList("Consequences", diagnosis.consequences),
    field("Diagnostic conclusion", diagnosis.diagnosticConclusion),
  ]);
  add("OBJECTIVE", [
    field("Objective", objective.objective),
    field("Intended change", objective.intendedChange),
    field("Business alignment", objective.businessAlignment),
    field("Measurement direction", objective.measurementDirection),
  ]);
  add("RECOMMENDED INTERVENTION", [
    field("Intervention", intervention.interventionName),
    field("Summary", intervention.interventionSummary),
    field("Direction", direction.direction),
    field("Rationale", direction.rationale),
    field("Strategic logic", direction.strategicLogic),
  ]);
  add("SCOPE AND DELIVERABLES", [
    labeledList("In scope", scope.included),
    labeledList("Out of scope", scope.excluded),
    labeledList(
      "Deliverables",
      deliverables.map((d) => `${d.name ?? ""}${d.description ? `: ${d.description}` : ""}${d.format ? ` [${d.format}]` : ""}`),
    ),
  ]);
  add(
    "APPROACH / METHOD",
    workstreams.map((w, i) =>
      joinLines([
        `Workstream ${i + 1}: ${w.name ?? ""}`.trim(),
        field("  Objective", w.objective),
        clean(w.activities).length ? `  Activities:\n${clean(w.activities).map((a) => `  - ${a}`).join("\n")}` : null,
        field("  Output", w.output),
        clean(w.acceptanceCriteria).length ? `  Acceptance criteria:\n${clean(w.acceptanceCriteria).map((a) => `  - ${a}`).join("\n")}` : null,
      ]),
    ),
  );
  add("EXPECTED OUTCOMES", [
    labeledList("Intended effects", effect.intendedEffects),
    labeledList("Measurable effects", effect.measurableEffects),
    labeledList("Effects requiring a baseline", effect.effectsRequiringBaseline),
    labeledList("Limitations", effect.limitations),
    labeledList(
      "Success criteria",
      success.map((c) => `${c.criterion ?? ""}${c.measurement ? ` (measured by: ${c.measurement})` : ""}${c.evidenceRequired ? ` (evidence: ${c.evidenceRequired})` : ""}`),
    ),
  ]);
  add("TIMELINE", [
    timeline.totalDuration?.trim() ? `${timeline.status ?? "Indicative"}: ${timeline.totalDuration}` : null,
    ...phases.map(
      (p) => `- ${p.name ?? ""}${p.duration ? ` (${p.duration})` : ""}${clean(p.outputs).length ? ` — outputs: ${clean(p.outputs).join("; ")}` : ""}${p.reviewPoint ? ` — review point: ${p.reviewPoint}` : ""}`,
    ),
  ]);
  // The Finance rationale is carried verbatim -- see buildReviewNotes for
  // the unresolved conflict with the proposal standard's "translate into
  // client-facing language" rule.
  add("BASIS FOR THE INVESTMENT", [facts.quote.rationale]);
  add("INVESTMENT", [`Investment: ${formatMoney(facts.quote.currency, facts.quote.price)}`]);
  add("COMMERCIAL TERMS", [`Currency: ${facts.quote.currency}`, labeledList("Client responsibilities", scope.clientResponsibilities)]);
  add("WHAT ENIG NEEDS FROM THE CLIENT", [
    labeledList("Information", inputs.requiredInformation),
    labeledList("Documents", inputs.requiredDocuments),
    labeledList("Access", inputs.requiredAccess),
    labeledList("Stakeholder participation", inputs.requiredStakeholderParticipation),
    labeledList("Decisions", inputs.requiredDecisions),
  ]);
  add("ASSUMPTIONS, DEPENDENCIES, RISKS AND EXCLUSIONS", [
    labeledList("Assumptions", assumptions.map((a) => `${a.assumption ?? ""}${a.basis ? ` (basis: ${a.basis})` : ""}${a.materiality ? ` (materiality: ${a.materiality})` : ""}`)),
    labeledList("Dependencies", dependencies.map((d) => `${d.dependency ?? ""}${d.owner ? ` (owner: ${d.owner})` : ""}${d.impactIfUnavailable ? ` (if unavailable: ${d.impactIfUnavailable})` : ""}`)),
    labeledList("Risks", risks.map((r) => `${r.risk ?? ""}${r.mitigationOrResponse ? ` (response: ${r.mitigationOrResponse})` : ""}`)),
    labeledList("Constraints", constraints.map((c) => `${c.constraint ?? ""}${c.implication ? ` (implication: ${c.implication})` : ""}`)),
    labeledList("Exclusions", scope.excluded),
  ]);
  add("AMENDMENTS", identity.amendments.map((a) => `- ${a.text}`));
  add("NEXT STEPS", ["- Confirm acceptance of the scope and investment set out in this proposal."]);

  const title = `PROPOSAL — ${intervention.interventionName}`;
  return [title, ...body.map(([heading, text], i) => `${i + 1}. ${heading}\n${text}`)].join("\n\n");
}

/**
 * Internal review material for Martin -- shown with the Proposal in the
 * approval request, never written into Proposal Content, never hashed as
 * part of the approved Version, and never handed to the Identity & Artifact
 * environment. Nothing here is discarded: it is the review-path home for
 * everything buildProposalContent deliberately leaves out.
 */
export function buildReviewNotes(
  facts: ProposalFacts,
  identity: { proposalId: string; version: number; amendments: { version: number; text: string }[] },
): string {
  const s: any = facts.strategy;
  const quote = formatMoney(facts.quote.currency, facts.quote.price);
  const tolerance = facts.investmentTolerance;
  const notEstablished: string[] = [];
  if (!s.timeline?.totalDuration?.trim() && !(s.timeline?.phases ?? []).length) notEstablished.push("timeline / delivery schedule");
  if (!clean(s.commercialScope?.excluded).length) notEstablished.push("out-of-scope exclusions");
  if (!clean(s.commercialScope?.clientResponsibilities).length) notEstablished.push("client responsibilities");
  const inputs = s.entityInputs ?? {};
  if (![inputs.requiredInformation, inputs.requiredDocuments, inputs.requiredAccess, inputs.requiredStakeholderParticipation, inputs.requiredDecisions].some((l) => clean(l).length)) {
    notEstablished.push("what ENIG needs from the client");
  }
  return joinLines([
    `Source: Handoff ${facts.handoffRef} (Finance → Sales); approved Strategy proposal ${facts.strategyProposalId} v${facts.strategyProposalVersion}.`,
    `Investment is the authoritative Finance quote, unchanged: ${quote}.`,
    tolerance
      ? `Client-disclosed planning range (${tolerance.source}): ${formatMoney(tolerance.currency, tolerance.low)}–${formatMoney(tolerance.currency, tolerance.high).replace(`${tolerance.currency} `, "")}. Commercial context only: both figures are verified facts, and the range does not replace or alter the Finance quote and is not the pricing basis.`
      : "No client-disclosed planning range is on record for this work.",
    "Open items (not stated upstream, not in the Proposal): payment terms; quote validity period; issue date.",
    notEstablished.length ? `Not established upstream, so omitted from the Proposal: ${notEstablished.join("; ")}.` : null,
    "Basis for the Investment carries the Finance rationale verbatim. The proposal standard asks for client-facing translation of internal Finance reasoning; that conflict is unresolved and has not been decided here.",
    ...identity.amendments.map((a) => `Amendment introduced in ${versionLabel(a.version)} at Martin's direction.`),
    `Approving ${identity.proposalId} ${versionLabel(identity.version)} approves the Proposal above only; this review material is not part of it.`,
  ]);
}

/** The identity strings this work item happens to know (only ever set by a Sales flow that legitimately resolved identity) -- used as a deny-list, never to resolve anything. */
function knownIdentity(state: WorkState, entityToken: string, matterToken: string): HandoffIdentity {
  return {
    entityToken,
    matterToken,
    entityName: state.entityName,
    matterName: state.matterName,
    contactName: state.entityDraft?.name,
    email: state.entityDraft?.email,
    phone: state.entityDraft?.phone,
  };
}

/** True when the text carries no identity-bearing value this runtime can detect. The violation detail is never echoed -- it may contain the identity itself. */
export function isTokenSafe(text: string, identity: HandoffIdentity): boolean {
  return findIdentityViolation("Proposal Content", text, identity) === null;
}

interface FailOptions {
  holdHandoffId?: string;
  tokens?: { entityToken: string; matterToken: string };
}

async function failClosed(env: Env, state: WorkState, reason: string, opts: FailOptions = {}): Promise<WorkState> {
  const ref = state.matterToken || state.entityToken || state.workId;
  console.error(`Runtime Sales Proposal blocked for work ${state.workId}: ${reason}`);
  await logActivity(env, {
    entry: `Runtime Sales Proposal blocked — ${ref}`,
    type: "Blocker",
    area: "Sales",
    decisionRationale: reason,
    outcome: "Blocked",
  });
  if (opts.holdHandoffId) {
    await updateHandoff(
      env,
      opts.holdHandoffId,
      { Status: select("Held"), "Open Questions": richText(`Runtime Sales Proposal blocked: ${reason}`) },
      opts.tokens ? { entityToken: opts.tokens.entityToken, matterToken: opts.tokens.matterToken } : undefined,
    ).catch((err) => console.error(`Runtime Sales Proposal: failed to hold Handoff ${opts.holdHandoffId}`, err));
  }
  const message = `Runtime Sales Proposal blocked for *${ref}*: ${reason}\n\nNothing was approved or released.`;
  if (getWorkspaceTarget(env)) {
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, message);
  } else {
    await sendOperationsMessage(env, message);
  }
  state.blockedReason = reason;
  return state;
}

/**
 * Finds the one canonical Proposal for this Handoff, if it already exists.
 * Returns an error string when the association is ambiguous -- more than one
 * record linked to the Handoff, or a Proposal for the same Matter_Token that
 * is not linked to this Handoff.
 */
async function findExistingProposal(
  env: Env,
  state: WorkState,
  handoffId: string,
  matterToken: string,
): Promise<{ page?: NotionPage } | { error: string }> {
  if (state.salesProposal?.handoffId === handoffId) {
    return { page: await getPage(env, state.salesProposal.pageId) };
  }
  const linked = await queryDataSource(env, env.PROPOSALS_DATA_SOURCE_ID, { property: "Handoff", relation: { contains: handoffId } });
  if (linked.length > 1) return { error: `${linked.length} Proposal records are linked to this Handoff; cannot determine the canonical one.` };
  if (linked.length === 1) return { page: linked[0] };
  const sameMatter = await queryDataSource(env, env.PROPOSALS_DATA_SOURCE_ID, { property: "Matter Token", rich_text: { equals: matterToken } });
  if (sameMatter.length > 0) {
    return { error: `a Proposal for ${matterToken} already exists but is not linked to this Handoff; cannot deterministically associate it.` };
  }
  return {};
}

/** Rebuilds the in-memory mirror from the canonical Notion record. Returns an error string if its state can't be read unambiguously. */
async function proposalFromRecord(page: NotionPage, base: Partial<RuntimeSalesProposal>): Promise<RuntimeSalesProposal | { error: string }> {
  const props = page.properties;
  const proposalId = uniqueId(props["Proposal ID"]);
  const proposalNumber = props["Proposal ID"]?.unique_id?.number;
  if (!proposalId || typeof proposalNumber !== "number") return { error: "the Proposal record has no Proposal ID." };
  const approval = plainText(props["Approval Status"]);
  if (!(APPROVAL_STATUSES as readonly string[]).includes(approval)) {
    return { error: `the Proposal record's Approval Status ("${approval || "empty"}") is not a recognised state; cannot distinguish Pending Approval from Approved.` };
  }
  const artifact = plainText(props["Artifact Status"]);
  if (!(ARTIFACT_STATUSES as readonly string[]).includes(artifact)) {
    return { error: `the Proposal record's Artifact Status ("${artifact || "empty"}") is not a recognised state.` };
  }
  const version = parseVersionLabel(plainText(props.Version));
  if (version === null) return { error: "the Proposal record has no readable Version." };
  const approvedLabel = plainText(props["Approved Version"]).trim();
  const approvedVersion = approvedLabel ? parseVersionLabel(approvedLabel) : undefined;
  if (approvedVersion === null) return { error: `the Proposal record's Approved Version ("${approvedLabel}") is not readable.` };
  if (approval === "Approved" && approvedVersion !== version) {
    return { error: "the Proposal record is Approved but its Approved Version does not match its current Version." };
  }
  const content = plainText(props["Proposal Content"]);
  const existingVersions = base.versions ?? [];
  const known = existingVersions.find((v) => v.version === version);
  const versions = known
    ? existingVersions
    : [...existingVersions, { version, content, contentHash: await hashContent(content), createdAt: new Date().toISOString(), origin: "generated" as const }];
  return {
    pageId: page.id,
    pageUrl: page.url,
    proposalId,
    proposalNumber,
    handoffId: base.handoffId ?? "",
    handoffRef: base.handoffRef ?? "",
    entityToken: plainText(props["Entity Token"]),
    matterToken: plainText(props["Matter Token"]),
    currentVersion: version,
    approvalStatus: approval as ProposalApprovalStatus,
    approvedVersion: approvedVersion ?? undefined,
    artifactStatus: artifact as ProposalArtifactStatus,
    versions,
    amendments: base.amendments ?? [],
    facts: base.facts,
  };
}

function decisionButtons(sp: RuntimeSalesProposal, version: number, includeApprove: boolean): InlineButton[][] {
  const v = versionLabel(version);
  const row: InlineButton[] = [];
  if (includeApprove) row.push({ text: `✅ Approve ${sp.proposalId} ${v}`, callback_data: `${PROPOSAL_CALLBACK_ACTION}:__WORK__:${sp.proposalNumber}.${version}.a` });
  row.push({ text: `✏️ Request changes to ${v}`, callback_data: `${PROPOSAL_CALLBACK_ACTION}:__WORK__:${sp.proposalNumber}.${version}.r` });
  return [row];
}

function withWorkId(buttons: InlineButton[][], workId: string): InlineButton[][] {
  return buttons.map((row) => row.map((b) => ({ ...b, callback_data: b.callback_data.replace("__WORK__", workId) })));
}

/** Presents the COMPLETE Proposal for the exact Proposal ID + Version, with approval bound to that pair. */
async function presentForApproval(env: Env, state: WorkState, sp: RuntimeSalesProposal): Promise<WorkState> {
  const record = sp.versions.find((v) => v.version === sp.currentVersion);
  if (!record) return failClosed(env, state, `content for ${sp.proposalId} ${versionLabel(sp.currentVersion)} is not available to present.`);
  const header = [
    "*Proposal approval request*",
    `Proposal: ${sp.proposalId} · Version: ${versionLabel(sp.currentVersion)}`,
    `Entity: ${sp.entityToken} · Matter: ${sp.matterToken} · Source Handoff: ${sp.handoffRef}`,
    `Approval Status: ${sp.approvalStatus} · Artifact Status: ${sp.artifactStatus}`,
    `Record: ${sp.pageUrl}`,
  ].join("\n");
  const notes = sp.facts
    ? buildReviewNotes(sp.facts, { proposalId: sp.proposalId, version: sp.currentVersion, amendments: sp.amendments })
    : "Unavailable: the upstream facts this Proposal was built from are not on this work item.";
  const message = [
    header,
    `=== PROPOSAL ${sp.proposalId} ${versionLabel(sp.currentVersion)} (the content being approved) ===`,
    record.content,
    "=== INTERNAL REVIEW MATERIAL — not part of the Proposal, not stored in Proposal Content, not approved with it ===",
    notes,
    `Approve exactly *${sp.proposalId} ${versionLabel(sp.currentVersion)}*? Approval applies to the Proposal content of this Version only.`,
  ].join("\n\n");
  const buttons = withWorkId(decisionButtons(sp, sp.currentVersion, true), state.workId);
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, message, buttons);
  state.pendingActionSummary = {
    label: `Proposal ${sp.proposalId} ${versionLabel(sp.currentVersion)} (${sp.matterToken})`,
    message,
    buttons,
    createdAt: new Date().toISOString(),
  };
  state.stage = "awaiting_sales_proposal_approval";
  state.awaiting = undefined;
  return state;
}

/**
 * The Strategy Proposal is only consumed when its token safety is
 * established by an authoritative source, bound to that exact proposal ID
 * and version. The runtime cannot establish this itself: Strategy's
 * drafting call receives the full originating Handoff context, which is not
 * guaranteed to be identity-free, and the Strategy -> Finance Handoff holds
 * only a truncated serialization. Inspecting the text here would need the
 * real identity the runtime must never know, so there is no heuristic
 * fallback: without a matching attestation this fails closed.
 *
 * No production code sets state.strategyProposalTokenSafety today -- a
 * token-safe Strategy source (or an authoritative token-safe serialization
 * at the Strategy -> Finance boundary) is a separate, required upstream
 * change. Until it exists, Runtime Proposal production is blocked here.
 */
export function verifyStrategyProposalTokenSafety(state: WorkState): string | null {
  const proposal = state.strategyProposal;
  if (!proposal) return null; // absence is reported by resolveFacts as a missing fact
  const attestation = state.strategyProposalTokenSafety;
  if (!attestation) {
    return `the approved Strategy Proposal (${proposal.proposalId} v${proposal.proposalVersion}) has no authoritative token-safety verification. It was drafted from Handoff context that is not certified token-safe, and no complete token-safe serialization of it exists at the Strategy → Finance boundary, so it cannot be used as a Proposal source.`;
  }
  if (attestation.proposalId !== proposal.proposalId || attestation.proposalVersion !== proposal.proposalVersion) {
    return `the token-safety verification on record is for Strategy proposal ${attestation.proposalId} v${attestation.proposalVersion}, not the approved ${proposal.proposalId} v${proposal.proposalVersion}.`;
  }
  return null;
}

/**
 * Resolves the upstream facts for this Handoff: the authoritative quote from
 * the Handoff's own record, and the Martin-approved Strategy proposal this
 * work item already holds. Returns the exact list of what's missing instead
 * of guessing.
 */
async function resolveFacts(
  env: Env,
  state: WorkState,
  handoff: NotionPage,
  tokens: { entityToken: string; matterToken: string },
  quote: ProposalQuote,
): Promise<{ facts: ProposalFacts } | { missing: string[] }> {
  const missing: string[] = [];
  if (state.strategyApprovalState !== "APPROVED" || !state.strategyProposal) {
    missing.push("the Martin-approved Strategic Intervention Proposal on this work item (Strategy approval state is not APPROVED here)");
  } else {
    if (state.entityToken && state.entityToken !== tokens.entityToken) missing.push(`a consistent Entity_Token (work item ${state.entityToken} vs Handoff ${tokens.entityToken})`);
    if (state.matterToken && state.matterToken !== tokens.matterToken) missing.push(`a consistent Matter_Token (work item ${state.matterToken} vs Handoff ${tokens.matterToken})`);
    missing.push(...findMissingStrategyFacts(state.strategyProposal));
  }
  if (missing.length) return { missing };

  let investmentTolerance: InvestmentToleranceNote | undefined;
  const t = state.investmentToleranceContext;
  if (t && typeof t.low === "number" && typeof t.high === "number" && t.currency) {
    investmentTolerance = { low: t.low, high: t.high, currency: t.currency, source: "recorded during Sales discovery" };
  } else {
    // Optional context only: read the labeled planning-range line from the
    // one Sales -> Strategy Handoff for this Matter. Never required, and no
    // other text from that record is used.
    try {
      const salesToStrategy = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, {
        and: [
          { property: "Matter_Token", rich_text: { equals: tokens.matterToken } },
          { property: "From Unit", select: { equals: "Sales" } },
          { property: "To Unit", select: { equals: "Strategy" } },
        ],
      });
      if (salesToStrategy.length === 1) {
        const range = extractInvestmentTolerance(plainText(salesToStrategy[0].properties["Verified Facts & Sources"]));
        const ref = uniqueId(salesToStrategy[0].properties["Handoff ID"]) || salesToStrategy[0].id;
        if (range) investmentTolerance = { ...range, source: `client-disclosed, recorded on ${ref}` };
      }
    } catch (err) {
      console.error(`Runtime Sales Proposal: planning-range lookup failed for ${tokens.matterToken} (context omitted)`, err);
    }
  }

  return {
    facts: {
      handoffId: handoff.id,
      handoffRef: uniqueId(handoff.properties["Handoff ID"]) || handoff.id,
      entityToken: tokens.entityToken,
      matterToken: tokens.matterToken,
      quote,
      strategyProposalId: state.strategyProposal!.proposalId,
      strategyProposalVersion: state.strategyProposal!.proposalVersion,
      strategy: state.strategyProposal!,
      investmentTolerance,
    },
  };
}

/**
 * Runtime Sales Executive pickup of a Finance -> Sales Handoff: produces (or,
 * on reprocessing, re-presents) exactly one canonical token-safe Proposal
 * and asks Martin to authorize its exact Version. Idempotent -- reprocessing
 * the same Handoff never creates a second record or a new Version.
 */
export async function handleProposalHandoffPickup(env: Env, state: WorkState): Promise<WorkState> {
  if (!getWorkspaceTarget(env)) {
    return failClosed(env, state, "the Telegram Conversation (Workspace) stream is not configured (TELEGRAM_GROUP_CHAT_ID / WORKSPACE_TOPIC_ID); the Proposal cannot be presented for approval, so none was produced.");
  }
  const handoffId = state.handoffId;
  if (!handoffId) return failClosed(env, state, "this work item has no Handoff to resolve.");

  let handoff: NotionPage;
  try {
    handoff = await getPage(env, handoffId);
  } catch (err) {
    console.error(`Runtime Sales Proposal: Handoff ${handoffId} could not be read`, err);
    return failClosed(env, state, `Handoff ${handoffId} could not be resolved.`);
  }
  const hp = handoff.properties;
  const fromUnit = plainText(hp["From Unit"]);
  const fromHat = plainText(hp["From Hat"]);
  const toUnit = plainText(hp["To Unit"]);
  const type = plainText(hp.Type);
  const status = plainText(hp.Status);
  if (fromUnit !== FINANCE_FROM_UNIT || fromHat !== FINANCE_FROM_HAT || toUnit !== "Sales" || type !== "Work") {
    return failClosed(env, state, `Handoff ${handoffId} is not a Finance (${FINANCE_FROM_HAT}) → Sales Work Handoff; Runtime Proposal production only runs from one.`);
  }

  const entityToken = plainText(hp.Entity_Token).trim();
  const matterToken = plainText(hp.Matter_Token).trim();
  if (!TOKEN_PATTERN.test(entityToken) || !TOKEN_PATTERN.test(matterToken)) {
    return failClosed(env, state, "the Handoff's Entity_Token and/or Matter_Token is missing or not an opaque token.", { holdHandoffId: handoffId });
  }
  const tokens = { entityToken, matterToken };
  const identity = knownIdentity(state, entityToken, matterToken);

  const verifiedFacts = plainText(hp["Verified Facts & Sources"]);
  const contract = evaluateHandoffContext(
    { handoffId, entityToken, matterToken, sanitizedContext: verifiedFacts, provenance: `notion:handoff:${handoffId}`, requiredCategory: "authoritative quote and proposal scope" },
    "sales.proposal_drafting",
  );
  if (!contract.success) return failClosed(env, state, contract.insufficientContext.reason, { holdHandoffId: handoffId, tokens });

  const parsed = parseFinanceQuote(verifiedFacts);
  if ("missing" in parsed) return failClosed(env, state, `missing or ambiguous: ${parsed.missing}.`, { holdHandoffId: handoffId, tokens });

  const existing = await findExistingProposal(env, state, handoffId, matterToken);
  if ("error" in existing) return failClosed(env, state, `Proposal identity: ${existing.error}`, { holdHandoffId: handoffId, tokens });

  // Idempotent path: a canonical Proposal already exists for this Handoff
  // with content -- never create another record or a new Version.
  if (
    existing.page &&
    plainText(existing.page.properties["Proposal Content"]).trim() &&
    plainText(existing.page.properties["Approval Status"]) !== "Draft"
  ) {
    const sp = await proposalFromRecord(existing.page, {
      ...(state.salesProposal ?? {}),
      handoffId,
      handoffRef: uniqueId(hp["Handoff ID"]) || handoffId,
    });
    if ("error" in sp) return failClosed(env, state, sp.error, { holdHandoffId: handoffId, tokens });
    if (sp.entityToken !== entityToken || sp.matterToken !== matterToken) {
      return failClosed(env, state, "the existing Proposal's tokens do not match the Handoff's tokens.", { holdHandoffId: handoffId, tokens });
    }
    if (!sp.facts && !verifyStrategyProposalTokenSafety(state)) {
      const resolved = await resolveFacts(env, state, handoff, tokens, parsed.quote);
      if ("facts" in resolved) sp.facts = resolved.facts;
    }
    state.salesProposal = sp;
    if (status !== "Closed") {
      await updateHandoff(env, handoffId, { Status: select("Closed"), "Work Completed": richText(`Token-safe Proposal ${sp.proposalId} ${versionLabel(sp.currentVersion)} recorded (${sp.approvalStatus}).`) }, tokens);
    }
    await logActivity(env, {
      entry: `Runtime Sales Proposal reprocessed — no new record: ${sp.proposalId} ${versionLabel(sp.currentVersion)}`,
      type: "Activity",
      area: "Sales",
      activity: `Handoff ${sp.handoffRef} reprocessed; canonical Proposal ${sp.proposalId} already exists (${sp.approvalStatus}).`,
      outcome: "Active",
    });
    if (sp.approvalStatus === "Approved") {
      await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, `${sp.proposalId} ${versionLabel(sp.currentVersion)} is already Approved (Artifact Status: ${sp.artifactStatus}). Nothing new was created.`);
      state.stage = "sales_proposal_approved";
      return state;
    }
    return presentForApproval(env, state, sp);
  }

  if (status !== "Pending" && status !== "Picked-up") {
    return failClosed(env, state, `Handoff ${handoffId} is ${status || "in an unknown status"} and has no canonical Proposal; not producing one from a non-active Handoff.`);
  }

  const unverified = verifyStrategyProposalTokenSafety(state);
  if (unverified) return failClosed(env, state, `Strategy Proposal identity boundary: ${unverified}`, { holdHandoffId: handoffId, tokens });

  const resolved = await resolveFacts(env, state, handoff, tokens, parsed.quote);
  if ("missing" in resolved) {
    return failClosed(env, state, `required Proposal facts are missing: ${resolved.missing.join("; ")}.`, { holdHandoffId: handoffId, tokens });
  }
  const facts = resolved.facts;

  // Pre-check the full composed content before anything is written.
  if (!isTokenSafe(buildProposalContent(facts, { proposalId: "PENDING", version: 1, amendments: [] }), identity)) {
    return failClosed(env, state, "an identity-bearing value (a real name or contact detail) would enter the Runtime Proposal; nothing was written.", { holdHandoffId: handoffId, tokens });
  }

  await updateHandoff(env, handoffId, { Status: select("Picked-up") }, tokens);

  // Two-step create: the Proposal ID is only known once the record exists,
  // and the content names it. The record stays Draft (never presented, never
  // approvable) until its content is written; a retry finds it by Handoff.
  const page =
    existing.page ??
    (await createPage(env, env.PROPOSALS_DATA_SOURCE_ID, {
      Proposal: title(`Proposal — ${matterToken}`),
      "Entity Token": richText(entityToken),
      "Matter Token": richText(matterToken),
      Handoff: relation([handoffId]),
      Status: select("Draft"),
      "Approval Status": select("Draft"),
      "Artifact Status": select("Not Requested"),
    }));
  const created = page.properties?.["Proposal ID"]?.unique_id ? page : await getPage(env, page.id);
  const proposalId = uniqueId(created.properties["Proposal ID"]);
  const proposalNumber = created.properties["Proposal ID"]?.unique_id?.number;
  if (!proposalId || typeof proposalNumber !== "number") {
    return failClosed(env, state, "the Proposal record was created without a Proposal ID; approval could not be bound to it.", { holdHandoffId: handoffId, tokens });
  }

  const content = buildProposalContent(facts, { proposalId, version: 1, amendments: [] });
  if (!isTokenSafe(content, identity)) {
    return failClosed(env, state, "an identity-bearing value (a real name or contact detail) would enter the Runtime Proposal; content was not written.", { holdHandoffId: handoffId, tokens });
  }
  const contentHash = await hashContent(content);

  await appendTextBlocks(env, page.id, `${proposalId} ${versionLabel(1)} — snapshot`, content);
  await updatePage(env, page.id, {
    "Proposal Content": richTextLong(content),
    Version: richText(versionLabel(1)),
    "Approval Status": select("Pending Approval"),
    "Approved Version": { rich_text: [] },
    "Artifact Status": select("Not Requested"),
    "Quoted Price": number(facts.quote.price),
    "Quote Rationale": richText(`Currency: ${facts.quote.currency}. ${facts.quote.rationale}`),
  });

  const sp: RuntimeSalesProposal = {
    pageId: page.id,
    pageUrl: created.url ?? page.url,
    proposalId,
    proposalNumber,
    handoffId,
    handoffRef: facts.handoffRef,
    entityToken,
    matterToken,
    currentVersion: 1,
    approvalStatus: "Pending Approval",
    artifactStatus: "Not Requested",
    versions: [{ version: 1, content, contentHash, createdAt: new Date().toISOString(), origin: "generated" }],
    amendments: [],
    facts,
  };
  state.salesProposal = sp;
  state.pendingSalesProposalRevision = undefined;
  state.blockedReason = undefined;

  await updateHandoff(
    env,
    handoffId,
    { Status: select("Closed"), "Work Completed": richText(`Token-safe Proposal ${proposalId} ${versionLabel(1)} created (Pending Approval) and presented to Martin.`) },
    tokens,
  );
  await logActivity(env, {
    entry: `Runtime Sales Proposal created: ${proposalId} ${versionLabel(1)} — ${matterToken}`,
    type: "Activity",
    area: "Sales",
    activity: `From Handoff ${facts.handoffRef}. Quote ${formatMoney(facts.quote.currency, facts.quote.price)} preserved. Content SHA-256 ${contentHash}.`,
    nextActions: `Martin to review and authorize ${proposalId} ${versionLabel(1)}.`,
    outcome: "Active",
  });
  return presentForApproval(env, state, sp);
}

async function staleDecision(env: Env, state: WorkState, detail: string): Promise<WorkState> {
  console.error(`Runtime Sales Proposal: stale/mismatched decision for work ${state.workId}: ${detail}`);
  await logActivity(env, {
    entry: "Runtime Sales Proposal decision ignored — stale or mismatched",
    type: "Blocker",
    area: "Sales",
    decisionRationale: detail,
    outcome: "Blocked",
  });
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, `Not applied: ${detail}`);
  return state;
}

/**
 * Martin's decision on a specific Proposal ID + Version. Approval is applied
 * only when the callback's Proposal ID and Version match the current,
 * Pending Approval Version both here and on the live Notion record, and the
 * record's content is byte-identical to what Martin was shown.
 */
export async function handleSalesProposalDecision(
  env: Env,
  state: WorkState,
  proposalNumber: number,
  version: number,
  decision: "approve" | "revise",
): Promise<WorkState> {
  const sp = state.salesProposal;
  if (!sp) return staleDecision(env, state, "there is no Runtime Proposal on this work item.");
  if (sp.proposalNumber !== proposalNumber) {
    return staleDecision(env, state, `this decision is for Proposal #${proposalNumber}, not ${sp.proposalId}.`);
  }

  if (decision === "revise") {
    if (version !== sp.currentVersion) {
      return staleDecision(env, state, `${versionLabel(version)} is not the current Version of ${sp.proposalId} (current: ${versionLabel(sp.currentVersion)}).`);
    }
    state.pendingSalesProposalRevision = { proposalNumber, fromVersion: version };
    state.pendingActionSummary = undefined;
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT },
      `What should change in ${sp.proposalId} ${versionLabel(version)}? Send the change as a message. It will be recorded verbatim in a new Version (${versionLabel(version + 1)}) that needs your approval; ${versionLabel(version)} is kept unchanged.`,
    );
    state.stage = "awaiting_sales_proposal_revision";
    state.awaiting = "sales_proposal_revision";
    return state;
  }

  if (sp.approvalStatus === "Approved" && sp.approvedVersion === version && sp.currentVersion === version) {
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, `${sp.proposalId} ${versionLabel(version)} is already Approved -- nothing to do.`);
    return state;
  }
  if (sp.approvalStatus !== "Pending Approval" || version !== sp.currentVersion) {
    return staleDecision(env, state, `approval for ${sp.proposalId} ${versionLabel(version)} is stale (current: ${versionLabel(sp.currentVersion)}, ${sp.approvalStatus}).`);
  }
  const shown = sp.versions.find((v) => v.version === version);
  if (!shown) return staleDecision(env, state, `no record of the ${versionLabel(version)} content Martin was shown.`);

  const live = await getPage(env, sp.pageId);
  const liveState = await proposalFromRecord(live, sp);
  if ("error" in liveState) return failClosed(env, state, liveState.error);
  if (liveState.proposalNumber !== proposalNumber || liveState.currentVersion !== version || liveState.approvalStatus !== "Pending Approval") {
    return staleDecision(env, state, `the Proposal record is now ${liveState.proposalId} ${versionLabel(liveState.currentVersion)} (${liveState.approvalStatus}); approval of ${versionLabel(version)} not applied.`);
  }
  if (liveState.entityToken !== sp.entityToken || liveState.matterToken !== sp.matterToken) {
    return failClosed(env, state, "the Proposal record's tokens changed since it was presented; approval not applied.");
  }
  const liveHash = await hashContent(plainText(live.properties["Proposal Content"]));
  if (liveHash !== shown.contentHash) {
    return failClosed(env, state, `the Proposal record's content no longer matches the ${versionLabel(version)} Martin reviewed; approval not applied.`);
  }

  await updatePage(env, sp.pageId, {
    "Approval Status": select("Approved"),
    "Approved Version": richText(versionLabel(version)),
    "Artifact Status": select("Pending Identity Resolution"),
  });
  sp.approvalStatus = "Approved";
  sp.approvedVersion = version;
  sp.artifactStatus = "Pending Identity Resolution";
  state.pendingActionSummary = undefined;

  await logActivity(env, {
    entry: `Proposal approved: ${sp.proposalId} ${versionLabel(version)} — ${sp.matterToken}`,
    type: "Decision",
    area: "Sales",
    decisions: `Martin approved ${sp.proposalId} ${versionLabel(version)} (Entity ${sp.entityToken}, Matter ${sp.matterToken}).`,
    decisionRationale: `Approval bound to Proposal ID ${sp.proposalId} + Version ${versionLabel(version)}; content SHA-256 ${shown.contentHash}. Artifact Status set to Pending Identity Resolution.`,
    nextActions: "Identity & Artifact environment to resolve identity and produce the client-facing artifact from this approved Version.",
    outcome: "Complete",
  });
  const buttons = withWorkId(decisionButtons(sp, version, false), state.workId);
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: HAT },
    `✅ Approved: *${sp.proposalId} ${versionLabel(version)}*.\nApproved Version: ${versionLabel(version)} · Artifact Status: Pending Identity Resolution.\n\nThe approved Version is now available to the Identity & Artifact environment. The runtime has not created any client-facing artifact or file.`,
    buttons,
  );
  state.stage = "sales_proposal_approved";
  state.awaiting = undefined;
  return state;
}

/**
 * Martin's requested change to the current Version: always a new Version,
 * never an overwrite. The prior Version's content stays in state and in the
 * Proposal page body; the new Version is Pending Approval and not released to
 * artifact execution until Martin approves that exact Version.
 */
export async function handleSalesProposalRevisionText(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const sp = state.salesProposal;
  const pending = state.pendingSalesProposalRevision;
  if (!sp || !pending || pending.proposalNumber !== sp.proposalNumber || pending.fromVersion !== sp.currentVersion) {
    state.pendingSalesProposalRevision = undefined;
    state.awaiting = undefined;
    return staleDecision(env, state, "this change request no longer matches the current Proposal Version.");
  }
  const change = text.trim();
  if (!change) {
    await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, "That looked empty -- what should change? Send the change as a message.");
    return state;
  }
  if (!sp.facts) return failClosed(env, state, "the upstream facts this Proposal was built from are not available on this work item; cannot compose a new Version.");

  const identity = knownIdentity(state, sp.entityToken, sp.matterToken);
  const newVersion = sp.currentVersion + 1;
  const amendments = [...sp.amendments, { version: newVersion, text: change }];
  const content = buildProposalContent(sp.facts, { proposalId: sp.proposalId, version: newVersion, amendments });
  if (!isTokenSafe(content, identity)) {
    return failClosed(env, state, "the requested change would put an identity-bearing value (a real name or contact detail) into the Runtime Proposal; no new Version was created. Please restate it using tokens only.");
  }

  const live = await getPage(env, sp.pageId);
  const liveState = await proposalFromRecord(live, sp);
  if ("error" in liveState) return failClosed(env, state, liveState.error);
  if (liveState.currentVersion !== sp.currentVersion) {
    return staleDecision(env, state, `the Proposal record is now at ${versionLabel(liveState.currentVersion)}; change to ${versionLabel(sp.currentVersion)} not applied.`);
  }

  const released = sp.artifactStatus !== "Not Requested";
  const artifactStatus: ProposalArtifactStatus = released ? "Held" : "Not Requested";
  const contentHash = await hashContent(content);
  await appendTextBlocks(env, sp.pageId, `${sp.proposalId} ${versionLabel(newVersion)} — snapshot`, content);
  await updatePage(env, sp.pageId, {
    "Proposal Content": richTextLong(content),
    Version: richText(versionLabel(newVersion)),
    "Approval Status": select("Pending Approval"),
    "Approved Version": { rich_text: [] },
    "Artifact Status": select(artifactStatus),
  });

  const previousApproved = sp.approvedVersion;
  sp.versions.push({ version: newVersion, content, contentHash, createdAt: new Date().toISOString(), origin: "revision" });
  sp.amendments = amendments;
  sp.currentVersion = newVersion;
  sp.approvalStatus = "Pending Approval";
  sp.approvedVersion = undefined;
  sp.artifactStatus = artifactStatus;
  state.pendingSalesProposalRevision = undefined;

  await logActivity(env, {
    entry: `Proposal revised: ${sp.proposalId} ${versionLabel(newVersion)} — ${sp.matterToken}`,
    type: "Decision",
    area: "Sales",
    decisions: `Martin requested a change to ${versionLabel(newVersion - 1)}; ${versionLabel(newVersion)} created and set to Pending Approval.`,
    decisionRationale: `${previousApproved ? `Previously approved ${versionLabel(previousApproved)} kept unchanged in the record body; Approved Version cleared. ` : ""}Artifact Status: ${artifactStatus}. Content SHA-256 ${contentHash}.`,
    outcome: "Active",
  });
  return presentForApproval(env, state, sp);
}
