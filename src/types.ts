import type { InlineButton } from "./telegram";
import type { HandoffSourceBoundaryAttestation, KnownIdentityField } from "./handoffWriter";

export interface Env {
  AI: Ai;
  WORK_SESSION: DurableObjectNamespace;
  STATE_KV: KVNamespace;

  NOTION_VERSION: string;
  AI_MODEL_PRIMARY: string;
  AI_MODEL_LIGHT: string;
  ENTITY_DATA_SOURCE_ID: string;
  MATTERS_DATA_SOURCE_ID: string;
  PROPOSALS_DATA_SOURCE_ID: string;
  HANDOFFS_DATA_SOURCE_ID: string;
  ACTIVITY_LOG_DATA_SOURCE_ID: string;
  /**
   * The Leads database -- the pre-Entity acquisition/prospecting record
   * Lead Discovery writes to. A Lead is created here on discovery alone;
   * an Entity is only created/matched once a response or expression of
   * interest demonstrates real engagement (see the canonical Lead
   * Business Object page). Distinct data source from ENTITY_DATA_SOURCE_ID.
   */
  LEADS_DATA_SOURCE_ID: string;
  /**
   * The Call Notes database -- the canonical governed object holding the
   * de-identified record of a completed call. Isolated Sales is its creation
   * authority and writes it outside this Worker; Runtime Sales only retrieves
   * and consumes Call Notes and never creates one. Distinct data source from
   * HANDOFFS_DATA_SOURCE_ID: call evidence is not a Handoff.
   *
   * Bound here as a symbolic Env field rather than hardcoded anywhere in
   * application logic, exactly like every other data source above.
   */
  CALL_NOTES_DATA_SOURCE_ID: string;

  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /**
   * The shared key every /admin/* diagnostic/operational endpoint checks
   * (index.ts, googleOAuth.ts's handleGoogleDriveTest) via a ?key= query
   * param. Previously these endpoints reused TELEGRAM_WEBHOOK_SECRET --
   * conflating an inbound webhook-signature secret with admin-API auth,
   * two different concerns. WORKER_ADMIN_KEY already existed live,
   * unused, before this; it's now the one this whole surface actually
   * checks. Unset means every /admin/* endpoint fails closed (403).
   */
  WORKER_ADMIN_KEY?: string;
  MARTIN_TELEGRAM_USER_ID: string;
  NOTION_TOKEN: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;

  /**
   * JSON object mapping Unit name -> Telegram forum topic message_thread_id,
   * e.g. {"Sales": 2, "Finance": 4}. Optional — when unset, the bot behaves
   * as a plain 1:1 chat with no topic awareness (legacy/DM mode).
   */
  UNIT_TOPIC_MAP?: string;

  /** The ENIG HQ Supergroup's chat id (negative number). Required for two-stream architecture. */
  TELEGRAM_GROUP_CHAT_ID?: string;

  /** The Workspace stream topic message_thread_id in ENIG HQ Supergroup. */
  WORKSPACE_TOPIC_ID?: string;

  /** The Operations stream topic message_thread_id in ENIG HQ Supergroup. */
  OPERATIONS_TOPIC_ID?: string;

  /** Shared secret for the Gmail-polling Apps Script -> /email/webhook. */
  EMAIL_WEBHOOK_SECRET?: string;

  /**
   * The Notion webhook subscription's verification token, used as the HMAC
   * key for validating the X-Notion-Signature header on every event
   * delivery to /notion/webhook (see notionWebhook.ts). Notion issues this
   * token during the one-time verification handshake when the subscription
   * is first created in the Notion integration dashboard -- it must be
   * copied from there into this secret (`wrangler secret put
   * NOTION_WEBHOOK_SECRET`) by hand; nothing in this codebase creates,
   * registers, or modifies the actual Notion subscription. Unset means the
   * webhook endpoint fails closed (rejects every event) rather than
   * accepting unverified deliveries.
   */
  NOTION_WEBHOOK_SECRET?: string;

  /**
   * Tavily search API key -- the trusted runtime configuration for the
   * ONE enabled provider behind the shared search Tool
   * (src/runtime/research/webSearch.ts; canonical specification: ENIG HQ /
   * 6. Tools > Search). Optional -- unset means every search invocation
   * reports `provider_unavailable` (research stays closed-book over
   * supplied context; lead discovery reports the unavailability honestly)
   * rather than failing or silently returning empty results; never a
   * required secret for the rest of the runtime. Provider selection is
   * code-level trusted configuration: no caller, Hat, or Skill can choose
   * a provider or supply credentials.
   */
  TAVILY_API_KEY?: string;

  /**
   * Free-tier AI provider fallback keys (src/ai/openaiCompatible.ts),
   * all optional -- added after Cloudflare Workers AI's daily quota
   * exhaustion blocked every AI-driven Hat/Unit at once. Each is a no-op
   * in the provider fallback chain unless its own key is set; none
   * widens what's allowed at client_confidential (see dataBoundary/
   * policy.ts) -- they're fallback for the same business_sensitive-and-
   * below tier Workers AI already serves.
   */
  NVIDIA_NIM_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Cerebras Cloud -- same fallback tier as the other OpenAI-compatible providers above. */
  CEREBRAS_API_KEY?: string;
  /** Google AI Studio (Gemini) -- same fallback tier as the other OpenAI-compatible providers above. */
  GEMINI_API_KEY?: string;
  /** SambaNova Cloud -- same fallback tier as the other OpenAI-compatible providers above. */
  SAMBANOVA_API_KEY?: string;

  /**
   * Turso fallback database for the KV-primary/Turso-secondary
   * coordination-state store (src/kvStore.ts, Section 5B). Optional: unset
   * means every kvStore operation is an exact passthrough to STATE_KV.
   * TURSO_AUTH_TOKEN is a Cloudflare Secret (never committed, see
   * wrangler.toml's secrets comment block).
   */
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
}

export type Unit =
  | "Sales"
  | "Marketing"
  | "Business Development"
  | "Finance"
  | "Strategy"
  | "Creative & Design"
  | "Operations";

export type QualificationAssessment = "Satisfied" | "Not Satisfied" | "Insufficient Evidence";

export interface QualificationConditionResult {
  condition:
    | "within_specialization"
    | "allows_diagnosis_first"
    | "commercial_value_evidence"
    | "open_to_ballpark_amount_and_time"
    | "ready_to_commit_required_resources";
  evidence: string;
  assessment: QualificationAssessment;
}

/**
 * Distinguishes how a commercial number was arrived at, per the Commercial
 * Value & Pricing Operating Model's Section 3 (Value-at-Stake Assessment).
 * An assumption is never equivalent to measured or client-estimated
 * evidence -- callers must not treat it as satisfying an evidence
 * requirement on its own.
 */
export type EvidenceType = "directly_measured" | "client_estimated" | "derived" | "assumption";

/**
 * A single commercial-value figure, expressed as a range where precision
 * isn't warranted (per the model's "a value-at-stake range is preferable
 * to false precision"). Used for both value-at-stake and cost-of-inaction
 * figures -- same shape, same evidentiary discipline.
 */
export interface ValueAtStake {
  /** A single point figure, when the evidence supports one rather than a range. */
  value?: number;
  low?: number;
  high?: number;
  currency?: string;
  /** The period this figure applies over, e.g. "annual", "6-12 months". */
  period?: string;
  evidenceType?: EvidenceType;
  /** Who/what this figure is attributable to, e.g. "client-stated (Comfort, call 2026-09-20)". */
  source?: string;
  evidenceQuality?: string;
  assumptions?: string;
  limitations?: string;
}

/**
 * Structured commercial-value evidence captured during Sales discovery, per
 * the Commercial Value & Pricing Operating Model. This is the pricing
 * basis Finance judges against -- investment tolerance is deliberately
 * NOT part of this structure (see WorkState.investmentToleranceContext).
 */
export interface CommercialEvidence {
  /** What the problem is costing, or could cost if unresolved -- free text, may be qualitative. */
  financialConsequence?: string;
  valueAtStake?: ValueAtStake;
  costOfInaction?: ValueAtStake;
  /** The specific revenue stream or opportunity the problem/value connects to. */
  affectedRevenueOrOpportunity?: string;
  desiredMeasurableOutcome?: string;
  /** Any material uncertainty about the evidence as a whole, beyond what's captured per-figure. */
  uncertainty?: string;
}

/**
 * A client's stated investment range or boundary -- per the Commercial
 * Value & Pricing Operating Model Section 7, this is a scope/fit sanity
 * check only. It is NEVER part of CommercialEvidence and must never be
 * used, by Sales or Finance, as the pricing basis or as a substitute for
 * value-at-stake evidence. Carried through the Handoff as context only.
 */
export interface InvestmentToleranceContext {
  low?: number;
  high?: number;
  currency?: string;
  period?: string;
}

/**
 * The commercial baseline preserved once an intervention is approved, per
 * the Commercial Value & Pricing Operating Model Section 8 (Measurement
 * Baseline) -- so the same evidence used to justify the intervention can
 * later support measurement without re-litigating attribution.
 */
export interface MeasurementBaseline {
  baselineMetric?: string;
  baselineValue?: string;
  baselinePeriod?: string;
  source?: string;
  evidenceQuality?: string;
  targetOutcome?: string;
  measurementPeriod?: string;
  assumptions?: string;
  limitations?: string;
}

export interface QualificationResult {
  conditions: QualificationConditionResult[];
  overall: "Qualified" | "Not Qualified" | "More Information Required";
}

export interface Quote {
  price: number;
  /**
   * The currency Finance's own judgment quoted the price in (e.g. "GHS",
   * "USD") -- read verbatim from the AI's structured judgement, never
   * assumed or hardcoded. Optional only for backward compatibility with a
   * quote parsed from a legacy "$<amount>"-formatted Handoff record that
   * predates currency being carried explicitly.
   */
  currency?: string;
  rationale: string;
}

export interface PendingApproval {
  kind:
    | "entity_match"
    | "matter_match"
    | "lead_to_prospect"
    | "proposal_draft"
    | "revision_feedback";
  summary: string;
  payload?: unknown;
}

/**
 * The explicit, typed evidence that Martin personally approved one specific
 * governed mutation of one specific Work item (ENIG Operating Model,
 * ACCESS; see src/access.ts, which is the only thing that verifies one).
 *
 * WHY THIS EXISTS, AND WHAT IT REPLACES: approval used to be reachable as
 * ambient mutable state on the WorkSession -- a flag that any later code
 * anywhere in the same session could read, so "was this approved?" was a
 * question about session-wide mood rather than about the mutation actually
 * about to happen. An ApprovalProof is the opposite: a value minted at the
 * single moment a *verified* approval callback consumes its staged
 * approval, and passed explicitly down the call stack to the one governed
 * mutation it authorizes. It is never stored on WorkState, never read back
 * out of ambient state, and cannot outlive the call it was threaded
 * through.
 *
 * The five fields are the whole authorization claim, and all five are
 * checked by src/access.ts against the resolved Action and the resolved
 * mutation target:
 *   - workId -- the exact Work item Martin approved. A proof for one Work
 *     never authorizes another.
 *   - actionName -- the exact resolved Action the approval was for.
 *   - targetDataSourceId -- the exact governed source the approval covers.
 *     This is what makes "an approval for HANDOFFS must never authorize an
 *     update to MATTERS/ENTITIES/PROPOSALS" mechanically true rather than
 *     a convention.
 *   - approvalToken -- an unguessable value generated at mint time, checked
 *     for presence and shape by src/access.ts. It is NOT the replay barrier
 *     and must not be described as one: the real replay protection is that
 *     the staged approval is consumed as the proof is minted, so a replayed
 *     Telegram callback finds nothing left to consume and never reaches
 *     minting at all. The token is the proof's own identity for the audit
 *     trail, not a nonce checked against a consumed-value store.
 *   - approvedAt -- when Martin actually approved, for the audit trail.
 */
export interface ApprovalProof {
  workId: string;
  actionName: string;
  targetDataSourceId: string;
  approvalToken: string;
  approvedAt: string;
  /**
   * The exact external Tool Operation this proof authorizes -- present
   * exactly when it authorizes an EXTERNAL Tool mutation rather than a
   * Notion write, in which case `targetDataSourceId` is the
   * `EXTERNAL_TOOL_TARGET` marker (src/access.ts) and the external resource
   * is bound here instead.
   *
   * The binding exists because a Notion data-source id must never stand in
   * for an external target: a Notion-bound proof (no `toolOperation`) can
   * therefore never authorize a Tool mutation, and a Tool-bound proof can
   * never satisfy a Notion write, whose check still compares
   * `targetDataSourceId` against the real governed source. Every field is
   * compared by verifyExternalToolProof (src/access.ts); a proof either
   * wholly authorizes this exact operation on this exact resource or it
   * authorizes nothing.
   */
  toolOperation?: {
    toolId: string;
    operationId: string;
    targetResourceId: string;
  };
}

/**
 * THE durable record of one external Tool operation this Work has initiated
 * (ENIG Operating Model: Work owns the persisted execution state; Tool
 * Registry durable-recovery contract, src/runtime/toolRegistry.ts).
 *
 * Why a record instead of an argument: `ToolInvocationRequest.prior_outcome`
 * is a function argument -- it survives a retry within one call chain, but a
 * process interruption between the remote provider accepting a mutation and
 * ENIG persisting its result destroys it. This record closes that window: it
 * is written to the Work's own Durable Object storage (WorkState below, one
 * WorkSession per Work) BEFORE the first protected external effect, and
 * updated with the verified outcome -- or the honest failure/uncertainty
 * state -- immediately after. On resumption the invocation boundary reads it
 * back and reconciles an uncertain operation before anything may run again.
 *
 * `status: "in_progress"` means exactly "the intent is durable; no outcome
 * has been" -- the interruption window itself. It is never a success, never
 * a failure, and never a licence to retry: the boundary reconciles it
 * against the provider first.
 *
 * The record never carries the operation input, document content, OAuth
 * tokens or any credential -- only operation identity, the trusted target,
 * the outcome and the remote resource id needed for reconciliation.
 */
export interface ExternalToolOperationRecord {
  /** The Work that owns this operation -- always the WorkState it is stored on. */
  work_id: string;
  tool_id: string;
  operation_id: string;
  /** The operation contract version this attempt ran under; a mismatch on resumption fails closed. */
  version: string;
  /** The trusted resolved target the attempt was authorized against (src/runtime/toolRegistry.ts resolveTarget). */
  target_resource_id: string;
  /** `in_progress` (intent persisted, outcome not yet) or one of the canonical terminal outcome states. */
  status: "in_progress" | import("./runtime/toolRegistry").ToolOutcomeState;
  /** The persisted outcome, present exactly when `status` is terminal. */
  outcome?: import("./runtime/toolRegistry").ToolInvocationOutcome;
  /** The remote resource, when one is known -- carried so a later attempt reconciles instead of duplicating. */
  remote_resource?: { document_id?: string; url?: string };
  /** When this record was last written. */
  updatedAt: string;
}

export interface WorkState {
  workId: string;
  chatId: number;
  threadId?: number;
  unit?: Unit;
  hat?: string;
  /**
   * The authoritative resolved Action this Work item is an instance of --
   * the runtime operation the Worker is currently performing (ENIG
   * Operating Model: Work is the concrete instance of an Action being
   * performed; Work owns "resolved Action identity").
   *
   * Recorded, never asserted: it is written once at Work creation/dispatch
   * by the code that dispatched the Work, and thereafter only advanced by
   * the code that legitimately performs a different registered operation on
   * this Work -- exactly as `stage` and `awaiting` are. It is never
   * supplied by a call site as part of an authorization claim, and never
   * inferred from whichever Unit/Hat happens to be running.
   *
   * src/access.ts reads the Action from here (via `workSessionContext(state)`)
   * rather than from anything a caller passes, so a call site cannot
   * downgrade an operation by naming a laxer Action. A caller MAY pass
   * `assertedActionName` purely as a cross-check; a conflict with this
   * field fails closed rather than resolving to either value.
   *
   * Absent only for genuinely action-less Work (the standalone Google
   * Workspace control Work in googleOAuth.ts). Access treats an absent
   * action on a business-object write as a denial, never as "un-gated".
   */
  actionName?: string;
  stage: string;
  awaiting?:
    | "call_notes"
    | "proposal_feedback"
    | "entity_pick"
    | "matter_pick"
    | "intervention"
    | "value_context_more"
    | "quote_redo_reason"
    | "matter_redo_reason"
    | "entity_redo_reason"
    | "marketing_feedback"
    | "marketing_clarification"
    | "strategy_clarification"
    | "strategy_feedback"
    | "strategy_refinement_reason"
    | "strategy_discussion"
    | "strategy_direct_request_matter"
    | "finance_direct_request_matter"
    | "finance_direct_request_context"
    | "sales_proposal_revision"
    /**
     * Set when a comment on a Proposal's Google Doc could not be classified
     * (ambiguous, mixed, malformed or failed classification): neither the
     * formatting path nor the revision path may run, so the Work waits for
     * Martin's Telegram reply, which re-classifies the SAME comment with his
     * clarification and routes it exactly once. `pendingProposalDocClarification`
     * carries the bindings (comment, document, Proposal, version, text).
     */
    | "proposal_doc_clarification"
    /**
     * Set when a Business Development qualify_* action (any of the three
     * Hats' qualify_opportunity/qualify_partnership/qualify_growth_opportunity)
     * returns Held -- an "internal" consequence action pausing on missing
     * evidence, never an approval gate (see actionRegistry.ts's
     * consequence/approval separation). Resumed by supplying the missing
     * evidence in reply; bdOpportunity below carries what was already
     * gathered.
     */
    | "bd_opportunity_evidence_gap";
  createdAt: string;
  updatedAt: string;

  enquiryText?: string;
  /**
   * How this work item originated. "inbound_enquiry" is set by Sales's
   * handleIncomingEnquiry and carried onto the Sales -> Finance Handoff's
   * Reason so Finance has that context, required (fail-closed, never
   * defaulted) before that Handoff may be created. "outbound_outreach"
   * exists for a work item originating from proactive outreach (e.g. off
   * the back of an approved Lead Opportunity) but nothing sets it yet.
   * "direct_request" is set by a Unit's own handleDirectRequest for work
   * Martin originates directly in Cowork chat rather than via an upstream
   * Handoff (see strategy.handleDirectRequest).
   *
   * "handoff_pickup" is set only by a Unit's own Handoff pickup handler, at
   * the moment it has actually claimed the Handoff it was discovered for --
   * the pickup is then the provenance fact and not a claim a caller can
   * assert (Sales's handleCallNotesHandoffPickup is the current setter). It
   * is deliberately NOT "direct_request": that value means the work was
   * originated directly in chat "rather than via an upstream Handoff", so
   * using it for a Handoff-origin session would record the opposite of what
   * happened -- and would carry the wrong attestation consequence
   * downstream, where "direct_request" is the exemption from source-boundary
   * attestation and every Handoff-originated work item must still attest.
   *
   * Exactly four values, no others; handleInterventionText's provenance gate
   * rejects anything outside this set rather than trusting a truthy string.
   */
  entryType?: "inbound_enquiry" | "outbound_outreach" | "direct_request" | "handoff_pickup";
  /**
   * Structured commercial-value evidence extracted from enquiry text/call
   * notes during discovery, per the Commercial Value & Pricing Operating
   * Model -- the pricing basis carried to Finance via the Handoff. Set by
   * handleCallNotes's extraction step; deterministically validated (never
   * taken on the AI's own say-so) before it can satisfy the
   * commercial_value_evidence qualification condition.
   */
  commercialEvidence?: CommercialEvidence;
  /**
   * Client-stated investment range/boundary -- context only. See
   * InvestmentToleranceContext's doc comment: never the pricing basis,
   * never a substitute for commercialEvidence.
   */
  investmentToleranceContext?: InvestmentToleranceContext;
  /**
   * The commercial baseline preserved once Lead->Prospect is approved, for
   * later measurement per the operating model's Section 8. Set once from
   * commercialEvidence at qualification time and carried onto the Matter
   * record; not re-derived downstream.
   */
  measurementBaseline?: MeasurementBaseline;
  entityId?: string;
  /** Human-readable Entity name -- only ever populated by a Unit that has legitimately resolved the real identity (Sales). Never overload this with a token. */
  entityName?: string;
  matterId?: string;
  /**
   * Set once this Work's `matterToken` has been looked up and found to
   * resolve to NO real Matter (an unbound placeholder such as "M-UNBOUND",
   * or a token whose Matter no longer exists). It is the negative cache for
   * that lookup, not a Matter identity: it stops WorkSession.save from
   * re-querying the same dead token on every save, and it means this Work
   * never gets a `matter_current_work` continuation pointer (see
   * src/matterContinuation.ts). A transient read failure is deliberately
   * NOT recorded here -- those retry on the next save.
   */
  matterIdUnresolved?: boolean;
  /** Human-readable Matter name -- only ever populated by a Unit that has legitimately resolved the real identity (Sales). Never overload this with a token. */
  matterName?: string;
  /**
   * The opaque Entity_Token (e.g. "E-20") this work item operates under.
   * Units that operate on Handoffs only (Strategy, Finance) never
   * learn a real Entity name at all, per the closed-context contract in
   * dataBoundary/policy.ts -- this is the identity they actually have, and
   * is what must be used in any Handoff field or Telegram message they
   * produce. Distinct from entityName, which some of those Units'
   * discovery code previously (incorrectly) overloaded to hold this same
   * token -- see the centralized Handoff writer (src/handoffWriter.ts).
   */
  entityToken?: string;
  /** The opaque Matter_Token (e.g. "MAT-20") this work item operates under. See entityToken's doc comment -- same semantics, Matter side. */
  matterToken?: string;
  handoffId?: string;
  callNotes?: string;
  qualification?: QualificationResult;
  proposedIntervention?: string;
  quote?: Quote;
  proposalDraft?: string;
  proposalRevisionCount?: number;
  pendingApproval?: PendingApproval;
  candidateEntities?: { id: string; name: string }[];
  candidateMatters?: { id: string; name: string }[];
  blockedReason?: string;

  /**
   * Durable records of the external Tool operations this Work has initiated
   * (src/runtime/toolRegistry.ts's durable-recovery contract), keyed by
   * `<operation_id>|<target_resource_id>` -- the stable operation identity
   * for this Work. Written to the Work's own Durable Object storage in two
   * places only: an `in_progress` intent BEFORE the first protected external
   * effect, and the terminal outcome immediately after. On resumption the
   * invocation boundary reads this back, so an interrupted operation is
   * reconciled against the provider (or held unverified) and never blindly
   * retried, and a verified success is returned as-is instead of repeated.
   *
   * Deliberately free of input, document content, tokens and credentials --
   * see ExternalToolOperationRecord. Absent until this Work performs its
   * first external operation.
   */
  externalOperations?: Record<string, ExternalToolOperationRecord>;

  /**
   * A proposed new Matter's drafted title + stated need, shown to Martin
   * for approval before the record is created — per the Sales AI Project
   * Instructions' Matter identification rule ("pass through the applicable
   * creation authorization gate before creating the Matter record").
   */
  matterDraft?: { name: string; statedNeed: string };

  /**
   * A proposed new Entity's drafted fields, shown to Martin for approval
   * before the record is created — per the same Universal Role Contract
   * rule ("Drafted content...shown in chat for approval before being
   * written to Notion") applied to Matter creation above.
   */
  entityDraft?: { name: string; email: string; phone: string; type: string };

  /**
   * Set when Finance (or another picked-up Unit) has posted a blocker to its
   * OWN topic and is awaiting a reply there, rather than in the topic the
   * enquiry originated from. Lets a reply typed in that topic resume this
   * session, and lets terminal cleanup clear that topic's active pointer too.
   */
  financeThreadId?: number;
  /**
   * Sanitized value context a direct-entry (no upstream Handoff) Finance
   * quote is grounded in -- carried across the finance_direct_request_context
   * continuation loop so an insufficient-evidence hold can be re-augmented
   * from Martin's own follow-up without a Handoff record to re-read it
   * from (contrast the Handoff-pickup path, whose source of truth stays
   * the Handoff's own Verified Facts & Sources). Mirrors strategyContext.
   */
  financeJudgmentContext?: string;

  /** Original task text for a Marketing work item — carried across redo/clarification loops. */
  marketingTaskText?: string;
  /** The current Marketing Hat's drafted output, shown to Martin for approval before anything is treated as done. */
  marketingDraft?: string;
  /** A proposed transition to another Marketing Hat (routing or escalation), pending Martin's confirmation. */
  pendingTransition?: { toHat: string; reason: string };
  /** A proposed paid-media/spend action, pending Martin's explicit budget/spend approval. */
  pendingPaidMediaAction?: { description: string };

  /**
   * The live status checklist of this Work's current run, shown in one
   * Workspace message edited in place (see src/runtime/workStatus.ts):
   * the Hat it is labelled with, a header, the steps done, and the step
   * running now. Cleared when the run reports its final line.
   */
  workStatus?: import("./runtime/workStatus").WorkStatus;
  /** The Telegram message id of that status message. */
  workStatusMessageId?: number;

  /** The strategic question/business situation a Strategy work item is diagnosing -- carried across clarification/feedback loops. */
  strategyQuestion?: string;
  /** Sanitized supplied context (from a Handoff's own record) the diagnosis is grounded in. */
  strategyContext?: string;
  /** The most recently delivered structured diagnosis -- preserved so a downstream Handoff proposal can be built/rebuilt from it without re-running the AI call. */
  strategyDiagnosis?: import("./units/strategy/strategyAnalyst").StrategyDiagnosisResult;
  /**
   * The bounded Strategy Skill findings this diagnosis's composable-Skills
   * cycle actually invoked (if any) -- observability/testability only;
   * synthesis is folded into strategyContext, never read back out of this
   * field by the diagnosis pipeline itself. Populated whenever the cycle ran;
   * `[]` legitimately means Strategy Analysis genuinely determined no Strategy
   * Skill was required -- see strategySkillCycleUnavailable for why that is a
   * different thing from the cycle not being able to run.
   */
  strategySkillFindings?: import("./units/strategy/strategySkillCycle").StrategySkillFinding[];
  /**
   * Set only when the composable-Skills cycle's own analysis move itself
   * could not be obtained (provider failure, or output that carried no usable
   * decision). `true` means the cycle was unavailable and this diagnosis
   * proceeded without Skill composition as a degraded fallback, NOT because
   * no Skill was genuinely determined necessary. `false` means Strategy
   * Analysis ran and genuinely determined no Strategy Skill was required.
   * `undefined` means the cycle ran and at least one Skill was invoked (see
   * strategySkillFindings for their outcomes). These three states must never
   * be conflated -- a persisted WorkState (or a test) can always tell "no
   * Skill needed" apart from "we don't actually know, the cycle itself
   * couldn't run."
   */
  strategySkillCycleUnavailable?: boolean;
  /**
   * WHY strategySkillCycleUnavailable is `true` -- the AI-call cause code
   * only (`outbound_gate_blocked` | `providers_exhausted` | `unparseable`,
   * never payload content or a human-readable reason string). Set together
   * with `strategySkillCycleUnavailable = true` and cleared together with
   * its other transitions, so the persisted state records not just that the
   * composable-Skills cycle could not run but which class of failure kept
   * it from running. Undefined when the cycle was not unavailable.
   */
  strategySkillCycleUnavailableCause?: import("./ai/policy").AiFailureCause;
  /**
   * A proposed Strategy -> another-Unit handoff, pending Martin's explicit
   * approval before the Handoff record is created (a preview/approval
   * gate). A recommendation is never treated as authorization to route it onward.
   */
  pendingStrategyHandoff?: {
    unit: Unit;
    hat: string;
    handoffTitle: string;
    reason: string;
    requiredNextAction: string;
    expectedOutput: string;
    acceptanceCriteria: string;
    verifiedFactsAndSources: string;
    assumptions: string;
    openQuestions: string;
  };

  /**
   * The complete Strategic Intervention Proposal currently in play for this
   * Strategy work item -- a runtime/work-state artifact, not a Notion
   * database object. Regenerated (new proposalId, proposalVersion + 1) on
   * every Refine; the prior version is pushed onto strategyProposalHistory
   * rather than discarded, so it remains available as historical context.
   */
  strategyProposal?: import("./units/strategy/strategyAnalyst").StrategyProposal;
  /** Every superseded proposal version for this work item, oldest first -- see strategyProposal's doc comment. */
  strategyProposalHistory?: import("./units/strategy/strategyAnalyst").StrategyProposal[];

  /** Business Development's in-flight opportunity state -- see BDOpportunityState's doc comment. Execution state (persisted for pause/resume across a qualify_* hold), not governed business state. */
  bdOpportunity?: import("./units/businessDevelopment/types").BDOpportunityState;
  /**
   * A proposed BD -> Sales/Strategy opportunity handoff, pending Martin's
   * explicit approval before the Handoff record is created -- mirrors
   * pendingStrategyHandoff's own preview/approval
   * gate exactly (see handleBDOpportunityHandoffApproval). A recommendation
   * is never treated as authorization to route it onward.
   */
  pendingBDHandoff?: {
    unit: Unit;
    hat: string;
    handoffTitle: string;
    reason: string;
    opportunitySummary: string;
  };
  /**
   * A drafted BD opportunity development (stakeholders, value hypothesis,
   * route, dependencies, risks, next step), pending Martin's explicit
   * approval before it's recorded into bdOpportunity.developedState --
   * mirrors pendingBDHandoff's own preview/approval gate exactly (see
   * handleBDOpportunityDevelopApproval). A draft is never treated as
   * authorization to commit it.
   */
  pendingBDDevelop?: {
    draftSummary: string;
  };
  /**
   * A drafted next-move recommendation for an active BD opportunity,
   * pending Martin's explicit approval before it's recorded into
   * bdOpportunity.nextMove -- mirrors pendingBDDevelop's own preview/
   * approval gate exactly (see handleBDOpportunityNextMoveApproval). A
   * recommendation is never treated as authorization to commit it.
   */
  pendingBDNextMove?: {
    nextMoveSummary: string;
  };
  /**
   * The Strategy Proposal's own approval-lifecycle state, per the canonical
   * commercial flow (Sales -> Strategy -> Finance). This is authoritative
   * for whether an Approve/Refine/Reject callback may act at all --
   * handleInterventionApproval refuses to mutate anything unless this is
   * exactly "AWAITING_INTERVENTION_APPROVAL" and pendingStrategyApproval
   * matches the callback's identity exactly.
   */
  strategyApprovalState?: "DRAFT" | "AWAITING_INTERVENTION_APPROVAL" | "REFINEMENT_REQUESTED" | "APPROVED" | "REJECTED";
  /**
   * The exact proposal identity currently awaiting Martin's decision --
   * workId + proposalId + proposalVersion must all match a callback before
   * it may mutate state, so a stale callback from an earlier proposal
   * version, or one addressed to a different/superseded WorkSession, is a
   * logged no-op rather than a mutation. Reuses the existing generic
   * approval-callback infrastructure (Telegram inline buttons ->
   * handleCallback -> this Hat's own handler) -- no new callback/approval
   * mechanism was introduced.
   */
  pendingStrategyApproval?: {
    kind: "strategy_intervention";
    strategyWorkSessionId: string;
    proposalId: string;
    proposalVersion: number;
    decisionOptions: ("approve" | "refine" | "reject")[];
  };

  /**
   * The canonical, token-safe Runtime Sales Proposal produced from a
   * Finance -> Sales Handoff (see units/sales/tokenSafeProposal.ts). The
   * Notion Proposals record is the system of record; this mirrors it so an
   * approval callback can be checked against the exact Proposal ID + Version
   * Martin was shown. Every version's full content is kept here (and as a
   * snapshot in the Proposal page body), so an approved version's substance
   * survives a later revision.
   */
  salesProposal?: import("./units/sales/tokenSafeProposal").RuntimeSalesProposal;
  /**
   * Set when Martin asked for changes to a specific Proposal ID + Version
   * and the runtime is waiting for his change text. Bound to that exact
   * version: a revision request for a superseded version is refused.
   */
  pendingSalesProposalRevision?: { proposalNumber: number; fromVersion: number };
  /**
   * Set when a comment on a Proposal's Google Doc could not be classified
   * (ambiguous, mixed, malformed or failed classification) and Martin was
   * asked which it was. Bound to that exact comment, document, Proposal and
   * version, and to the comment's own text: the clarification continues the
   * SAME request rather than starting an unrelated one, and the comment is
   * NOT marked processed while this is outstanding, so a transient failure
   * can never lose it. Cleared when the clarification resolves (the routed
   * handler runs) or when the bindings no longer hold (answered honestly,
   * never silently).
   */
  pendingProposalDocClarification?: { commentId: string; documentId: string; proposalNumber: number; version: number; text: string };
  /**
   * The result of the Sales-side source-boundary check performed when the
   * Sales -> Strategy Handoff was created (createHandoff already runs
   * assertTokensPresent + findViolation against the authoritative identity
   * Sales supplied -- see handoffWriter.ts's HandoffSourceBoundaryAttestation
   * for the explicit `result` (Passed/Failed) and the five named checks).
   * This records WHICH known-identity fields were actually available and
   * checked at that moment -- never the values themselves -- so a later
   * Strategy Proposal-content check can honestly say its known-identity set
   * matches what the source boundary was already checked against.
   *
   * DURABLE TRANSPORT: the authoritative, fail-closed copy of this evidence
   * is the attestation marker createHandoff writes INTO the Handoff record
   * itself at creation (the marker channel in handoffWriter.ts) -- that is
   * what a fresh Strategy session reads and consumes at pickup (see
   * strategyAnalyst.ts's readSourceBoundaryEvidence). This WorkState copy
   * is a same-session convenience/audit copy only: it is set once,
   * immediately after the Handoff write succeeds (a throw there means it is
   * never set, consistent with fail-closed), and pickup re-seeds this field
   * from the durable record so a missing/Failed/unbound marker can never be
   * masked by a stale session copy. See salesExecutive.ts's
   * handleInterventionText.
   */
  strategySourceBoundaryAttestation?: HandoffSourceBoundaryAttestation;
  /**
   * The upstream Commercial Value Evidence block exactly as it is written in
   * the Sales -> Strategy Handoff's "Verified Facts & Sources" (markers
   * included), read and structurally parsed at pickup -- see
   * units/sales/commercialValueEvidence.ts. This is PROVENANCE, not a new
   * evidence model: the determination inside it was produced upstream by
   * Sales's deterministic `evaluateCommercialValueEvidence`, and Strategy
   * copies this block byte-for-byte into the Strategy -> Finance Handoff so
   * Finance judges against the same determination it was handed.
   *
   * Absent (with `commercialValueEvidenceError` saying why) whenever the
   * block could not be read or could not be parsed deterministically --
   * presentStrategyProposalForApproval treats that as a fail-closed provenance
   * failure and never as a reason to doubt the determination itself: an
   * `Insufficient Evidence` determination still sits here fully valid.
   */
  commercialValueEvidenceBlock?: string;
  /** Why `commercialValueEvidenceBlock` is absent (markers absent, not JSON, malformed field...). Carried only so a fail-closed gate can name the exact provenance gap. */
  commercialValueEvidenceError?: string;
  /**
   * Set when Martin has supplied the specific commercial fact Finance named
   * in its value-evidence hold (see valueBasedPricingAssessor.ts's
   * handleValueContextClarification). While the block's upstream
   * `Insufficient Evidence` determination is the whole picture, Finance
   * holds deterministically and asks; once a fact has actually been
   * supplied, that fact must be re-evaluated through Finance's EXISTING
   * judgment + validateFinanceJudgement path, because the block's own
   * bytes are upstream-authored and cannot be edited from here. The flag
   * only ever selects which of those two governed paths runs -- it is never
   * a pricing authority, and never overrides validateFinanceJudgement.
   */
  valueEvidenceFactSupplied?: boolean;
  /**
   * The bounded, deterministic known-identity safety attestation for the
   * EXACT Strategy Proposal (proposalId, proposalVersion) currently
   * approved/in-flight -- see verifyStrategyProposalTokenSafety and
   * checkStrategyProposalForKnownIdentity (strategyAnalyst.ts). This is a
   * narrow claim: the Sales-authored Sales -> Strategy source Handoff was
   * checked against Sales's known identity, AND the complete assembled
   * Strategy Proposal for this exact version was independently checked
   * against that same known-identity set -- neither found a match. It is
   * NOT a claim that the Proposal is free of arbitrary/unknown identity;
   * see checkStrategyProposalForKnownIdentity's own doc comment. Every
   * distinct proposalVersion (including every refinement) requires its own
   * independent proposalContent check -- never inherited from a prior
   * version, per verifyStrategyProposalTokenSafety's exact-match discipline.
   * Never carries the identity values themselves, only which fields were
   * checked. Replaces the prior unconstrained `basis: string` shape, which
   * could not honestly represent which checks had actually run. The field
   * lists are evidence of what each check compared, not a required set: an
   * Entity/Matter name is always its own token, so the proposal check
   * records only contactName/email/phone when known -- often none.
   */
  strategyProposalTokenSafety?: {
    proposalId: string;
    proposalVersion: number;
    sourceBoundary: { checked: true; identityFieldsChecked: KnownIdentityField[] };
    proposalContent: { checked: true; identityFieldsChecked: KnownIdentityField[] };
  };
  /**
   * The exact Strategy Proposal identity (proposalId + proposalVersion)
   * Martin is refining -- set when he taps Refine, bound to the proposal
   * that was actually on screen at that moment. handleStrategyRefinement
   * verifies this matches state.strategyProposal exactly before applying
   * anything; a mismatch (the proposal moved on in the meantime) is a
   * fail-closed no-op, same discipline as pendingStrategyApproval/
   * pendingSalesProposalRevision. This exists so Martin's free-text
   * refinement reply can be bound to a specific artifact rather than
   * "whatever the current proposal happens to be" -- it never becomes part
   * of state.strategyContext and is never persisted to the Handoff; it is
   * transient control input for exactly one revision.
   */
  pendingStrategyRefinement?: { proposalId: string; proposalVersion: number };
  /**
   * An open Discuss conversation about the CURRENT Strategy Proposal, bound
   * to the exact proposal identity it was opened on. Every question
   * re-verifies that binding against state.strategyProposal and the
   * pending approval before anything runs, so a stale question can never
   * act on a newer version. Discussion is read-only with respect to the
   * proposal, diagnosis, strategyContext and the Handoff: it never creates a
   * version, never reaches Notion, and the turns are never fed into Revise
   * (the existing Refine path takes Martin's own instruction only). Only a
   * successful turn is saved; an answer the Outbound Data Gate's own
   * detector would refuse is saved withheld, so saved turns can never
   * block a later question.
   */
  strategyDiscussion?: {
    proposalId: string;
    proposalVersion: number;
    turns: { question: string; answer: string }[];
  };

  /**
   * Controlled Google Workspace action proposed by a Hat, awaiting explicit Martin approval.
   */
  pendingGoogleAction?: import("./googleOAuth").PendingGoogleAction;

  /**
   * An evidence-backed opportunity finding (from either scheduled or
   * on-demand Lead Generation Specialist discovery), awaiting Martin's
   * explicit approval before it becomes a Lead -- per the governance
   * requirement that no discovery source may create a Lead automatically.
   */
  pendingLeadOpportunity?: import("./units/sales/leadGenerationDiscovery").PendingLeadOpportunity;

  /**
   * Generic, display-only descriptor of whatever approval-gated action is
   * currently pending on this WorkSession (if any) -- set alongside the
   * domain-specific pending field above (pendingLeadOpportunity,
   * pendingGoogleAction, entityDraft, etc.) by every propose site, so
   * /sessions can show a meaningful label and resurface the exact original
   * message+buttons if Martin's approval message is missed or dismissed.
   *
   * This is NEVER the authority for whether an action may still execute --
   * that remains each domain-specific pending field, checked by its own
   * resolve handler. pendingActionSummary is purely "what to redisplay if
   * asked," not a second source of truth.
   */
  pendingActionSummary?: PendingActionSummary;

  /**
   * Transient one-shot signal, NOT a persistent pending-approval field: set
   * by a Hat handler that just successfully queued a Handoff (createHandoff
   * succeeded and its Telegram confirmation was sent) to tell the caller
   * (router.ts / index.ts, running in the Worker's own isolate, never the
   * WorkSession Durable Object itself -- see checkHandoffs.ts's
   * runCheckHandoffs doc comment for why) to trigger the existing
   * /checkhandoffs continuation immediately, in this same chat/thread,
   * instead of waiting for the next scheduled discovery cycle. Reset to
   * false at the start of every WorkSession.execute() call (session.ts) so
   * a stale true from an earlier, unrelated call can never leak into a
   * later one -- true only ever reflects "the handler that just ran, in
   * this exact call, queued a Handoff."
   */
  pendingHandoffAutoCheck?: boolean;
}

/**
 * Generic descriptor for an approval-gated action awaiting Martin's
 * decision, used to make any pending approval discoverable and
 * re-actionable via /sessions regardless of which Hat/Unit proposed it.
 * See WorkState.pendingActionSummary.
 */
export interface PendingActionSummary {
  /** Short human-readable label for the /sessions list row, e.g. "Opportunity: Acme Co". */
  label: string;
  /** The exact original message text, resent verbatim if this item is resurfaced. */
  message: string;
  /** The exact original inline keyboard, resent verbatim if this item is resurfaced. */
  buttons: InlineButton[][];
  /** When this approval was first proposed -- used for backlog-age reporting only. */
  createdAt: string;
}

export interface SessionSummary {
  workId: string;
  unit?: Unit;
  hat?: string;
  stage: string;
  /**
   * Display label for /sessions -- SAFE VALUES ONLY: canonical token
   * references (`ENT-<n>` / `MAT-<n>`) or fixed generic metadata
   * ("pending approval", "(new)"), produced solely by
   * sessionsIndex.ts deriveSessionLabel and re-derived for EVERY entry on
   * every save (sanitizeSessionsIndex). Human-readable names, enquiry text
   * and free-text approval labels are never stored here: this value is
   * coordination state that may fall back to Turso (Option 1 boundary).
   */
  label: string;
  updatedAt: string;
  /** Whether this work item currently has a pendingActionSummary -- drives sessions_index's bounded pending/general pool split. */
  hasPendingApproval?: boolean;
  /**
   * The Matter page id this Work belongs to, when known -- carried so the
   * runtime's derived Matter -> current Work index can read resumability
   * from the index it already maintains (src/matterContinuation.ts) instead
   * of reading every candidate WorkSession. Runtime KV only: this is a
   * derived pointer, never Matter state, and it is never written to the
   * Matter Business Object in Notion.
   */
  matterId?: string;
  /**
   * The Work's canonical Entity token (e.g. "ENT-7") when it has one --
   * the safe display reference the label is derived from. A reference for
   * display only: never authorization, never Work identity (workId is the
   * execution reference), and only stored when it matches the canonical
   * token shape.
   */
  entityToken?: string;
  /** The Work's canonical Matter token (e.g. "MAT-20") -- same semantics as entityToken, Matter side. */
  matterToken?: string;
}
