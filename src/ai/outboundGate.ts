/**
 * The Outbound Data Gate -- the centralized, fail-closed final check on the
 * ACTUAL effective AI messages, immediately before provider.execute(). This
 * is a distinct, additional layer from both the DataBoundaryEvaluator
 * (which decides whether a provider is eligible for a task's declared
 * SensitivityLevel -- a policy-level decision made without inspecting
 * content) and identityRedaction.ts (a fixed, tiny substitution list for
 * ENIG's own name and Martin's). This gate inspects the actual outbound
 * text for structural identity/PII signals and decides, per the task's
 * declared OutboundDataPolicy, whether THIS EXACT PAYLOAD may leave the
 * runtime.
 *
 * Execution path: AiTask -> DataBoundaryEvaluator -> effective/transformed
 * messages -> identity redaction -> Outbound Data Gate -> provider.execute().
 *
 * This module deliberately does NOT:
 * - maintain a list of real client/company/person names (see
 *   PRODUCTION_OUTBOUND_POLICY's own doc comment for why detection is
 *   structural, not a name blacklist);
 * - query Notion, KV, Durable Objects, GitHub, Google, or any other
 *   external source (it operates only on the payload it's given, plus the
 *   task/policy tables already resident in dataBoundary/policy.ts);
 * - decide substantive commercial or strategic content -- it only decides
 *   whether a payload may be transmitted.
 */
import type { AiMessage, ProviderId } from "./types";
import {
  OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS,
  PRODUCTION_OUTBOUND_POLICY,
} from "../dataBoundary/policy";
import { isSemanticTaskId } from "../dataBoundary/registry";
import type { OutboundDataPolicy, SemanticTaskId } from "../dataBoundary/types";

export type OutboundGateReasonCategory =
  | "ALLOWED"
  | "IDENTITY_AUTHORIZED_TASK"
  | "UNREGISTERED_TASK_ID"
  | "NO_RESOLVED_OUTBOUND_POLICY"
  | "EMAIL_DETECTED"
  | "PHONE_DETECTED"
  | "ADDRESS_DETECTED"
  | "NAME_FIELD_DETECTED"
  | "TITLE_NAME_DETECTED"
  | "CONTACT_CONTEXT_NAME_DETECTED"
  | "COMPANY_SUFFIX_DETECTED"
  | "AMBIGUOUS_LABELED_FIELD_UNCERTAIN";

export type OutboundDetectorClassification = "DEFINITELY_PERMITTED" | "DEFINITELY_PROHIBITED" | "UNRESOLVED_UNCERTAIN";

/**
 * Structured, audit-safe result. Deliberately carries NO payload content --
 * only metadata (task/provider identity, policy resolved, the category and
 * classification a block fell under). Callers must never log or relay the
 * detected email/phone/name/address/company text itself, matching the
 * existing metadata-only audit philosophy (createBoundaryAuditEntry).
 */
export interface OutboundGateResult {
  allowed: boolean;
  policy: OutboundDataPolicy | "UNRESOLVED";
  taskId: string;
  providerId: ProviderId;
  reasonCategory: OutboundGateReasonCategory;
  detectorClassification: OutboundDetectorClassification | "NOT_EVALUATED";
}

// ---------------------------------------------------------------------------
// ENIG token recognition (E-20, MAT-20, M-12, ...) -- never itself a leak.
// Matches every existing token-family prefix in this codebase (Entity ID
// "E-", Matter_ID "M-"/"MAT-") and generalizes to any 1-6 letter uppercase
// prefix, per the ENIG token convention -- an opaque Notion Unique ID
// display string, never a real name.
// ---------------------------------------------------------------------------
const ENIG_TOKEN_PATTERN = /\b[A-Z]{1,6}-\d{1,6}\b/g;

/** Strips every ENIG-token-shaped span from text before running detectors, so a token can never itself trip a detector (defensive -- none of the detectors below currently collide with the token shape, but this makes that guarantee explicit and future-proof). */
function stripTokens(text: string): string {
  return text.replace(ENIG_TOKEN_PATTERN, "");
}

// ---------------------------------------------------------------------------
// Structural detectors. Each is deterministic and content-shape-based --
// never a list of real names. See PRODUCTION_OUTBOUND_POLICY's doc comment
// for which category applies to which task.
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Narrow by design (mirrors handoffWriter.ts's own PHONE_PATTERN): a
// leading "+" international prefix, or a 10-digit local number starting
// with 0 -- specifically so it doesn't false-positive on ordinary business
// figures like currency amounts, quote/proposal numbers, or dates.
const PHONE_PATTERN = /(\+\d[\d\s\-().]{6,16}\d)|(\b0\d{9}\b)/;

// A PO Box, or a leading building/street number immediately followed by a
// recognized street-type word -- deliberately does NOT include a bare
// postal/ZIP code on its own (a bare 5-digit number is not reliably an
// address; it collides with invoice numbers, quote amounts, and years).
const ADDRESS_PATTERN =
  /\bP\.?\s?O\.?\s?Box\s+\d+\b|\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Lane|Ln\.|Drive|Dr\.|Way|Court|Ct\.|Place|Pl\.|Highway|Hwy\.|Terrace|Close|Crescent)\b/i;

// An explicit "Name:" (or "Full Name:") labeled field followed by a
// capitalized word or two -- a structured identity field, per the
// requirement to recognize "identity-bearing structured fields if they
// appear in serialized messages." The marker alternation covers both
// sentence-start and mid-sentence casing explicitly, WITHOUT a blanket
// case-insensitive flag -- an /i flag would make the "must be a capitalized
// word" [A-Z] check on the name portion match lowercase too, defeating the
// entire point (confirmed live: "name: something ordinary" was matching).
const NAME_FIELD_PATTERN = /\b(?:[Nn]ame|[Ff]ull\s+[Nn]ame)\s*:\s*[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3}/;

// A courtesy title immediately followed by a capitalized name -- a
// high-precision, structural signal for person-identity-bearing content
// that does not depend on an email or phone being present. Deliberately
// NOT a name blacklist: it matches the shape "title + proper noun", never
// a specific name.
const TITLE_NAME_PATTERN = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2}\b/;

// A contextual contact/correspondence marker DIRECTLY followed (a colon,
// or nothing) by a two-or-three-word capitalized name -- e.g. "contact
// Jane Doe", "attn: John Smith", "spoke with Kwame Mensah". No comma is
// accepted between the marker and the name: a comma almost always starts a
// new clause in ordinary prose ("...or contact, per this Hat's authority
// limits" must NOT match), so allowing it invited exactly that false
// positive against this codebase's own fixed prompt wording. Requiring two
// consecutive capitalized words (not one) is what keeps this from matching
// this codebase's own single-capitalized-word vocabulary (Hat, Handoff,
// Entity, Matter, Proposal, Version) sitting right after one of these
// marker words -- a real two-word name following a contact marker is the
// deliberately narrow shape this exists to catch.
// As with NAME_FIELD_PATTERN, the marker alternation is spelled out in
// both cases explicitly rather than relying on an /i flag -- that flag
// would make the name-shape [A-Z] check match lowercase too.
const CONTACT_MARKER = "(?:[Cc]ontact|[Aa]ttn|[Aa]ttention(?:\\s+of)?|[Cc]/o|[Ss]poke\\s+with|[Ss]peak\\s+with|[Rr]each\\s+out\\s+to|[Ss]igned|[Rr]egards|[Ss]incerely)";
const CONTACT_CONTEXT_NAME_PATTERN = new RegExp(`\\b${CONTACT_MARKER}\\b:?\\s+[A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+){1,2}\\b`);

// A labeled field whose label commonly precedes a real name in written
// correspondence, but which this codebase's own generated content never
// uses -- ambiguous enough to be UNRESOLVED_UNCERTAIN (not DEFINITELY_
// PROHIBITED) rather than a confident structural match, but still fails
// closed for TOKEN_SAFE_RUNTIME per the fail-closed rule. Requires an
// explicit colon (a genuine labeled field, e.g. "Client: Jane Doe") and two
// consecutive capitalized words, for the same false-positive reasons as
// CONTACT_CONTEXT_NAME_PATTERN above.
const AMBIGUOUS_FIELD_MARKER =
  "(?:[Pp]repared\\s+by|[Pp]repared\\s+for|[Ss]igned|[Cc]lient|[Rr]ecipient|[Ff]rom|[Tt]o|[Cc]c|[Aa]ttention\\s+of)";
const AMBIGUOUS_FIELD_PATTERN = new RegExp(`\\b${AMBIGUOUS_FIELD_MARKER}\\s*:\\s*[A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+){1,2}\\b`);

// A capitalized name-like phrase immediately followed by a recognized
// company/organisation legal-entity suffix -- structural (suffix-based),
// not a company-name list. Skipped for the narrow set of public-source
// tasks named in OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS.
const COMPANY_SUFFIX_PATTERN =
  /\b[A-Z][a-zA-Z&',.]*(?:\s+[A-Z0-9][a-zA-Z0-9&',.]*){0,4}\s+(?:Ltd\.?|Limited|LLC|L\.L\.C\.?|Inc\.?|Incorporated|PLC|Corp\.?|Corporation|Co\.?|Company|GmbH|S\.A\.?|AG|Holdings|Enterprises|Industries|Group|Partners|Associates)\b/;

interface DetectorHit {
  classification: OutboundDetectorClassification;
  reasonCategory: OutboundGateReasonCategory;
}

/**
 * Classifies one piece of outbound text: DEFINITELY_PERMITTED (no
 * structural signal found), DEFINITELY_PROHIBITED (a high-precision
 * structural match -- email, phone, address, labeled name field, title +
 * name, or contact-context + name), or UNRESOLVED_UNCERTAIN (an ambiguous
 * labeled field this codebase's own content never legitimately uses).
 * `companySuffixExempt` skips the company/organisation-suffix detector
 * only -- every other detector still applies.
 */
export function classifyOutboundText(text: string, companySuffixExempt: boolean): DetectorHit {
  const scan = stripTokens(text);

  if (EMAIL_PATTERN.test(scan)) return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "EMAIL_DETECTED" };
  if (PHONE_PATTERN.test(scan)) return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "PHONE_DETECTED" };
  if (ADDRESS_PATTERN.test(scan)) return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "ADDRESS_DETECTED" };
  if (NAME_FIELD_PATTERN.test(scan)) return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "NAME_FIELD_DETECTED" };
  if (TITLE_NAME_PATTERN.test(scan)) return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "TITLE_NAME_DETECTED" };
  if (CONTACT_CONTEXT_NAME_PATTERN.test(scan)) return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "CONTACT_CONTEXT_NAME_DETECTED" };
  if (!companySuffixExempt && COMPANY_SUFFIX_PATTERN.test(scan)) {
    return { classification: "DEFINITELY_PROHIBITED", reasonCategory: "COMPANY_SUFFIX_DETECTED" };
  }
  if (AMBIGUOUS_FIELD_PATTERN.test(scan)) return { classification: "UNRESOLVED_UNCERTAIN", reasonCategory: "AMBIGUOUS_LABELED_FIELD_UNCERTAIN" };

  return { classification: "DEFINITELY_PERMITTED", reasonCategory: "ALLOWED" };
}

export interface OutboundDataGateOptions {
  /** Test-only override of the production per-task policy table. Defaults to PRODUCTION_OUTBOUND_POLICY. */
  taskOutboundPolicy?: Partial<Record<SemanticTaskId, OutboundDataPolicy>>;
  /** Test-only override of the public-source company-suffix-detector exemption set. Defaults to OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS. */
  publicSourceExemptTasks?: ReadonlySet<SemanticTaskId>;
}

/**
 * The Outbound Data Gate itself. Resolves a task's OutboundDataPolicy and
 * decides, per policy, whether the given effective messages may reach
 * `providerId`. Fails closed: an unregistered task, a task with no
 * resolved outbound policy, or TOKEN_SAFE_RUNTIME content the detectors
 * cannot establish as safe are all blocked. IDENTITY_AUTHORIZED tasks are
 * allowed without content inspection -- that policy exists precisely so
 * identity-bearing content is not incorrectly blocked once a task is
 * genuinely, explicitly authorized to carry it.
 */
export class OutboundDataGateEvaluator {
  private taskOutboundPolicy: Partial<Record<SemanticTaskId, OutboundDataPolicy>>;
  private publicSourceExemptTasks: ReadonlySet<SemanticTaskId>;

  constructor(options: OutboundDataGateOptions = {}) {
    this.taskOutboundPolicy = options.taskOutboundPolicy ?? PRODUCTION_OUTBOUND_POLICY;
    this.publicSourceExemptTasks = options.publicSourceExemptTasks ?? OUTBOUND_POLICY_PUBLIC_SOURCE_EXEMPT_TASKS;
  }

  public evaluate(taskId: SemanticTaskId, providerId: ProviderId, messages: AiMessage[]): OutboundGateResult {
    if (!isSemanticTaskId(taskId)) {
      return {
        allowed: false,
        policy: "UNRESOLVED",
        taskId: String(taskId),
        providerId,
        reasonCategory: "UNREGISTERED_TASK_ID",
        detectorClassification: "NOT_EVALUATED",
      };
    }

    const policy = this.taskOutboundPolicy[taskId];
    if (!policy) {
      return {
        allowed: false,
        policy: "UNRESOLVED",
        taskId,
        providerId,
        reasonCategory: "NO_RESOLVED_OUTBOUND_POLICY",
        detectorClassification: "NOT_EVALUATED",
      };
    }

    if (policy === "IDENTITY_AUTHORIZED") {
      // Explicitly authorized to carry identity-bearing content -- never
      // blocked merely for being identity-bearing.
      return {
        allowed: true,
        policy,
        taskId,
        providerId,
        reasonCategory: "IDENTITY_AUTHORIZED_TASK",
        detectorClassification: "NOT_EVALUATED",
      };
    }

    // policy === "TOKEN_SAFE_RUNTIME"
    const companySuffixExempt = this.publicSourceExemptTasks.has(taskId);
    for (const message of messages) {
      const hit = classifyOutboundText(message.content, companySuffixExempt);
      if (hit.classification !== "DEFINITELY_PERMITTED") {
        // Fail closed: both DEFINITELY_PROHIBITED and UNRESOLVED_UNCERTAIN
        // block under TOKEN_SAFE_RUNTIME -- blocking is preferable to
        // silently changing or transmitting substantive input.
        return {
          allowed: false,
          policy,
          taskId,
          providerId,
          reasonCategory: hit.reasonCategory,
          detectorClassification: hit.classification,
        };
      }
    }

    return {
      allowed: true,
      policy,
      taskId,
      providerId,
      reasonCategory: "ALLOWED",
      detectorClassification: "DEFINITELY_PERMITTED",
    };
  }
}

export const defaultOutboundDataGateEvaluator = new OutboundDataGateEvaluator();
