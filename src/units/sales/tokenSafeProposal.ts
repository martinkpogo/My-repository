import type { Env, WorkState } from "../../types";
import type { ResolvedActionSkillSet } from "../../platform/skillRegistry";
import type { StrategyProposal, StrategyBoundaryRepresentation } from "../../handoffContracts/strategyBoundary";
import { STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END } from "../../handoffContracts/strategyBoundary";
import { extractLabeledBlock } from "../../labeledBlock";
import { hashContent } from "../../contentHash";
import { FINANCE_JUDGMENT_START, FINANCE_JUDGMENT_END } from "../../handoffContracts/financeJudgment";
import {
  createPage,
  createVersionPage,
  getPage,
  number,
  plainText,
  queryDataSource,
  relation,
  richText,
  richTextLong,
  select,
  url,
  title,
  uniqueId,
  updatePage,
  type NotionPage,
} from "../../notion";
import { mintApprovalProofForWork, workSessionContext, workSessionReadContext } from "../../access";
import { recordWorkAction } from "../dispatch";
import { updateHandoff, findIdentityViolation, type HandoffIdentity } from "../../handoffWriter";
import { logActivity } from "../../log";
import { getWorkspaceTarget, sendOperationsMessage, sendWorkspaceHatMessage, type InlineButton } from "../../telegram";
import { buildProposalDocLayout } from "../../proposalRedline";
import { listAuthorizedGoogleAccounts, registerWatchedGoogleDoc, getValidGoogleAccessToken, extractDocText } from "../../googleOAuth";
import { classifyProposalCommentIntent, markProposalDocCommentProcessed, CommentMarkerPersistenceError } from "../../googleDocComments";
import { invokeTool } from "../../runtime/toolRegistry";
import { advanceWorkStatus, finishWorkStatus, startWorkStatus, workStatusHeader } from "../../runtime/workStatus";
import { evaluateHandoffContext } from "../../dataBoundary/policy";
import { resolveEntityMatterFromTokens } from "../../identityResolution";
import { declaredHandoffTokens, resolveHandoffContextBinding } from "../../handoffSources";

import { salesOf } from "./salesState";
/**
 * Runtime Sales Proposal production for a Finance -> Sales Handoff.
 *
 * HO (Finance -> Sales, Pending) -> this module -> exactly one canonical,
 * token-safe Proposal record (Approval Status: Pending Approval) -> Martin
 * reviews the complete Proposal in the Workspace (Conversation) stream ->
 * Martin authorizes the exact Proposal ID + Version -> Approved. Per the
 * identity architecture decision recorded in Notion (Sept 2026), the
 * Entity/Matters databases no longer carry any real-world identity fields
 * at all -- real identity lives exclusively in the separate Identity
 * Resolution Registry, which this module still never touches -- so on
 * approval this module now resolves the Handoff's own opaque Entity/Matter
 * tokens to their real operational page IDs directly and advances
 * the Matter's operational Status itself, rather than leaving that for
 * the isolated Identity & Artifact environment to do manually. Artifact
 * Status still moves to Pending Identity Resolution: producing the actual
 * client-facing artifact (a document, an email) still belongs to that
 * environment, which alone can resolve real identity for delivery. This
 * module still creates no Handoff (no Sales -> Sales Work Handoff) and
 * still never touches Drive/Gmail.
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
/** How much of an unclassifiable Doc comment is quoted back to Martin in Telegram when asking what it means. */
const MAX_COMMENT_CHARS_FOR_CHAT = 300;
const FINANCE_FROM_UNIT = "Finance";
const FINANCE_FROM_HAT = "Value-Based Pricing Assessor";

export const APPROVAL_STATUSES = ["Draft", "Pending Approval", "Approved"] as const;
export type ProposalApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const ARTIFACT_STATUSES = ["Not Requested", "Pending Identity Resolution", "Created", "Delivered", "Held"] as const;
export type ProposalArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** Telegram callback action for a Runtime Sales Proposal decision. Value is "<proposalNumber>.<version>.<a|r>". */
export const PROPOSAL_CALLBACK_ACTION = "salesprop";

/**
 * The four Runtime Proposal lifecycle Actions, as registered on Sales
 * Executive (see salesManifest.ts).
 *
 * Named here as constants rather than repeated as string literals so that the
 * Action a governed write is performed under, and the Action recorded on the
 * Work at that moment, cannot drift apart: both sides reference the same
 * value, and the value is validated against the manifest by
 * `recordWorkAction` before it is ever stored.
 *
 * Their separation is the point. `proposal_approve` is the only one that
 * requires an ApprovalProof, because it is the only one that commits an
 * approval Martin gave. Drafting and submitting are pre-approval staging;
 * revising produces a new Version that must be approved on its own, so an
 * earlier approval can never authorize it.
 */
export const PROPOSAL_DRAFT_ACTION = "proposal_draft" as const;
export const PROPOSAL_SUBMIT_ACTION = "proposal_submit" as const;
export const PROPOSAL_APPROVE_ACTION = "proposal_approve" as const;
export const PROPOSAL_REVISION_ACTION = "proposal_revision" as const;

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
  strategy: StrategyBoundaryRepresentation;
  investmentTolerance?: InvestmentToleranceNote;
}

export interface ProposalVersionRecord {
  version: number;
  content: string;
  contentHash: string;
  createdAt: string;
  origin: "generated" | "revision";
  /** The readable child page holding exactly this version (see createVersionPage); absent for versions written before version pages existed. */
  pageUrl?: string;
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
  /**
   * The ONE Google Doc for this Proposal: the current version as clean text on
   * top and a struck-through / added redline of each revision below
   * (proposalRedline.ts). `version` is the version the Doc currently shows;
   * a comment on it is a change REQUEST, never an edit. Rewritten in place on
   * every revision -- never one Doc per version.
   */
  doc?: { documentId: string; url: string; accountIdentifier: string; version: number };
}

/**
 * One actionable (substantive) comment inside the Proposal's current approval
 * cycle, and how it ended. `commentId` is the Google Drive comment id, so the
 * same comment is tracked exactly once across polling cycles.
 */
export interface ProposalCycleItem {
  /** The Drive comment id this item tracks. */
  commentId: string;
  /** Only substantive comments open a cycle; formatting-only and ambiguous ones never do. */
  intent: "substantive";
  /** The comment's own text, verbatim, as the requested change. */
  requestedChange: string;
  /** The Version the comment was left against (the Doc's bound version at that moment). */
  commentedVersion: number;
  /**
   * `awaiting_application` while the requested change has not been applied
   * through the governed path; `applied` only once the revision exists AND the
   * canonical Doc was brought to it and verified; `refused` when the request
   * could not be honoured (stale, identity-bearing, Work no longer Sales'...).
   * A `refused` item is never "fulfilled" and never satisfies the cycle.
   */
  outcome: "awaiting_application" | "applied" | "refused";
  /** The Version the change landed in, once `outcome` is `applied`. */
  appliedVersion?: number;
  /** Last observed Drive `resolved` state for this comment (resolution is a SEPARATE signal from processing). */
  observedResolved: boolean;
  /** The Drive `modifiedTime` observed when `observedResolved` last became true. */
  observedResolvedAt?: string;
}

/**
 * The approval cycle for the Proposal bound to a canonical Google Doc.
 * Opened (or reopened) the moment a substantive comment is classified -- with
 * the record's Approved Version binding cleared in the same breath, so a
 * revised Version can never be released under a stale approval.
 *
 * The cycle COMPLETES -- and approves the current Version through the shared
 * approval write -- exactly when every item in it is `applied` (change run
 * through the governed path AND the Doc brought to that Version and verified),
 * every item is observed `resolved`, and the canonical Doc reads back as the
 * exact current Version. Observed resolution IS the approval signal (Martin's
 * explicit choice); no resolver identity is required. Completion is idempotent:
 * the Proposal's own `Approval Status` is the guard, so a repeated poll or a
 * duplicate observation returns `already_approved` and performs no write.
 */
export interface ProposalApprovalCycle {
  proposalNumber: number;
  /** The canonical Doc this cycle's comments live on. */
  documentId: string;
  /** The Version the cycle opened from. */
  baseVersion: number;
  openedAt: string;
  /** Every actionable comment in this cycle, keyed by its Drive comment id. */
  items: Record<string, ProposalCycleItem>;
}

export function versionLabel(version: number): string {
  return `v${version}`;
}

function parseVersionLabel(label: string): number | null {
  const m = label.trim().match(/^v(\d+)$/);
  return m ? Number(m[1]) : null;
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
 * The same completeness check as findMissingStrategyFacts, over the curated
 * StrategyBoundaryRepresentation Sales now actually receives (via the
 * Finance -> Sales Handoff) instead of the complete StrategyProposal.
 * Deliberately a separate function rather than widening
 * findMissingStrategyFacts's own signature -- that function is kept exactly
 * as it was.
 */
export function findMissingStrategyBoundaryFacts(strategy: StrategyBoundaryRepresentation | undefined): string[] {
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
 * Parses the Strategy-authored boundary block out of a Finance -> Sales
 * Handoff's combined "Verified Facts & Sources" text. This IS the Strategy-
 * facts source for Runtime Sales Proposal production -- fails closed
 * (returns `error`) on any missing markers, invalid JSON, non-object
 * content, missing proposalId/proposalVersion, or an incomplete
 * representation, and never falls back to state.strategyProposal, old
 * conversation state, Telegram history, another Handoff, or an
 * inferred/reconstructed value.
 */
export function parseStrategyBoundaryRepresentation(handoffText: string): { representation: StrategyBoundaryRepresentation } | { error: string } {
  const block = extractLabeledBlock(handoffText, STRATEGY_BOUNDARY_START, STRATEGY_BOUNDARY_END);
  if (!block) return { error: "the Handoff carries no Strategy boundary representation (missing START/END markers)" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return { error: "the Strategy boundary representation is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "the Strategy boundary representation is not a JSON object" };
  }
  const rep = parsed as Partial<StrategyBoundaryRepresentation>;
  if (typeof rep.proposalId !== "string" || !rep.proposalId.trim()) {
    return { error: "the Strategy boundary representation has no proposalId" };
  }
  if (typeof rep.proposalVersion !== "number" || !Number.isFinite(rep.proposalVersion)) {
    return { error: "the Strategy boundary representation has no proposalVersion" };
  }
  const missing = findMissingStrategyBoundaryFacts(rep as StrategyBoundaryRepresentation);
  if (missing.length) return { error: `the Strategy boundary representation is incomplete: ${missing.join("; ")}` };
  return { representation: rep as StrategyBoundaryRepresentation };
}

/**
 * Parses Finance's own commercial-judgment block out of the same combined
 * Handoff text, then hands its inner content to the existing, unchanged
 * parseFinanceQuote -- the block's own inner wording ("Authoritative
 * quote: ...\nRationale: ...") is written by Finance in exactly the format
 * parseFinanceQuote already expects, so no change to that function's own
 * parsing logic was needed.
 */
export function parseFinanceJudgmentBlock(handoffText: string): { quote: ProposalQuote } | { error: string } {
  const block = extractLabeledBlock(handoffText, FINANCE_JUDGMENT_START, FINANCE_JUDGMENT_END);
  if (!block) return { error: "the Handoff carries no Finance commercial judgment block (missing START/END markers)" };
  const parsed = parseFinanceQuote(block);
  if ("missing" in parsed) return { error: parsed.missing };
  return { quote: parsed.quote };
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
    `Entity token: ${facts.entityToken}`,
    `Matter token: ${facts.matterToken}`,
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
  await finishWorkStatus(env, state, "⛔ Blocked -- the reason is below.", "failed");
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
      // Judged as this Work item advancing its own Handoff, with the Handoff's
      // real tokens supplied as the identity the write is validated against.
      // (These were previously passed in the Access position, so the write was
      // validated against an EMPTY identity and no Access decision was made.)
      workSessionContext(state),
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
 * record linked to the Handoff, or a Proposal for the same Matter token that
 * is not linked to this Handoff.
 */
async function findExistingProposal(
  env: Env,
  state: WorkState,
  handoffId: string,
  matterToken: string,
): Promise<{ page?: NotionPage } | { error: string }> {
  if (state.sales?.proposal?.handoffId === handoffId) {
    return { page: await getPage(env, state.sales?.proposal.pageId, workSessionContext(state)) };
  }
  const linked = await queryDataSource(env, env.PROPOSALS_DATA_SOURCE_ID, workSessionReadContext(),  { property: "Handoff", relation: { contains: handoffId } });
  if (linked.length > 1) return { error: `${linked.length} Proposal records are linked to this Handoff; cannot determine the canonical one.` };
  if (linked.length === 1) return { page: linked[0] };
  const sameMatter = await queryDataSource(env, env.PROPOSALS_DATA_SOURCE_ID, workSessionReadContext(),  { property: "Matter Token", rich_text: { equals: matterToken } });
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
    : [
        ...existingVersions,
        {
          version,
          content,
          contentHash: await hashContent(content),
          createdAt: new Date().toISOString(),
          origin: "generated" as const,
          ...(plainText(props["Current Version Link"]).trim() ? { pageUrl: plainText(props["Current Version Link"]).trim() } : {}),
        },
      ];
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
  if (sp.doc && sp.doc.version === version) return [row];
  return [row, [{ text: `📄 Create Google Doc for ${v}`, callback_data: `${PROPOSAL_CALLBACK_ACTION}:__WORK__:${sp.proposalNumber}.${version}.g` }]];
}

function withWorkId(buttons: InlineButton[][], workId: string): InlineButton[][] {
  return buttons.map((row) => row.map((b) => ({ ...b, callback_data: b.callback_data.replace("__WORK__", workId) })));
}

/** Presents the COMPLETE Proposal for the exact Proposal ID + Version, with approval bound to that pair. */
async function presentForApproval(env: Env, state: WorkState, sp: RuntimeSalesProposal): Promise<WorkState> {
  const record = sp.versions.find((v) => v.version === sp.currentVersion);
  if (!record) return failClosed(env, state, `content for ${sp.proposalId} ${versionLabel(sp.currentVersion)} is not available to present.`);
  // Martin reads the Proposal in a Google Doc, never in Telegram: the Doc for
  // this exact version is created here (token-safe content only) and the
  // approval request carries its link. If the Doc can't be created the
  // version's Notion page is the readable fallback, and the Create button
  // retries -- the Proposal text is never written into the message.
  const doc = await ensureProposalDoc(env, state, sp);
  const readLine = doc.ok
    ? `Read it here (comment on the Doc to request a change): ${doc.url}`
    : `⚠️ The Google Doc could not be created (${doc.error}).${record.pageUrl ? ` Read this version in Notion instead: ${record.pageUrl}` : ""}`;
  const notes = sp.facts
    ? buildReviewNotes(sp.facts, { proposalId: sp.proposalId, version: sp.currentVersion, amendments: sp.amendments })
    : "Unavailable: the upstream facts this Proposal was built from are not on this work item.";
  const message = [
    [
      "*Proposal approval request*",
      `Proposal: ${sp.proposalId} · Version: ${versionLabel(sp.currentVersion)}`,
      `Entity: ${sp.entityToken} · Matter: ${sp.matterToken} · Source Handoff: ${sp.handoffRef}`,
      `Approval Status: ${sp.approvalStatus} · Artifact Status: ${sp.artifactStatus}`,
      `Record: ${sp.pageUrl}`,
      readLine,
    ].join("\n"),
    "=== INTERNAL REVIEW MATERIAL — not part of the Proposal, not stored in Proposal Content, not approved with it ===",
    notes,
    `When you are happy with it, approve exactly *${sp.proposalId} ${versionLabel(sp.currentVersion)}* below. Approval applies to the Proposal content of this Version only.`,
  ].join("\n\n");
  const buttons = withWorkId(decisionButtons(sp, sp.currentVersion, true), state.workId);
  await finishWorkStatus(env, state, `✅ ${sp.proposalId} ${versionLabel(sp.currentVersion)} ready below -- awaiting your approval.`, "succeeded");
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
 * and version. This is a BOUNDED known-identity guarantee, not a claim that
 * the Proposal is free of arbitrary/unknown identity -- see
 * strategyAnalyst.ts's checkStrategyProposalForKnownIdentity and
 * types.ts's WorkState.strategyProposalTokenSafety doc comments for the
 * exact claim and its limits. Two independent deterministic checks make up
 * the evidence, both required: (1) the Sales-authored Sales -> Strategy
 * source Handoff was checked against Sales's known identity at write time
 * (sourceBoundary), and (2) the complete assembled Strategy Proposal for
 * this EXACT version was independently checked against that same
 * known-identity set (proposalContent). Neither Martin's approval, the
 * Handoff merely existing, nor Outbound Data Gate passage is evidence of
 * either -- both are separate, unrelated gates. Fails closed if either
 * check is missing or not marked as having run -- a legacy
 * `{proposalId, proposalVersion, basis: string}` attestation cannot pass,
 * since it has neither `sourceBoundary` nor `proposalContent`.
 *
 * The field lists each check recorded are evidence, not a requirement
 * (Martin's decision, 2026-10-08). Under the identity architecture an
 * Entity/Matter name is always its own token, so Strategy's proposal check
 * deliberately records only the fields that can still be real identity
 * (contactName/email/phone, when known) -- requiring `entityName`/
 * `matterName` there could never pass, and blocked every Strategy-originated
 * Proposal (MAT-26, HO-86 -> HO-87).
 */
export function verifyStrategyProposalTokenSafety(state: WorkState): string | null {
  const proposal = state.strategy?.proposal;
  if (!proposal) return null; // absence is reported by resolveFacts as a missing fact
  const attestation = state.strategy?.proposalTokenSafety;
  if (!attestation) {
    return `the approved Strategy Proposal (${proposal.proposalId} v${proposal.proposalVersion}) has no token-safety attestation on record -- it cannot be used as a Proposal source.`;
  }
  if (attestation.proposalId !== proposal.proposalId || attestation.proposalVersion !== proposal.proposalVersion) {
    return `the token-safety attestation on record is for Strategy proposal ${attestation.proposalId} v${attestation.proposalVersion}, not the approved ${proposal.proposalId} v${proposal.proposalVersion}.`;
  }
  const sourceBoundary = attestation.sourceBoundary;
  if (!sourceBoundary || sourceBoundary.checked !== true) {
    return `the token-safety attestation for ${proposal.proposalId} v${proposal.proposalVersion} does not confirm the Sales source-boundary identity check ran and passed.`;
  }
  const proposalContent = attestation.proposalContent;
  if (!proposalContent || proposalContent.checked !== true) {
    return `the token-safety attestation for ${proposal.proposalId} v${proposal.proposalVersion} does not confirm the complete Strategy Proposal was independently checked for known identity.`;
  }
  return null;
}

/**
 * Resolves the upstream facts for this Handoff: the authoritative Finance
 * quote and the Strategy boundary representation, BOTH read exclusively
 * from the Finance -> Sales Handoff's own "Verified Facts & Sources" text
 * (see parseStrategyBoundaryRepresentation / parseFinanceJudgmentBlock) --
 * never from state.strategyProposal, per the Strategy -> Finance -> Sales
 * boundary-routing change. Returns the exact list of what's missing instead
 * of guessing, and never falls back to state, conversation history, another
 * Handoff, or an inferred value.
 */
async function resolveFacts(
  env: Env,
  state: WorkState,
  handoff: NotionPage,
  tokens: { entityToken: string; matterToken: string },
  quote: ProposalQuote,
): Promise<{ facts: ProposalFacts } | { missing: string[] }> {
  const handoffText = plainText(handoff.properties["Verified Facts & Sources"]);
  const strategyResult = parseStrategyBoundaryRepresentation(handoffText);

  const missing: string[] = [];
  if ("error" in strategyResult) {
    missing.push(`the Strategy boundary representation from the Finance -> Sales Handoff (${strategyResult.error})`);
  } else {
    if (state.entityToken && state.entityToken !== tokens.entityToken) missing.push(`a consistent Entity token (work item ${state.entityToken} vs Handoff ${tokens.entityToken})`);
    if (state.matterToken && state.matterToken !== tokens.matterToken) missing.push(`a consistent Matter token (work item ${state.matterToken} vs Handoff ${tokens.matterToken})`);
  }
  if (missing.length) return { missing };
  const strategy = (strategyResult as { representation: StrategyBoundaryRepresentation }).representation;

  let investmentTolerance: InvestmentToleranceNote | undefined;
  const t = state.investmentToleranceContext;
  if (t && typeof t.low === "number" && typeof t.high === "number" && t.currency) {
    investmentTolerance = { low: t.low, high: t.high, currency: t.currency, source: "recorded during Sales discovery" };
  } else {
    // Optional context only: read the labeled planning-range line from the
    // one Sales -> Strategy Handoff for this Matter. Never required, and no
    // other text from that record is used.
    try {
      // The retired `Matter_Token` Handoff property is read nowhere, so the
      // Matter is not a query filter: the query selects the two Unit fields
      // (real schema properties) and the SAME `Sources` extraction every
      // other runtime path uses picks the one record that declares this
      // Matter's opaque token -- deterministic, fetch-free, no title match,
      // no inference, and an ambiguous or absent match simply omits the
      // optional context.
      const salesToStrategy = await queryDataSource(env, env.HANDOFFS_DATA_SOURCE_ID, workSessionReadContext(),  {
        and: [
          { property: "From Unit", select: { equals: "Sales" } },
          { property: "To Unit", select: { equals: "Strategy" } },
        ],
      });
      const forThisMatter = salesToStrategy.filter((page) => declaredHandoffTokens(page.properties).matterToken === tokens.matterToken);
      if (forThisMatter.length === 1) {
        const range = extractInvestmentTolerance(plainText(forThisMatter[0].properties["Verified Facts & Sources"]));
        const ref = uniqueId(forThisMatter[0].properties["Handoff ID"]) || forThisMatter[0].id;
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
      strategyProposalId: strategy.proposalId,
      strategyProposalVersion: strategy.proposalVersion,
      strategy,
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
export async function handleProposalHandoffPickup(env: Env, state: WorkState, _skills: ResolvedActionSkillSet): Promise<WorkState> {
  if (!getWorkspaceTarget(env)) {
    return failClosed(env, state, "the Telegram Conversation (Workspace) stream is not configured (TELEGRAM_GROUP_CHAT_ID / WORKSPACE_TOPIC_ID); the Proposal cannot be presented for approval, so none was produced.");
  }
  const handoffId = state.handoffId;
  if (!handoffId) return failClosed(env, state, "this work item has no Handoff to resolve.");

  await startWorkStatus(env, state, HAT, workStatusHeader(HAT, state, "picking up a quote"), "Reading the Finance -> Sales Handoff");
  let handoff: NotionPage;
  try {
    handoff = await getPage(env, handoffId, workSessionContext(state));
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

  await advanceWorkStatus(env, state, "Checking the Handoff's tokens, context and Finance judgment block");
  // The Handoff's operational identity comes from its OWN `Sources` payload
  // through the one binding entry point every other runtime path uses: the
  // opaque token entries, resolved through ENIG's authorized operational
  // stores and validated against the Finance -> Sales route contract. The
  // retired `Entity_Token`/`Matter_Token` Handoff properties are read
  // nowhere, and no failure here falls back to another source -- fail closed.
  let entityToken = "";
  let matterToken = "";
  let bindingFailure = "";
  try {
    const binding = await resolveHandoffContextBinding(env, {
      properties: hp,
      route: { fromUnit: FINANCE_FROM_UNIT, toUnit: "Sales" },
      access: workSessionContext(state),
    });
    if (binding.ok) {
      entityToken = binding.entityToken;
      matterToken = binding.matterToken;
    } else {
      bindingFailure = binding.reason;
    }
  } catch (err) {
    bindingFailure = err instanceof Error ? err.message : String(err);
  }
  if (state.workStatus && matterToken) state.workStatus.header = workStatusHeader(HAT, { matterToken, entityToken }, "picking up a quote");
  if (bindingFailure || !TOKEN_PATTERN.test(entityToken) || !TOKEN_PATTERN.test(matterToken)) {
    return failClosed(
      env,
      state,
      bindingFailure
        ? `the Handoff's operational identity could not be established from its "Sources" payload (${bindingFailure}).`
        : "the Handoff's Sources payload carries no opaque Entity and/or Matter token.",
      { holdHandoffId: handoffId },
    );
  }
  const tokens = { entityToken, matterToken };
  const identity = knownIdentity(state, entityToken, matterToken);

  const verifiedFacts = plainText(hp["Verified Facts & Sources"]);
  const contract = evaluateHandoffContext(
    { handoffId, entityToken, matterToken, sanitizedContext: verifiedFacts, provenance: `notion:handoff:${handoffId}`, requiredCategory: "authoritative quote and proposal scope" },
    "sales.proposal_drafting",
  );
  if (!contract.success) return failClosed(env, state, contract.insufficientContext.reason, { holdHandoffId: handoffId, tokens });

  const parsed = parseFinanceJudgmentBlock(verifiedFacts);
  if ("error" in parsed) return failClosed(env, state, `missing or ambiguous: ${parsed.error}.`, { holdHandoffId: handoffId, tokens });

  await advanceWorkStatus(env, state, "Looking for an existing Proposal for this Handoff");
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
      ...(state.sales?.proposal ?? {}),
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
    salesOf(state).proposal = sp;
    if (status !== "Closed") {
      await updateHandoff(
        env,
        handoffId,
        { Status: select("Closed"), "Work Completed": richText(`Token-safe Proposal ${sp.proposalId} ${versionLabel(sp.currentVersion)} recorded (${sp.approvalStatus}).`) },
        workSessionContext(state),
        tokens,
      );
    }
    await logActivity(env, {
      entry: `Runtime Sales Proposal reprocessed — no new record: ${sp.proposalId} ${versionLabel(sp.currentVersion)}`,
      type: "Activity",
      area: "Sales",
      activity: `Handoff ${sp.handoffRef} reprocessed; canonical Proposal ${sp.proposalId} already exists (${sp.approvalStatus}).`,
      outcome: "Active",
    });
    if (sp.approvalStatus === "Approved") {
      await finishWorkStatus(env, state, `✅ ${sp.proposalId} is already Approved -- nothing new was created.`, "succeeded");
      await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, `${sp.proposalId} ${versionLabel(sp.currentVersion)} is already Approved (Artifact Status: ${sp.artifactStatus}). Nothing new was created.`);
      state.stage = "sales_proposal_approved";
      return state;
    }
    // Still Pending Approval: a prior run may have stopped at the Doc step.
    // Resume the same Doc-then-approve sequence (idempotent) rather than
    // re-presenting an explicit approval request the rule no longer needs.
    const resumed = await ensureDocThenAutoApprove(env, state, sp, `${sp.proposalId} ${versionLabel(sp.currentVersion)}`);
    if (resumed.ok) {
      await finishWorkStatus(env, state, `✅ ${sp.proposalId} ${versionLabel(sp.currentVersion)} reprocessed: Doc verified and approved.`, "succeeded");
      await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, `${sp.proposalId} ${versionLabel(sp.currentVersion)} was reprocessed: its Doc verified and it is now Approved (Artifact Status: ${sp.artifactStatus}).`);
      state.stage = "sales_proposal_approved";
      return resumed.state;
    }
    return failClosed(
      env,
      state,
      `${sp.proposalId} ${versionLabel(sp.currentVersion)} is still Pending Approval because its canonical Doc could not be verified (${resumed.error}); reprocess this Handoff once the Doc step succeeds. Approval is never claimed before the Doc verifies.`,
      { holdHandoffId: handoffId, tokens },
    );
  }

  if (status !== "Pending" && status !== "Picked-up") {
    return failClosed(env, state, `Handoff ${handoffId} is ${status || "in an unknown status"} and has no canonical Proposal; not producing one from a non-active Handoff.`);
  }

  await advanceWorkStatus(env, state, "Checking the Strategy Proposal's token-safety attestation");
  const unverified = verifyStrategyProposalTokenSafety(state);
  if (unverified) return failClosed(env, state, `Strategy Proposal identity boundary: ${unverified}`, { holdHandoffId: handoffId, tokens });

  await advanceWorkStatus(env, state, "Resolving the Proposal facts from the approved Strategy Proposal and the Finance quote");
  const resolved = await resolveFacts(env, state, handoff, tokens, parsed.quote);
  if ("missing" in resolved) {
    return failClosed(env, state, `required Proposal facts are missing: ${resolved.missing.join("; ")}.`, { holdHandoffId: handoffId, tokens });
  }
  const facts = resolved.facts;

  // Pre-check the full composed content before anything is written.
  await advanceWorkStatus(env, state, "Checking the composed Proposal is token-safe");
  if (!isTokenSafe(buildProposalContent(facts, { proposalId: "PENDING", version: 1, amendments: [] }), identity)) {
    return failClosed(env, state, "an identity-bearing value (a real name or contact detail) would enter the Runtime Proposal; nothing was written.", { holdHandoffId: handoffId, tokens });
  }

  // The Work is about to perform a DIFFERENT registered operation from the one
  // it was performing. It arrived under one Action (the Finance Handoff pickup
  // that brought it here, or new_enquiry for a direct request) and is now
  // drafting the canonical Proposal -- which is its own operation, declared on
  // the Hat, with its own consequence and its own (ungated) approval
  // requirement.
  //
  // Recorded HERE, before the first governed write of the draft path, so every
  // write below is judged against the operation actually being performed. The
  // call sites additionally ASSERT this name, which turns a Work that had
  // drifted to some other Action into a fail-closed denial rather than a write
  // performed under the wrong operation.
  recordWorkAction(state, PROPOSAL_DRAFT_ACTION);

  await advanceWorkStatus(env, state, "Creating the Proposal record and writing v1 to Notion");
  await updateHandoff(env, handoffId, { Status: select("Picked-up") }, workSessionContext(state), tokens);

  // Two-step create: the Proposal ID is only known once the record exists,
  // and the content names it. The record stays Draft (never presented, never
  // approvable) until its content is written; a retry finds it by Handoff.
  const page =
    existing.page ??
    (await createPage(
      env,
      env.PROPOSALS_DATA_SOURCE_ID,
      {
        Proposal: title(`Proposal — ${matterToken}`),
        "Entity Token": richText(entityToken),
        "Matter Token": richText(matterToken),
        Handoff: relation([handoffId]),
        Status: select("Draft"),
        "Approval Status": select("Draft"),
        "Artifact Status": select("Not Requested"),
      },
      workSessionContext(state, undefined, PROPOSAL_DRAFT_ACTION),
    ));
  const created = page.properties?.["Proposal ID"]?.unique_id ? page : await getPage(env, page.id, workSessionContext(state));
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

  const versionPage = await createVersionPage(env, page.id, `${proposalId} ${versionLabel(1)}`, content, workSessionContext(state, undefined, PROPOSAL_DRAFT_ACTION));
  await updatePage(env, page.id, {
    "Proposal Content": richTextLong(content),
    "Current Version Link": url(versionPage.url),
    Version: richText(versionLabel(1)),
    "Approval Status": select("Pending Approval"),
    "Approved Version": { rich_text: [] },
    "Artifact Status": select("Not Requested"),
    "Quoted Price": number(facts.quote.price),
    "Quote Rationale": richText(`Currency: ${facts.quote.currency}. ${facts.quote.rationale}`),
  }, workSessionContext(state, undefined, PROPOSAL_DRAFT_ACTION));

  // The draft now exists with its content written, so the Work's Action
  // advances from DRAFTING to SUBMITTING: this is the transition that puts
  // the Proposal into Pending Approval and presents it to Martin. Submission
  // requests approval; it is not approval, so it requires no proof. Recording
  // it here -- by the code performing the transition, at the moment it
  // happens -- is what lets Martin's later decision be judged against
  // proposal_approve rather than against the Action that drafted the text.
  recordWorkAction(state, PROPOSAL_SUBMIT_ACTION);

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
    versions: [{ version: 1, content, contentHash, createdAt: new Date().toISOString(), origin: "generated", pageUrl: versionPage.url }],
    amendments: [],
    facts,
  };
  salesOf(state).proposal = sp;
  salesOf(state).pendingProposalRevision = undefined;
  state.blockedReason = undefined;

  // The canonical Doc must exist and read back as this exact Version before
  // any Approved state is exposed or any artifact release is possible.
  const outcome = await ensureDocThenAutoApprove(env, state, sp, `${proposalId} ${versionLabel(1)}`);
  if (!outcome.ok) {
    await logActivity(env, {
      entry: `Runtime Sales Proposal created but NOT approved: ${proposalId} ${versionLabel(1)} — ${matterToken}`,
      type: "Activity",
      area: "Sales",
      activity: `From Handoff ${facts.handoffRef}. Content SHA-256 ${contentHash}. The canonical Google Doc could not be written and verified: ${outcome.error}.`,
      nextActions: `Reprocess this Handoff to retry the Doc step; ${proposalId} ${versionLabel(1)} stays Pending Approval and is not releasable until the Doc verifies.`,
      outcome: "Blocked",
    });
    await updateHandoff(
      env,
      handoffId,
      { Status: select("Closed"), "Work Completed": richText(`Token-safe Proposal ${proposalId} ${versionLabel(1)} content written, but its canonical Doc failed to verify; not approved.`) },
      workSessionContext(state),
      tokens,
    );
    return failClosed(
      env,
      state,
      `the initial Proposal content was written but its canonical Google Doc could not be written and verified (${outcome.error}); ${proposalId} ${versionLabel(1)} is left Pending Approval and is NOT approved. Reprocess this Handoff once the Doc step succeeds -- approval is never claimed before the Doc verifies.`,
    );
  }

  await updateHandoff(
    env,
    handoffId,
    { Status: select("Closed"), "Work Completed": richText(`Token-safe Proposal ${proposalId} ${versionLabel(1)} created, Doc verified, and auto-approved.`) },
    workSessionContext(state),
    tokens,
  );
  await logActivity(env, {
    entry: `Runtime Sales Proposal created: ${proposalId} ${versionLabel(1)} — ${matterToken}`,
    type: "Activity",
    area: "Sales",
    activity: `From Handoff ${facts.handoffRef}. Quote ${formatMoney(facts.quote.currency, facts.quote.price)} preserved. Content SHA-256 ${contentHash}. Doc verified: ${outcome.url}`,
    nextActions: `Approved by the initial-creation rule. Comment on the Doc to request a change.`,
    outcome: "Active",
  });
  return presentApprovedProposal(env, outcome.state, sp, outcome.url);
}

/**
 * The Doc-write-then-auto-approve sequence shared by initial creation and the
 * idempotent reprocess path: bring the canonical Doc to the current Version
 * (verified read-back) and only then apply the approval write. On any Doc
 * failure it returns `{ok:false}` and the caller reports; nothing here
 * claims approval before the Doc verifies.
 */
async function ensureDocThenAutoApprove(
  env: Env,
  state: WorkState,
  sp: RuntimeSalesProposal,
  label: string,
): Promise<{ ok: true; url: string; state: WorkState } | { ok: false; error: string }> {
  recordWorkAction(state, PROPOSAL_SUBMIT_ACTION);
  const doc = await ensureProposalDoc(env, state, sp);
  if (!doc.ok) return { ok: false, error: doc.error };

  // Approved by the canonical Proposal rule itself -- "Approved once its
  // content and canonical Google Doc have been successfully written and
  // verified" -- NOT by a Telegram tap. The Work's Action advances to
  // proposal_approve and the approval write runs through the same shared
  // implementation as Martin's explicit decision.
  recordWorkAction(state, PROPOSAL_APPROVE_ACTION);
  const approvedVersionLink = plainText((await getPage(env, sp.pageId, workSessionReadContext(state.workId))).properties["Current Version Link"]).trim();
  const approved = await applyProposalApprovalWrite(env, state, sp, sp.currentVersion, {
    approvedVersionLink,
    decisions: `${label} auto-approved by the initial-creation rule (content + canonical Doc written and verified). Entity ${sp.entityToken}, Matter ${sp.matterToken}.`,
    rationalePrefix: `Initial version auto-approved under the canonical Proposal governance rule; Doc written and verified at ${doc.url}.`,
    summaryHeading: `✅ Approved: *${label}*.`,
  });
  return { ok: true, url: doc.url, state: approved };
}

/**
 * Presents an auto-approved (initial-creation) Proposal: no approval tap is
 * requested, because approval already happened under the governance rule.
 * Only the "Request changes" affordance and the Doc link are offered.
 */
async function presentApprovedProposal(env: Env, state: WorkState, sp: RuntimeSalesProposal, docUrl: string): Promise<WorkState> {
  // The internal review material still reaches Martin even though no approval
  // tap is requested: it is his context for deciding whether to comment a
  // change, and dropping it would hide the open items / rationale conflict.
  const notes = sp.facts
    ? buildReviewNotes(sp.facts, { proposalId: sp.proposalId, version: sp.currentVersion, amendments: sp.amendments })
    : "Unavailable: the upstream facts this Proposal was built from are not on this work item.";
  const buttons = withWorkId(decisionButtons(sp, sp.currentVersion, false), state.workId);
  await finishWorkStatus(
    env,
    state,
    `✅ ${sp.proposalId} ${versionLabel(sp.currentVersion)} created, Doc verified, and approved.`,
    "succeeded",
  );
  const message = [
    [
      `*${sp.proposalId} ${versionLabel(sp.currentVersion)} is approved.*`,
      `Proposal: ${sp.proposalId} · Version: ${versionLabel(sp.currentVersion)}`,
      `Entity: ${sp.entityToken} · Matter: ${sp.matterToken} · Source Handoff: ${sp.handoffRef}`,
      `Approval Status: ${sp.approvalStatus} · Approved Version: ${versionLabel(sp.approvedVersion ?? sp.currentVersion)} · Artifact Status: ${sp.artifactStatus}`,
      `Record: ${sp.pageUrl}`,
      `Read it here (comment on the Doc to request a change): ${docUrl}`,
    ].join("\n"),
    "=== INTERNAL REVIEW MATERIAL — not part of the Proposal, not stored in Proposal Content, not approved with it ===",
    notes,
    `No approval tap is needed for the initial Version: it is approved by the canonical Proposal rule once its content and Doc are written and verified. To change it, comment on the Doc (or use Request changes below) -- a substantive request reopens approval for a new Version.`,
  ].join("\n\n");
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, message, buttons);
  state.pendingActionSummary = undefined;
  state.stage = "sales_proposal_approved";
  state.awaiting = undefined;
  return state;
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
  decision: "approve" | "revise" | "doc",
): Promise<WorkState> {
  const sp = state.sales?.proposal;
  if (!sp) return staleDecision(env, state, "there is no Runtime Proposal on this work item.");
  if (sp.proposalNumber !== proposalNumber) {
    return staleDecision(env, state, `this decision is for Proposal #${proposalNumber}, not ${sp.proposalId}.`);
  }

  // Not a decision: a request for a readable, commentable copy. It changes
  // nothing about the Proposal, its approval state or its versions.
  if (decision === "doc") return createProposalVersionDoc(env, state, sp, version);

  if (decision === "revise") {
    if (version !== sp.currentVersion) {
      return staleDecision(env, state, `${versionLabel(version)} is not the current Version of ${sp.proposalId} (current: ${versionLabel(sp.currentVersion)}).`);
    }
    salesOf(state).pendingProposalRevision = { proposalNumber, fromVersion: version };
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

  // An open comment-approval cycle outranks a bare approve tap: while any
  // actionable comment in the current cycle is unapplied, unverified or
  // unresolved, this Version may not be approved. The tap cannot wave the
  // outstanding request away -- the cycle must close on its own terms (see
  // evaluateProposalApprovalCycle). This is what makes "no approve while a
  // requested change is outstanding" hold for the Telegram route too.
  const openCycle = state.sales?.proposalApprovalCycle;
  if (openCycle && openCycle.proposalNumber === proposalNumber) {
    const unsatisfied = unsatisfiedCycleItems(openCycle);
    if (unsatisfied.length > 0) {
      await sendWorkspaceHatMessage(
        env,
        { ...state, hat: HAT },
        `Cannot approve ${sp.proposalId} ${versionLabel(version)}: ${unsatisfied.length} actionable comment(s) in the current approval cycle are not yet applied, verified and resolved.\n${unsatisfied.map((i) => `· ${i.commentId}: ${i.reason}`).join("\n")}\nResolve every comment on the Doc after its change is applied and verified, then approval can complete.`,
      );
      return state;
    }
  }

  // Everything below verifies, in order: this is a live Proposal record, it
  // is the one Martin is deciding on, it is still Pending Approval at this
  // exact Version, its tokens have not changed since it was presented, and
  // its content is byte-identical to what he was shown. Only now is Martin's
  // decision consumed and the proof minted.
  const check = await verifyLiveForApproval(env, state, sp, version, proposalNumber);
  if (!check.ok) {
    return check.kind === "stale" ? staleDecision(env, state, check.reason) : failClosed(env, state, check.reason);
  }

  // The Work's Action advances to proposal_approve at this point, and the
  // proof is bound to that action. Access will independently re-resolve
  // proposal_approve from the Work, confirm it requires approval, and check
  // the proof against this exact Work, this exact action, and this exact
  // Proposals data source -- so a proof minted here cannot be spent on a
  // different write, and this write cannot proceed without one.
  recordWorkAction(state, PROPOSAL_APPROVE_ACTION);
  return applyProposalApprovalWrite(env, state, sp, version, {
    // Bound to the Work's own recorded action, which was just advanced to
    // PROPOSAL_APPROVE_ACTION above -- so the proof and the resolved Action
    // cannot be two different names for this write.
    approvedVersionLink: check.approvedVersionLink,
    decisions: `Martin approved ${sp.proposalId} ${versionLabel(version)} (Entity ${sp.entityToken}, Matter ${sp.matterToken}).`,
    rationalePrefix: `Approval bound to Proposal ID ${sp.proposalId} + Version ${versionLabel(version)}; content SHA-256 ${check.contentHash}. Artifact Status set to Pending Identity Resolution.`,
    summaryHeading: `✅ Approved: *${sp.proposalId} ${versionLabel(version)}*.`,
  });
}

/**
 * The live-record preconditions BOTH approval routes must satisfy before the
 * one approval write may run: this exact Proposal is still Pending Approval
 * at this exact Version, its tokens are unchanged, and its content hash still
 * matches what was shown. Extracted so Martin's Telegram decision and the
 * Doc-comment cycle completion cannot drift apart on what "the record is
 * still what you think it is" means.
 *
 * `ok: true` also returns the evidence the write binds to -- the verified
 * content hash and the live Current Version Link copied onto Approved
 * Version Link. A failure is classified `stale` (the record moved on; the
 * decision no longer applies) or `closed` (the record cannot be trusted at
 * all), so each caller keeps its own honest refusal wording.
 */
async function verifyLiveForApproval(
  env: Env,
  state: WorkState,
  sp: RuntimeSalesProposal,
  version: number,
  proposalNumber: number,
): Promise<{ ok: true; contentHash: string; approvedVersionLink: string } | { ok: false; kind: "stale" | "closed"; reason: string }> {
  const shown = sp.versions.find((v) => v.version === version);
  if (!shown) return { ok: false, kind: "stale", reason: `no record of the ${versionLabel(version)} content Martin was shown.` };

  const live = await getPage(env, sp.pageId, workSessionContext(state));
  const liveState = await proposalFromRecord(live, sp);
  if ("error" in liveState) return { ok: false, kind: "closed", reason: liveState.error };
  if (liveState.proposalNumber !== proposalNumber || liveState.currentVersion !== version || liveState.approvalStatus !== "Pending Approval") {
    return { ok: false, kind: "stale", reason: `the Proposal record is now ${liveState.proposalId} ${versionLabel(liveState.currentVersion)} (${liveState.approvalStatus}); approval of ${versionLabel(version)} not applied.` };
  }
  if (liveState.entityToken !== sp.entityToken || liveState.matterToken !== sp.matterToken) {
    return { ok: false, kind: "closed", reason: "the Proposal record's tokens changed since it was presented; approval not applied." };
  }
  const liveHash = await hashContent(plainText(live.properties["Proposal Content"]));
  if (liveHash !== shown.contentHash) {
    return { ok: false, kind: "closed", reason: `the Proposal record's content no longer matches the ${versionLabel(version)} Martin reviewed; approval not applied.` };
  }
  return { ok: true, contentHash: liveHash, approvedVersionLink: plainText(live.properties["Current Version Link"]).trim() };
}

/**
 * The ONE approval write. Both approval routes converge here -- Martin's
 * explicit Telegram decision (handleSalesProposalDecision) and the
 * initial-creation auto-approval (finalizeInitialApprovalApproval) -- so
 * there is exactly one implementation of "move this Proposal to Approved",
 * of its ApprovalProof binding, of its Matter-status consequence, and of its
 * Activity & Decision Log entry. A second mechanism would let the two drift,
 * and the drift would be exactly the thing the release gate depends on.
 *
 * The CALLER has already verified every precondition against the live record
 * (it is the right Proposal, still Pending Approval, at this exact Version,
 * with unchanged tokens and a content hash matching what is being approved,
 * and -- for an auto- or comment-driven approval -- that the canonical Doc was
 * written/updated and read back as this exact Version). This function only
 * performs the write and its consequences; it never re-decides whether the
 * approval is warranted.
 */
async function applyProposalApprovalWrite(
  env: Env,
  state: WorkState,
  sp: RuntimeSalesProposal,
  version: number,
  opts: {
    /** The already-read "Current Version Link", copied onto "Approved Version Link". */
    approvedVersionLink: string;
    decisions: string;
    rationalePrefix: string;
    summaryHeading: string;
  },
): Promise<WorkState> {
  // The Work's Action must already be proposal_approve when this runs (both
  // callers advance it immediately before), and the proof is bound to that
  // recorded action. Access independently re-resolves proposal_approve from
  // the Work, confirms it requires approval, and checks the proof against
  // this exact Work, this exact action and this exact Proposals data source.
  const approvalProof = mintApprovalProofForWork(state, env.PROPOSALS_DATA_SOURCE_ID);

  await updatePage(
    env,
    sp.pageId,
    {
      "Approval Status": select("Approved"),
      "Approved Version": richText(versionLabel(version)),
      "Artifact Status": select("Pending Identity Resolution"),
      // The readable page of exactly the version approved (read from the
      // record just verified as at this version and content hash). Left
      // untouched for a version that predates version pages.
      ...(opts.approvedVersionLink ? { "Approved Version Link": url(opts.approvedVersionLink) } : {}),
    },
    workSessionContext(state, approvalProof, PROPOSAL_APPROVE_ACTION),
  );
  sp.approvalStatus = "Approved";
  sp.approvedVersion = version;
  sp.artifactStatus = "Pending Identity Resolution";
  state.pendingActionSummary = undefined;

  // Now authorized (see this module's header comment): resolve the
  // Handoff's own tokens to their real operational page IDs directly and
  // advance the Matter to Proposal status, rather than leaving a routine
  // status change for the isolated Identity & Artifact environment to do
  // manually. Best-effort -- a token that doesn't resolve does not undo
  // the approval Martin just made; it's logged and Operations is
  // notified so the Matter status can be advanced by hand.
  //
  // The Matter status advance is a DOWNSTREAM consequence on a different
  // governed source, not part of what Martin approved: it is a consequence
  // of the approval already applied above, not a second thing the approval
  // authorizes.
  //
  // It therefore does NOT reuse the Proposals proof above. A Proposal-scoped
  // approval must never authorize a MATTERS write, and reusing that proof
  // would make the Matter an undeclared second target of Martin's decision.
  // So it mints its own proof, bound to the same Work and the same recorded
  // Action but scoped to MATTERS -- which is exactly the shape of the
  // authorization being relied on: Martin's approval of a Proposal is what
  // carries that Proposal's Matter to Proposal status, not a general licence
  // for the Work to write to Matters. Advance the stage under any other
  // Action and no such proof can be minted, so the split stays enforced
  // rather than merely documented.
  const resolved = await resolveEntityMatterFromTokens(env, sp.entityToken, sp.matterToken);
  let matterStatusNote: string;
  if (resolved) {
    const matterAdvanceProof = mintApprovalProofForWork(state, env.MATTERS_DATA_SOURCE_ID);
    await updatePage(env, resolved.matterId, { Status: select("Proposal") }, workSessionContext(state, matterAdvanceProof, PROPOSAL_APPROVE_ACTION));
    matterStatusNote = "Matter status advanced to Proposal.";
  } else {
    matterStatusNote = "Matter status NOT advanced -- tokens did not resolve to a real, related record; needs manual handling.";
    await sendOperationsMessage(
      env,
      `⚠️ ${sp.proposalId} ${versionLabel(version)} approved, but Matter status could not be advanced -- the Entity/Matter tokens (${sp.entityToken}/${sp.matterToken}) did not resolve to a real, related Entity/Matter record.`,
    ).catch((err) => console.error("Failed to send Matter-status-not-advanced Operations notice", err));
  }

  await logActivity(env, {
    entry: `Proposal approved: ${sp.proposalId} ${versionLabel(version)} — ${sp.matterToken}`,
    type: "Decision",
    area: "Sales",
    decisions: opts.decisions,
    decisionRationale: `${opts.rationalePrefix} ${matterStatusNote}`,
    nextActions: "Identity & Artifact environment to resolve identity and produce the client-facing artifact from this approved Version.",
    outcome: "Complete",
  });
  const buttons = withWorkId(decisionButtons(sp, version, false), state.workId);
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: HAT },
    `${opts.summaryHeading}\nApproved Version: ${versionLabel(version)} · Artifact Status: Pending Identity Resolution.\n${matterStatusNote}\n\nThe approved Version is now available to the Identity & Artifact environment for the client-facing artifact. The runtime has not created any client-facing artifact or file.`,
    buttons,
  );
  state.stage = "sales_proposal_approved";
  state.awaiting = undefined;
  return state;
}

// ---------------------------------------------------------------------------
// Google Doc comment-approval cycle: initial auto-approval, immediate reopen,
// resolution tracked as a SEPARATE signal, and the fail-closed approval gate
// whose SATISFIED state completes the approval through the shared write.
// ---------------------------------------------------------------------------

/**
 * Reads the canonical Doc back through the governed read path and confirms it
 * shows EXACTLY this Proposal's current Version: the Doc is bound to the
 * current Version, and its text reads back byte-identical (modulo trailing
 * whitespace) to the canonical layout of the current Version's content. This
 * is the "the current document matches the exact current Version and content"
 * condition an approval must never skip.
 */
export async function verifyProposalDocShowsVersion(env: Env, sp: RuntimeSalesProposal): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!sp.doc) return { ok: false, reason: "no canonical Google Doc is bound to this Proposal" };
  if (sp.doc.version !== sp.currentVersion) {
    return { ok: false, reason: `the Doc is bound to ${versionLabel(sp.doc.version)} but the current Version is ${versionLabel(sp.currentVersion)}` };
  }
  const token = await getValidGoogleAccessToken(env, sp.doc.accountIdentifier);
  if (!token) return { ok: false, reason: "the authorized Google account could not be used to read the Doc back (no valid access token)" };
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(sp.doc.documentId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, reason: `the Doc could not be read back for verification (HTTP ${res.status})` };
  const expected = currentDocLayout(sp).text.trimEnd();
  const actual = extractDocText(await res.json()).trimEnd();
  if (actual !== expected) return { ok: false, reason: "the Doc's text does not match the current Version's canonical content" };
  return { ok: true };
}

/**
 * Names every actionable comment in the cycle that is not yet a satisfied
 * request: its change must be APPLIED through the governed path, VERIFIED by
 * the Doc read-back, AND observed resolved by the authorized user. Any one
 * shortfall keeps the Proposal out of Approved. Used both by the comment
 * gate and by Martin's explicit approve tap (which cannot override it).
 */
export function unsatisfiedCycleItems(cycle: ProposalApprovalCycle): { commentId: string; reason: string }[] {
  const out: { commentId: string; reason: string }[] = [];
  for (const [commentId, item] of Object.entries(cycle.items)) {
    if (item.outcome === "refused") {
      out.push({ commentId, reason: "the requested change was refused and could not be fulfilled" });
      continue;
    }
    if (item.outcome !== "applied") {
      out.push({ commentId, reason: "the requested change has not been applied through the governed path and verified" });
      continue;
    }
    if (!item.observedResolved) {
      out.push({ commentId, reason: "the comment is not yet observed resolved on the Doc" });
    }
  }
  return out;
}

/**
 * Opens (or reopens) the Proposal's approval cycle the moment a substantive
 * comment is classified -- BEFORE any revised Version can be produced or
 * released. It immediately sets Approval Status to Pending Approval and
 * clears the previous Approved Version binding (in memory and on the live
 * record), and records the comment as the cycle's first actionable item.
 *
 * This is the "a substantive comment reopens the approval cycle" invariant:
 * if the subsequent change fails to apply, the Proposal has ALREADY left the
 * Approved state, so nothing stale can be released.
 */
export async function reopenProposalApprovalCycle(
  env: Env,
  state: WorkState,
  sp: RuntimeSalesProposal,
  input: { documentId: string; commentId: string; commentedVersion: number; requestedChange: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // The Doc the comment lives on must be this Proposal's canonical Doc, and
  // the comment must be against the version that Doc currently shows -- a
  // comment on a stale binding is refused rather than silently absorbed.
  // Both guards run BEFORE any state is touched, so a refused comment neither
  // reopens the cycle nor advances this Work's recorded Action.
  if (!sp.doc || sp.doc.documentId !== input.documentId) {
    return { ok: false, reason: "the comment is not on this Proposal's canonical Doc" };
  }
  if (input.commentedVersion !== sp.currentVersion) {
    return { ok: false, reason: `the comment is against ${versionLabel(input.commentedVersion)}, not the current ${versionLabel(sp.currentVersion)}` };
  }

  recordWorkAction(state, PROPOSAL_REVISION_ACTION);
  const access = workSessionContext(state, undefined, PROPOSAL_REVISION_ACTION);
  const wasApproved = sp.approvalStatus === "Approved";
  // Clear the approval binding first, on the live record, so the reopen is
  // durable even if the rest of this call fails.
  await updatePage(
    env,
    sp.pageId,
    {
      "Approval Status": select("Pending Approval"),
      "Approved Version": richText(""),
      // A previously released artifact is Held the instant its approval is
      // withdrawn -- the same guard the ordinary revision path applies.
      ...(sp.artifactStatus !== "Not Requested" ? { "Artifact Status": select("Held") } : {}),
    },
    access,
  );
  sp.approvalStatus = "Pending Approval";
  sp.approvedVersion = undefined;
  if (sp.artifactStatus !== "Not Requested") sp.artifactStatus = "Held";

  const now = new Date().toISOString();
  const existing = state.sales?.proposalApprovalCycle;
  const cycle: ProposalApprovalCycle =
    existing && existing.proposalNumber === sp.proposalNumber && existing.documentId === input.documentId
      ? existing
      : { proposalNumber: sp.proposalNumber, documentId: input.documentId, baseVersion: sp.currentVersion, openedAt: now, items: {} };
  cycle.items[input.commentId] = {
    commentId: input.commentId,
    intent: "substantive",
    requestedChange: input.requestedChange,
    commentedVersion: input.commentedVersion,
    outcome: "awaiting_application",
    observedResolved: false,
  };
  salesOf(state).proposalApprovalCycle = cycle;

  if (wasApproved) {
    await logActivity(env, {
      entry: `Approval cycle reopened: ${sp.proposalId} — ${sp.matterToken}`,
      type: "Decision",
      area: "Sales",
      decisions: `A substantive comment (${input.commentId}) reopened ${sp.proposalId}'s approval cycle, withdrawing the Approved Version binding before any revised Version could be released.`,
      decisionRationale: `Approval binds to an exact Version whose canonical Doc reads back as that Version, so the prior binding must be withdrawn the moment a substantive comment is classified -- before any revised Version can be produced or released. The cycle re-completes when every actionable comment is observed resolved, every requested change has been applied through the governed path and verified, and the Doc matches the exact current Version.`,
      nextActions: "Apply the requested change through the governed revision path; the Proposal returns to Approved only once the cycle is satisfied on those terms.",
      outcome: "Active",
    });
  }
  return { ok: true };
}

/**
 * Records how a cycle item ended, after the governed path ran. `applied` is
 * only honest when the revision was created AND the Doc was brought to it and
 * verified; anything else is `refused` and never satisfies the cycle.
 */
export function recordProposalCycleItemOutcome(state: WorkState, commentId: string, outcome: "applied" | "refused" | "awaiting_application", appliedVersion?: number): void {
  const cycle = state.sales?.proposalApprovalCycle;
  if (!cycle) return;
  const item = cycle.items[commentId];
  if (!item) return;
  item.outcome = outcome;
  item.appliedVersion = appliedVersion;
}

/**
 * The approval gate, and the cycle's completion. Fed the resolution state
 * observed on the Doc this poll, it first records each cycle item's
 * resolution, then requires ALL of:
 *  - every actionable comment `applied` (change run through the governed path
 *    AND the canonical Doc brought to that Version and verified),
 *  - every actionable comment observed resolved, AND
 *  - the canonical Doc read back as the exact current Version.
 *
 * Only then does it approve -- through the SAME shared approval write Martin's
 * Telegram decision uses, and behind the SAME live-record preconditions, so
 * the Approved state, the Approved Version binding, the ApprovalProof, the
 * Activity entry and the Matter advance are identical however the approval
 * was reached.
 *
 * Observed resolution IS the approval signal (Martin's explicit choice); no
 * resolver identity is required or requested. Resolution alone never
 * approves: a resolution arriving before its change is applied cannot
 * complete the cycle, because the item is still not `applied`. A `refused`,
 * ambiguous or never-unverified item keeps the cycle open for the same reason.
 *
 * Completion is idempotent: the Proposal's own Approved status is the guard,
 * so a repeated poll or a duplicate observation returns `already_approved`
 * and performs no write -- no duplicate approval, no repeated Activity, no
 * repeated Matter advance, no repeated external effect.
 *
 * Everything short of that is fail-closed: an unresolved comment, an
 * unapplied/refused change, a Doc that will not verify, a Doc bound to a
 * different Version, or any uncertainty in the live record returns
 * `held_unsatisfied` with the reason and writes nothing.
 *
 * The observations are also bound to the document they were read from: a
 * `documentId` that is not this cycle's own canonical Doc returns
 * `foreign_document` with the reason, before any item is touched and before
 * anything can be written, so a pass over another Doc can never advance it.
 */
export async function evaluateProposalApprovalCycle(
  env: Env,
  state: WorkState,
  documentId: string,
  observations: { commentId: string; resolved: boolean; modifiedTime?: string }[],
): Promise<{ kind: "no_cycle" | "foreign_document" | "held_unsatisfied" | "approved" | "already_approved"; approvedVersion?: number; reasons?: string[] }> {
  const sp = state.sales?.proposal;
  const cycle = state.sales?.proposalApprovalCycle;
  if (!sp || !cycle) return { kind: "no_cycle" };
  if (cycle.proposalNumber !== sp.proposalNumber) return { kind: "no_cycle" };
  // Document binding, checked as soon as the cycle is loaded and BEFORE the
  // observation loop below mutates any item: the cycle belongs to the
  // Proposal's canonical Doc, so observations supplied for any other document
  // are refused outright with the reason (which reaches the poller's
  // `approval_cycle_synced` diagnostic), never absorbed and never written.
  if (documentId !== cycle.documentId) {
    return {
      kind: "foreign_document",
      reasons: [
        `observations were supplied for document ${documentId}, but this cycle is bound to the Proposal's canonical Doc ${cycle.documentId} -- a pass over another document never advances it`,
      ],
    };
  }
  // Idempotency guard, checked before anything can be written.
  if (sp.approvalStatus === "Approved") return { kind: "already_approved", approvedVersion: sp.approvedVersion };

  for (const o of observations) {
    const item = cycle.items[o.commentId];
    if (!item) continue; // a comment outside the current cycle never advances it
    item.observedResolved = o.resolved;
    if (o.resolved && o.modifiedTime) item.observedResolvedAt = o.modifiedTime;
  }

  const unsatisfied = unsatisfiedCycleItems(cycle);
  if (unsatisfied.length > 0) {
    return { kind: "held_unsatisfied", reasons: unsatisfied.map((u) => `${u.commentId}: ${u.reason}`) };
  }

  // The document itself must prove the Version it claims: bound to the
  // current Version and byte-identical to that Version's canonical content.
  const docCheck = await verifyProposalDocShowsVersion(env, sp);
  if (!docCheck.ok) {
    return { kind: "held_unsatisfied", reasons: [docCheck.reason] };
  }

  // ...and the live record must still be what this approval would bind to.
  // Anything uncertain here fails closed with NO approval written.
  const version = sp.currentVersion;
  const check = await verifyLiveForApproval(env, state, sp, version, sp.proposalNumber);
  if (!check.ok) {
    return { kind: "held_unsatisfied", reasons: [check.reason] };
  }

  const appliedItems = Object.values(cycle.items).filter((i) => i.outcome === "applied");
  const summary = appliedItems.map((i) => `${i.commentId} applied in ${versionLabel(i.appliedVersion ?? version)}${i.observedResolvedAt ? `, resolved ${i.observedResolvedAt}` : ""}`).join("; ");

  // The Work's Action advances to proposal_approve and the proof is minted
  // bound to it, exactly as on Martin's explicit Telegram decision -- see
  // verifyLiveForApproval and applyProposalApprovalWrite.
  recordWorkAction(state, PROPOSAL_APPROVE_ACTION);
  await applyProposalApprovalWrite(env, state, sp, version, {
    approvedVersionLink: check.approvedVersionLink,
    decisions: `${sp.proposalId} ${versionLabel(version)} approved by its Google Doc comment cycle: every actionable comment is resolved and every requested change was applied through the governed path and verified, with the canonical Doc read back as this exact Version. Entity ${sp.entityToken}, Matter ${sp.matterToken}.`,
    rationalePrefix: `Approval bound to Proposal ID ${sp.proposalId} + Version ${versionLabel(version)}; content SHA-256 ${check.contentHash}. Canonical Doc verified against ${versionLabel(version)}. Cycle: ${summary || "all items applied and resolved"}.`,
    summaryHeading: `✅ Approved: *${sp.proposalId} ${versionLabel(version)}*.`,
  });
  return { kind: "approved", approvedVersion: version };
}

/**
 * Martin's requested change to the current Version: always a new Version,
 * never an overwrite. The prior Version's content stays in state and in the
 * Proposal page body; the new Version is Pending Approval and not released to
 * artifact execution until Martin approves that exact Version.
 */
const PROPOSAL_DOCS_FOLDER_NAME = "ENIG Proposals (token-safe)";

/** The ENIG folder cache key `google_drive.ensure_folder` memoizes the Proposal-docs folder id under (the same key ensureGoogleFolder used). */
const PROPOSAL_DOCS_FOLDER_KV_KEY = "google_proposal_docs_folder";

/**
 * The `google_docs.update_and_verify` input for THIS Proposal's Doc. It
 * carries business data only -- the opaque document id, the trusted account,
 * the Proposal id and this Proposal's exact Version content in order -- and
 * the registered operation rebuilds the canonical layout itself, so no
 * provider request structure and no styling detail ever enters the contract.
 */
function docWriteInput(sp: RuntimeSalesProposal, documentId: string, accountIdentifier: string) {
  return {
    document_id: documentId,
    account_identifier: accountIdentifier,
    proposal_id: sp.proposalId,
    versions: sp.versions.filter((v) => v.version <= sp.currentVersion).sort((x, y) => x.version - y.version).map((v) => ({ version: v.version, content: v.content })),
  };
}

/**
 * Creates a Google Doc holding exactly the current version's token-safe
 * content, in a folder this system keeps for them, on Martin's tap of the
 * "Create Google Doc" button (that tap is the approval for this Doc). The
 * Doc is registered for comment watching, bound to this exact Proposal
 * version: a comment on it requests a change (applyProposalDocComment), it
 * never edits the Doc in place. Real-identity documents are built by
 * Isolated Sales from the approved version -- never here.
 */
type EnsureDocResult = { ok: true; url: string } | { ok: false; error: string };

/** The canonical Doc layout for the Proposal's current version: every version's content in order, last is current (see proposalRedline.ts). */
function currentDocLayout(sp: RuntimeSalesProposal) {
  return buildProposalDocLayout(
    sp.proposalId,
    sp.versions.filter((v) => v.version <= sp.currentVersion).sort((x, y) => x.version - y.version).map((v) => ({ version: v.version, content: v.content })),
  );
}

/**
 * Brings the Proposal's single Google Doc up to its current version: creates
 * it the first time (in the dedicated folder, watched and bound to this
 * Proposal), and on every later version rewrites the same Doc -- clean current
 * text on top, a redline of each revision below (proposalRedline.ts). Never
 * messages; callers report. Every Google step here -- the folder, the
 * creation, the update of an existing Doc and the canonical pass over a
 * just-created Doc -- is a registered external mutation invoked through the
 * shared Tool Registry (see src/runtime/toolRegistry.ts), never a direct
 * Google call: each carries the Work's own resolved Action's declaration,
 * Access's decision, durable intent/outcome records and the canonical five
 * outcomes. Fails closed with the reason when no single
 * authorized Google account exists or any Google step fails; a Doc that could
 * not be brought up to date is NOT offered as the current version (its watch
 * binding stays at the version it shows, so comments on it are refused as stale).
 */
async function ensureProposalDoc(env: Env, state: WorkState, sp: RuntimeSalesProposal): Promise<EnsureDocResult> {
  const version = sp.currentVersion;
  if (sp.doc && sp.doc.version === version) return { ok: true, url: sp.doc.url };
  const layout = currentDocLayout(sp);
  const binding = { workId: state.workId, proposalNumber: sp.proposalNumber, proposalId: sp.proposalId, version };

  if (sp.doc) {
    // Rewriting an EXISTING Doc to the current Version is a registered
    // external mutation (google_docs.update_and_verify): exact operation,
    // this Work's own resolved Action's declaration (see salesManifest),
    // Access's external-mutation decision, durable intent/outcome records,
    // and the canonical five outcomes -- never a direct Docs call.
    const outcome = await invokeTool(
      env,
      { tool_id: "google_docs", operation_id: "google_docs.update_and_verify", input: docWriteInput(sp, sp.doc.documentId, sp.doc.accountIdentifier) },
      workSessionContext(state),
    );
    if (outcome.state !== "succeeded" || !outcome.remote_resource?.document_id) {
      // Every non-success keeps its honest shape: `failed` names the stage,
      // `partially_completed`/`unverified` preserve the document id for
      // reconciliation before any retry, and `denied` made no request.
      return { ok: false, error: `the Doc is still at ${versionLabel(sp.doc.version)}: ${outcome.reason ?? outcome.state}` };
    }
    await registerWatchedGoogleDoc(env, {
      documentId: sp.doc.documentId,
      accountIdentifier: sp.doc.accountIdentifier,
      title: sp.proposalId,
      chatId: state.chatId,
      threadId: state.threadId,
      createdAt: new Date().toISOString(),
      proposal: binding,
    });
    sp.doc.version = version;
    return { ok: true, url: sp.doc.url };
  }

  const accounts = await listAuthorizedGoogleAccounts(env);
  if (accounts.length !== 1) {
    return {
      ok: false,
      error:
        accounts.length === 0
          ? "no Google account is authorized for the Runtime"
          : `${accounts.length} Google accounts are authorized and I won't guess which to use`,
    };
  }
  const accountIdentifier = accounts[0];
  // The folder the Doc is created into is itself an EXTERNAL effect and runs
  // through the same boundary (google_drive.ensure_folder): find-or-create
  // under the dedicated cache key, verified by an actual Drive read.
  const folderOutcome = await invokeTool(
    env,
    {
      tool_id: "google_drive",
      operation_id: "google_drive.ensure_folder",
      input: { account_identifier: accountIdentifier, folder_name: PROPOSAL_DOCS_FOLDER_NAME, kv_key: PROPOSAL_DOCS_FOLDER_KV_KEY },
    },
    workSessionContext(state),
  );
  if (folderOutcome.state !== "succeeded" || !folderOutcome.remote_resource?.document_id) {
    return { ok: false, error: folderOutcome.reason ?? `the Proposal-docs folder could not be ensured (${folderOutcome.state})` };
  }
  const folderId = folderOutcome.remote_resource.document_id;
  // The Doc's CREATION runs through the shared Tool Registry's invocation
  // boundary: exact registered operation (google_docs.create_and_verify),
  // the Work's own resolved Action's declaration (proposal_draft /
  // proposal_submit -- see salesManifest), Access's external-mutation
  // decision, exact input validation, the trusted account/folder target,
  // and the canonical five outcomes. Holding Google OAuth access was never
  // authorization, and the boundary is what supplies it now. `title` and
  // `content` are this Version's exact, token-safe layout text; nothing
  // identity-bearing ever enters this Doc (Isolated Sales owns that).
  const outcome = await invokeTool(
    env,
    {
      tool_id: "google_docs",
      operation_id: "google_docs.create_and_verify",
      input: { title: sp.proposalId, content: layout.text, folder_id: folderId, account_identifier: accountIdentifier },
    },
    workSessionContext(state),
  );
  if (outcome.state !== "succeeded" || !outcome.remote_resource?.document_id || !outcome.remote_resource.url) {
    // Every non-success keeps its honest shape: `failed` names the stage,
    // `partially_completed`/`unverified` preserve any remote id for
    // reconciliation before any retry (no blind re-creation), and `denied`
    // never made a request. Callers report; nothing here messages.
    return { ok: false, error: outcome.reason ?? `${outcome.state}: no detail` };
  }
  const documentId = outcome.remote_resource.document_id;
  const documentUrl = outcome.remote_resource.url;
  // The canonical styling pass always runs, including on a v1 Doc -- no
  // redline is required to trigger it: the title / section-heading / bullet
  // layout comes from the content's own structure, and the Doc must read
  // back exactly as written before it is offered. It is the registered
  // update operation (the same boundary as above), never a direct Docs call.
  const styled = await invokeTool(
    env,
    { tool_id: "google_docs", operation_id: "google_docs.update_and_verify", input: docWriteInput(sp, documentId, accountIdentifier) },
    workSessionContext(state),
  );
  if (styled.state !== "succeeded" || !styled.remote_resource?.document_id) {
    return { ok: false, error: styled.reason ?? `${styled.state}: no detail` };
  }
  await registerWatchedGoogleDoc(env, {
    documentId,
    accountIdentifier,
    title: sp.proposalId,
    chatId: state.chatId,
    threadId: state.threadId,
    createdAt: new Date().toISOString(),
    proposal: binding,
  });
  sp.doc = { documentId, url: documentUrl, accountIdentifier, version };
  return { ok: true, url: documentUrl };
}

/** Retry path: the "Create Google Doc" button, shown only while the Doc is missing or behind the current version (updating it at presentation failed). */
async function createProposalVersionDoc(env: Env, state: WorkState, sp: RuntimeSalesProposal, version: number): Promise<WorkState> {
  if (version !== sp.currentVersion) {
    return staleDecision(env, state, `${versionLabel(version)} is not the current Version of ${sp.proposalId} (current: ${versionLabel(sp.currentVersion)}).`);
  }
  const say = (text: string) => sendWorkspaceHatMessage(env, { ...state, hat: HAT }, text);
  const had = !!sp.doc && sp.doc.version === version;
  const doc = await ensureProposalDoc(env, state, sp);
  if (!doc.ok) {
    await say(`Couldn't ${sp.doc ? "update" : "create"} the Google Doc: ${doc.error}. Nothing was changed.`);
    return state;
  }
  await say(
    had
      ? `The Google Doc for ${sp.proposalId} ${versionLabel(version)} already exists: ${doc.url}`
      : `📄 *Google Doc for ${sp.proposalId} ${versionLabel(version)}:* ${doc.url}\n\nSelect text and comment to request a change. A comment doesn't edit this Doc -- it creates the next version (${versionLabel(version + 1)}) and this same Doc is updated, with the changes struck through and added.`,
  );
  return state;
}

export type ProposalDocCommentResult =
  | { kind: "revised"; newVersion: number }
  | { kind: "stale"; detail: string }
  | { kind: "refused"; detail: string };

/**
 * A comment on a Proposal Doc is Martin's change request for that exact
 * version. It runs the SAME revision path as "Request changes" -- the change
 * recorded verbatim in a new Version that needs a new approval -- so the Doc
 * is never edited in place, v(N) is kept as it is, and the hashed Proposal
 * Content stays the source of truth. Refused (nothing created) when the Doc's
 * version is no longer the current one, or the Work is not Sales'.
 */
export async function applyProposalDocComment(
  env: Env,
  state: WorkState,
  input: { proposalNumber: number; version: number; text: string; commentId?: string; documentId?: string },
): Promise<{ state: WorkState; result: ProposalDocCommentResult }> {
  const sp = state.sales?.proposal;
  if (!sp || sp.proposalNumber !== input.proposalNumber) {
    return { state, result: { kind: "stale", detail: "this Doc does not belong to the Proposal on this work item." } };
  }
  if (state.unit !== "Sales") {
    return { state, result: { kind: "refused", detail: `this work item now belongs to ${state.unit ?? "another Unit"}, so it can't revise the Proposal.` } };
  }
  if (input.version !== sp.currentVersion) {
    return {
      state,
      result: { kind: "stale", detail: `this Doc is a copy of ${versionLabel(input.version)}, but ${sp.proposalId} is now at ${versionLabel(sp.currentVersion)}. Comment on the current version's Doc.` },
    };
  }
  state.blockedReason = undefined;

  // IMMEDIATE REOPEN, before any revision is applied: the moment this comment
  // is treated as substantive, the Proposal leaves Approved and the Approved
  // Version binding is cleared on the live record. So even if the change then
  // fails to apply, nothing stale stays releasable -- this is the invariant
  // "a substantive comment reopens the approval cycle before any revised
  // Version can be released", and it is why the reopen is not folded into the
  // revision's own Pending write (which happens only if the change succeeds).
  let cycleItemRegistered = false;
  if (input.commentId && input.documentId) {
    const reopened = await reopenProposalApprovalCycle(env, state, sp, {
      documentId: input.documentId,
      commentId: input.commentId,
      commentedVersion: input.version,
      requestedChange: input.text,
    });
    if (!reopened.ok) {
      return { state, result: { kind: "refused", detail: `this comment could not join the Proposal's approval cycle (${reopened.reason}); the change was not applied.` } };
    }
    cycleItemRegistered = true;
  }

  salesOf(state).pendingProposalRevision = { proposalNumber: sp.proposalNumber, fromVersion: input.version };
  await handleSalesProposalRevisionText(env, state, input.text);
  const after = state.sales?.proposal!;
  if (after.currentVersion === input.version + 1) {
    if (cycleItemRegistered && input.commentId) {
      // A new Version exists, but the cycle item is only `applied` once the
      // canonical Doc was brought to that Version AND verified to match it.
      // If the Doc update failed, the item stays unapplied and the cycle
      // cannot complete, so the Proposal stays out of Approved.
      const docCheck = await verifyProposalDocShowsVersion(env, after);
      if (docCheck.ok) {
        recordProposalCycleItemOutcome(state, input.commentId, "applied", after.currentVersion);
      } else {
        console.warn(`Proposal cycle item ${input.commentId} on ${after.proposalId}: new Version ${versionLabel(after.currentVersion)} exists but the Doc did not verify (${docCheck.reason}); item left unapplied.`);
      }
    }
    return { state, result: { kind: "revised", newVersion: after.currentVersion } };
  }
  if (cycleItemRegistered && input.commentId) recordProposalCycleItemOutcome(state, input.commentId, "refused");
  salesOf(state).pendingProposalRevision = undefined;
  return { state, result: { kind: "refused", detail: state.blockedReason ?? "the change was not applied." } };
}

export type ProposalDocFormattingResult =
  | { kind: "formatted" }
  | { kind: "stale"; detail: string }
  | { kind: "refused"; detail: string };

/**
 * Applies the canonical Proposal layout styling to the Proposal's existing
 * Doc, in full, without changing one character of its text and without
 * touching anything governance holds: no new Version, no amendment, no
 * content hash, no Approval Status / Approved Version change, no Work Action
 * (a presentation-only request is not a Proposal event). Runs the SAME
 * binding guards as applyProposalDocComment -- the Doc belongs to this
 * Proposal, the Work is still Sales', the Doc's version is still the current
 * one -- and refuses (nothing applied) when the Doc's text no longer matches
 * the version it is bound to.
 *
 * The styling itself is a REGISTERED external mutation
 * (google_docs.format_and_verify, invoked through src/runtime/toolRegistry.ts)
 * rather than a direct Docs call: it carries this Work's own resolved Action's
 * declaration, Access's external-mutation decision -- including bound
 * approval evidence when that Action is approval-gated, which is why a
 * formatting request arriving under `proposal_approve` is refused rather than
 * applied -- durable intent/outcome records, and the canonical five outcomes.
 */
export async function applyProposalDocFormatting(
  env: Env,
  state: WorkState,
  input: { proposalNumber: number; version: number },
): Promise<{ state: WorkState; result: ProposalDocFormattingResult }> {
  const sp = state.sales?.proposal;
  if (!sp || sp.proposalNumber !== input.proposalNumber) {
    return { state, result: { kind: "stale", detail: "this Doc does not belong to the Proposal on this work item." } };
  }
  if (state.unit !== "Sales") {
    return { state, result: { kind: "refused", detail: `this work item now belongs to ${state.unit ?? "another Unit"}, so it can't format the Proposal Doc.` } };
  }
  if (!sp.doc) {
    return { state, result: { kind: "refused", detail: `no Google Doc exists yet for ${sp.proposalId}; use the "Create Google Doc" button first.` } };
  }
  if (input.version !== sp.currentVersion || sp.doc.version !== input.version) {
    return {
      state,
      result: { kind: "stale", detail: `this Doc is a copy of ${versionLabel(input.version)}, but ${sp.proposalId} is now at ${versionLabel(sp.currentVersion)}. Comment on the current version's Doc.` },
    };
  }
  const outcome = await invokeTool(
    env,
    { tool_id: "google_docs", operation_id: "google_docs.format_and_verify", input: docWriteInput(sp, sp.doc.documentId, sp.doc.accountIdentifier) },
    workSessionContext(state),
  );
  if (outcome.state === "succeeded") return { state, result: { kind: "formatted" } };
  // Every non-success keeps its honest shape: `denied` (no declaration on the
  // Work's Action, or missing bound approval evidence) made no request,
  // `failed` names the stage -- including `baseline`, where the operation's
  // own drift gate refused before anything was applied, so the Doc's text is
  // left exactly as it is -- and `partially_completed`/`unverified` preserve
  // the document id for reconciliation before any retry.
  return { state, result: { kind: "refused", detail: outcome.reason ?? `${outcome.state}: no detail` } };
}

/** The outcome of ONE automated Doc-thread reply: actually delivered, or refused with the gate's honest reason. */
export type ProposalDocCommentReplyResult = { sent: true } | { sent: false; detail: string };

/**
 * Posts ONE automated reply to a comment on this Proposal's Doc -- the
 * governed form of the Doc-thread replies googleDocComments.ts used to issue
 * as direct Drive calls. Martin's Access-context decision (2026-10-15)
 * authorized exactly this: a cron-driven Google reply runs ONLY through the
 * registered external-mutation gate (`google_drive.reply_to_comment`,
 * invoked here under this Work's own resolved Action), never as a direct
 * Google call. Everything the boundary supplies therefore applies: the
 * Work's Action must DECLARE the operation (denied otherwise), an
 * approval-gated Action demands bound approval evidence (a comment arriving
 * under `proposal_approve` is refused, exactly like the formatting path), the
 * trusted target must be a watched file under its own authorized account,
 * durable intent/outcome records apply, and an uncertain reply is never
 * repeated (the operation declares no reconciliation step).
 *
 * Deliberately does NOT judge WHY a reply may or may not go out beyond what
 * the boundary reports: the caller (the comment poller) keeps the comment's
 * own marker-before-reply, deduplication and failure-reporting contract, and
 * a non-success here is reported to Operations and never retried. No state
 * of this Work is changed by a reply.
 */
export async function sendProposalDocCommentReply(
  env: Env,
  state: WorkState,
  input: { documentId: string; commentId: string; content: string; accountIdentifier: string },
): Promise<{ state: WorkState; result: ProposalDocCommentReplyResult }> {
  const outcome = await invokeTool(
    env,
    {
      tool_id: "google_drive",
      operation_id: "google_drive.reply_to_comment",
      input: { file_id: input.documentId, comment_id: input.commentId, content: input.content, account_identifier: input.accountIdentifier },
    },
    workSessionContext(state),
  );
  if (outcome.state === "succeeded") return { state, result: { sent: true } };
  // Every non-success keeps its honest shape: `denied` (no declaration on
  // the Work's Action, missing bound approval evidence, or an unresolvable
  // target) made no request; `failed` names the stage; and
  // `partially_completed`/`unverified` mark a reply that may exist and must
  // never be repeated.
  return { state, result: { sent: false, detail: outcome.reason ?? `${outcome.state}: no detail` } };
}

/**
 * `retryable: false` marks a refusal that can never succeed for this comment
 * (its Doc, Proposal or Version no longer matches the Work), so the poller
 * closes the comment off honestly instead of re-classifying it forever;
 * `retryable: true` is a transient ordering (another clarification is already
 * outstanding) that a later poll may legitimately retry.
 */
export type ProposalDocClarificationResult = { ok: true } | { ok: false; detail: string; retryable: boolean };

/**
 * Records that a Proposal Doc comment could not be classified and that the
 * Work is now WAITING for Martin's clarification of that exact comment
 * (`state.awaiting` + `pendingProposalDocClarification`, the same continuation
 * mechanism every other multi-turn Work flow uses -- resumed by his ordinary
 * Telegram reply through the Hat's declared awaitingHandlers).
 *
 * Deliberately records the request instead of settling it: neither the
 * formatting path nor the revision path may run on an ambiguous, mixed,
 * malformed or failed classification, and the comment must stay recoverable
 * rather than be marked processed and lost. The bindings carried here (Work,
 * comment, document, Proposal, version, text) are what the resume revalidates,
 * so a clarification can only ever continue the SAME request.
 */
export async function requestProposalDocClarification(
  env: Env,
  state: WorkState,
  input: { proposalNumber: number; version: number; commentId: string; documentId: string; text: string },
): Promise<{ state: WorkState; result: ProposalDocClarificationResult }> {
  const sp = state.sales?.proposal;
  if (!sp || sp.proposalNumber !== input.proposalNumber) {
    return { state, result: { ok: false, detail: "this Doc does not belong to the Proposal on this work item.", retryable: false } };
  }
  if (state.unit !== "Sales") {
    return { state, result: { ok: false, detail: `this work item now belongs to ${state.unit ?? "another Unit"}, so it can't hold a clarification for the Proposal Doc.`, retryable: false } };
  }
  if (!sp.doc || sp.doc.documentId !== input.documentId) {
    return { state, result: { ok: false, detail: "this comment is not on the Doc this Proposal is currently bound to, so no clarification was recorded.", retryable: false } };
  }
  if (input.version !== sp.currentVersion || sp.doc.version !== input.version) {
    return {
      state,
      result: { ok: false, detail: `${versionLabel(input.version)} is no longer the current Version of ${sp.proposalId}, so no clarification was recorded.`, retryable: false },
    };
  }
  if (state.sales?.pendingProposalDocClarification && state.sales?.pendingProposalDocClarification.commentId !== input.commentId) {
    // One outstanding clarification per Work: a second ambiguous comment is
    // answered rather than silently replacing the request Martin is already
    // being asked about.
    return {
      state,
      result: { ok: false, detail: `a clarification is already outstanding for another comment on ${sp.proposalId} ${versionLabel(input.version)}; resolve that one first.`, retryable: true },
    };
  }
  salesOf(state).pendingProposalDocClarification = {
    commentId: input.commentId,
    documentId: input.documentId,
    proposalNumber: input.proposalNumber,
    version: input.version,
    text: input.text,
  };
  state.stage = "awaiting_proposal_doc_clarification";
  state.awaiting = "proposal_doc_clarification";
  // Telegram is the route that can actually be answered (a reply on the Doc
  // thread is write-only for this Worker -- Drive comment replies are never
  // read back), so Martin is asked here, on the governed continuation
  // channel, and his reply resumes this exact request.
  await sendWorkspaceHatMessage(
    env,
    { ...state, hat: HAT },
    `A comment on ${sp.proposalId} ${versionLabel(input.version)}'s Doc is unclear, so nothing has been changed:\n"${input.text.slice(0, MAX_COMMENT_CHARS_FOR_CHAT)}"\n\nReply here: say "formatting only" if it is just about presentation, or describe the text change and I'll record it as a new Version for your approval.`,
  );
  return { state, result: { ok: true } };
}

/**
 * Martin's Telegram reply to a Doc-comment clarification. Re-classifies the
 * SAME comment with his clarification appended -- classification stays a
 * routing signal only, still failing closed to ambiguous -- and then routes
 * it exactly once: formatting goes to the registered, governed
 * google_docs.format_and_verify operation (applyProposalDocFormatting), a
 * text change goes to the ordinary Request-changes revision path
 * (applyProposalDocComment). Nothing else may run from here: no approval, no
 * Version, no Doc text is touched by the clarification itself.
 *
 * The comment is marked processed immediately BEFORE that routed handler
 * runs -- the same contract the poller uses -- so an interruption or a second
 * reply can never apply the same comment twice; if the routed handler then
 * fails it says so, exactly as the poller's own failure path does.
 */
export async function handleProposalDocClarificationText(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const sp = state.sales?.proposal;
  const pending = state.sales?.pendingProposalDocClarification;

  // A processed-marker that cannot be persisted (today: the per-day KV
  // write quota) settles NOTHING. Both marker writes below run BEFORE any
  // state change or routed handler, so a typed failure leaves the
  // continuation exactly as it was -- still awaiting, still carrying the
  // same comment -- and Martin is told the truth (a storage failure, not a
  // success and not a generic "execution failed" alert). His next reply,
  // or the next poll of the comment itself, retries it.
  const persistenceRefusal = async (commentId: string, err: unknown): Promise<WorkState> => {
    console.error(`handleProposalDocClarificationText: could not persist the processed-marker for comment ${commentId}`, err);
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT },
      `Storage write failure: I could not record that comment ${commentId} is handled, so NOTHING was changed and your clarification is still outstanding. Send it again once this clears and I will complete it then.`,
    ).catch((notifyErr) => console.error("handleProposalDocClarificationText: could not send the persistence-failure notice", notifyErr));
    return state;
  };

  // The clarification only ever continues the SAME comment. When the Work or
  // the Proposal moved on, it is answered honestly, the comment is closed off
  // so it is not re-asked on every future poll, and nothing is mutated. The
  // marker is written FIRST (the same order the resolved path uses), so a
  // failed write leaves the stale continuation waiting rather than half-closed.
  const closeStale = async (detail: string): Promise<WorkState> => {
    const commentId = pending?.commentId;
    if (commentId) {
      try {
        await markProposalDocCommentProcessed(env, commentId);
      } catch (err) {
        if (err instanceof CommentMarkerPersistenceError) return persistenceRefusal(commentId, err);
        throw err;
      }
    }
    salesOf(state).pendingProposalDocClarification = undefined;
    state.awaiting = undefined;
    return staleDecision(env, state, detail);
  };
  if (!sp || !pending || pending.proposalNumber !== sp.proposalNumber) {
    return closeStale("that Doc-comment clarification no longer matches a Proposal on this work item, so nothing was changed.");
  }
  if (pending.version !== sp.currentVersion) {
    return closeStale(`that comment was on ${versionLabel(pending.version)}, and ${sp.proposalId} is now at ${versionLabel(sp.currentVersion)}; it was not applied. Comment on the current Version's Doc if the request still stands.`);
  }
  if (!sp.doc || sp.doc.documentId !== pending.documentId) {
    return closeStale(`the Doc that comment was left on is no longer ${sp.proposalId}'s Doc, so nothing was changed.`);
  }

  const clarification = text.trim();
  if (!clarification) {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT },
      `What should I do with that comment on ${sp.proposalId} ${versionLabel(pending.version)} -- treat it as formatting only, or as a change to the Proposal's content? Nothing has been changed.`,
    );
    return state;
  }

  const intent = await classifyProposalCommentIntent(env, `${pending.text}\n\nClarification from Martin: ${clarification}`);
  if (intent === "ambiguous") {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT },
      `Still unclear, so I have changed nothing. Say "formatting only" if the comment is just about presentation, or describe the text change and I'll record it as a new Version for your approval.`,
    );
    return state;
  }

  // The ambiguity is resolved: close the comment out BEFORE the routed
  // handler runs, so a duplicate poll or a second reply can never apply it
  // twice -- the same contract the poller applies to an unambiguous comment.
  // If that marker cannot be persisted, nothing is settled and nothing is
  // routed: the Work keeps waiting and Martin is told the truth.
  try {
    await markProposalDocCommentProcessed(env, pending.commentId);
  } catch (err) {
    if (err instanceof CommentMarkerPersistenceError) return persistenceRefusal(pending.commentId, err);
    throw err;
  }
  salesOf(state).pendingProposalDocClarification = undefined;
  state.awaiting = undefined;
  state.stage = "proposal_doc_clarification_resolved";

  if (intent === "formatting") {
    const applied = await applyProposalDocFormatting(env, state, { proposalNumber: pending.proposalNumber, version: pending.version });
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT },
      applied.result.kind === "formatted"
        ? `Done: ${sp.proposalId} ${versionLabel(pending.version)}'s Doc was restyled to the canonical layout. Its text is unchanged and no new Version was created.`
        : `Not applied -- ${applied.result.detail}`,
    );
    return applied.state;
  }

  const revised = await applyProposalDocComment(env, state, {
    proposalNumber: pending.proposalNumber,
    version: pending.version,
    text: pending.text,
    commentId: pending.commentId,
    documentId: pending.documentId,
  });
  if (revised.result.kind === "revised") {
    await sendWorkspaceHatMessage(
      env,
      { ...state, hat: HAT },
      `Change recorded -- ${sp.proposalId} ${versionLabel(revised.result.newVersion)} was created from that comment and sent to you for approval. ${versionLabel(pending.version)} is unchanged.`,
    );
    return revised.state;
  }
  await sendWorkspaceHatMessage(env, { ...state, hat: HAT }, `Not applied -- ${revised.result.detail}`);
  return revised.state;
}

export async function handleSalesProposalRevisionText(env: Env, state: WorkState, text: string): Promise<WorkState> {
  const sp = state.sales?.proposal;
  const pending = state.sales?.pendingProposalRevision;
  if (!sp || !pending || pending.proposalNumber !== sp.proposalNumber || pending.fromVersion !== sp.currentVersion) {
    salesOf(state).pendingProposalRevision = undefined;
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

  const live = await getPage(env, sp.pageId, workSessionContext(state));
  const liveState = await proposalFromRecord(live, sp);
  if ("error" in liveState) return failClosed(env, state, liveState.error);
  if (liveState.currentVersion !== sp.currentVersion) {
    return staleDecision(env, state, `the Proposal record is now at ${versionLabel(liveState.currentVersion)}; change to ${versionLabel(sp.currentVersion)} not applied.`);
  }

  const released = sp.artifactStatus !== "Not Requested";
  const artifactStatus: ProposalArtifactStatus = released ? "Held" : "Not Requested";
  const contentHash = await hashContent(content);

  // A revision is a new Version, never an edit of the approved one. The
  // Work's Action advances to proposal_revision for exactly these writes, and
  // needs no proof: Martin did not approve this content -- he asked for it to
  // change. The point of the separate Action is what happens next: the
  // revision is written Pending Approval, the Work advances to
  // proposal_submit, and only a NEW approval of THIS Version can approve it.
  // The prior approval is explicitly cleared below, so it cannot carry over.
  recordWorkAction(state, PROPOSAL_REVISION_ACTION);
  const revisionAccess = workSessionContext(state, undefined, PROPOSAL_REVISION_ACTION);

  const versionPage = await createVersionPage(env, sp.pageId, `${sp.proposalId} ${versionLabel(newVersion)}`, content, revisionAccess);
  await updatePage(
    env,
    sp.pageId,
    {
      "Proposal Content": richTextLong(content),
      "Current Version Link": url(versionPage.url),
      "Approved Version Link": { url: null },
      Version: richText(versionLabel(newVersion)),
      "Approval Status": select("Pending Approval"),
      "Approved Version": { rich_text: [] },
      "Artifact Status": select(artifactStatus),
    },
    revisionAccess,
  );

  const previousApproved = sp.approvedVersion;
  sp.versions.push({ version: newVersion, content, contentHash, createdAt: new Date().toISOString(), origin: "revision", pageUrl: versionPage.url });
  sp.amendments = amendments;
  sp.currentVersion = newVersion;
  sp.approvalStatus = "Pending Approval";
  sp.approvedVersion = undefined;
  sp.artifactStatus = artifactStatus;
  salesOf(state).pendingProposalRevision = undefined;

  // The revised Version is about to be presented for approval, so the Work's
  // Action advances to proposal_submit -- the same transition the original
  // draft went through. presentForApproval then sends Martin the new Version,
  // and any approval of it is judged against proposal_approve.
  recordWorkAction(state, PROPOSAL_SUBMIT_ACTION);

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
