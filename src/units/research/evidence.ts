import type { ResearchProtocolId } from "./protocols";

/**
 * Research Output Contract, per the R&I Unit's Notion definition:
 * Evidence -> Finding -> Implication -> Limitation -> Source, kept
 * explicitly distinguishable rather than collapsed into prose. This file
 * is the code-level enforcement of that contract's one hard rule -- "the
 * system must never silently turn an inference into a finding" -- as an
 * actual gate the model's output has to pass, not just a prompt
 * instruction it might ignore.
 */

export interface SourceRecord {
  id: string;
  source: string;
  sourceType: string;
  url?: string;
  publicationDate?: string;
  retrievalDate?: string;
  passage: string;
  claimSupported: string;
  limitations?: string;
  validationStatus: "validated" | "unvalidated" | "contradicted";
}

export interface EvidenceItem {
  id: string;
  statement: string;
  sourceIds: string[];
}

export interface Finding {
  statement: string;
  /** Must reference at least one real EvidenceItem id -- enforced by validateSynthesis, never left to the model's discretion. */
  evidenceIds: string[];
}

export interface Implication {
  statement: string;
  basedOnFindingIndexes: number[];
}

export interface Limitation {
  statement: string;
  relatedTo?: string;
}

export interface ResearchSynthesis {
  protocolsUsed: ResearchProtocolId[];
  sources: SourceRecord[];
  evidence: EvidenceItem[];
  findings: Finding[];
  implications: Implication[];
  limitations: Limitation[];
}

export interface SynthesisValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Fails closed on the exact failure mode this contract exists to prevent:
 * a Finding with no supporting Evidence (an inference dressed as a
 * finding), a Finding or Evidence item referencing a Source/Evidence id
 * that doesn't exist (a fabricated citation), or an Implication with no
 * underlying Finding. Called before any synthesis is ever shown to Martin
 * or written back to a Handoff -- an invalid synthesis is treated as a
 * failed execution, not a lower-confidence result.
 */
export function validateSynthesis(synthesis: ResearchSynthesis): SynthesisValidationResult {
  if (synthesis.protocolsUsed.length === 0) {
    return { valid: false, reason: "No research protocol was recorded as used." };
  }

  const sourceIds = new Set(synthesis.sources.map((s) => s.id));
  for (const evidenceItem of synthesis.evidence) {
    if (evidenceItem.sourceIds.length === 0) {
      return { valid: false, reason: `Evidence item "${evidenceItem.statement.slice(0, 80)}" cites no source.` };
    }
    for (const sourceId of evidenceItem.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        return { valid: false, reason: `Evidence item "${evidenceItem.statement.slice(0, 80)}" cites unknown source id "${sourceId}".` };
      }
    }
  }

  const evidenceIds = new Set(synthesis.evidence.map((e) => e.id));
  for (const finding of synthesis.findings) {
    if (finding.evidenceIds.length === 0) {
      return { valid: false, reason: `Finding "${finding.statement.slice(0, 80)}" cites no evidence -- an unsupported claim cannot be presented as a finding.` };
    }
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        return { valid: false, reason: `Finding "${finding.statement.slice(0, 80)}" cites unknown evidence id "${evidenceId}".` };
      }
    }
  }

  for (const implication of synthesis.implications) {
    if (implication.basedOnFindingIndexes.length === 0) {
      return { valid: false, reason: `Implication "${implication.statement.slice(0, 80)}" cites no underlying finding.` };
    }
    for (const idx of implication.basedOnFindingIndexes) {
      if (idx < 0 || idx >= synthesis.findings.length) {
        return { valid: false, reason: `Implication "${implication.statement.slice(0, 80)}" references a finding index that doesn't exist.` };
      }
    }
  }

  return { valid: true };
}

/**
 * This Hat has no live browsing/search tool -- its only actual source of
 * facts is whatever text was supplied to it (a Handoff's sanitized
 * context, or Martin's own direct chat message). validateSynthesis alone
 * can't catch a model inventing a plausible-sounding source (confirmed
 * live: asked for competitor research with no supplied context, it
 * returned fabricated companies, a fabricated "Market Research Report",
 * and fabricated URLs, each internally well-formed and passing every
 * validateSynthesis check). This is the second, independent gate: a
 * Source is only trusted if its name or URL literally appears in the
 * context the model was actually given -- if it doesn't, this Hat could
 * not possibly have obtained it honestly, and it's treated as fabricated,
 * not published, regardless of how well-formed the rest of the synthesis
 * is.
 */
export function findUnverifiableSources(synthesis: ResearchSynthesis, suppliedContext: string): SourceRecord[] {
  const normalizedContext = suppliedContext.toLowerCase();
  return synthesis.sources.filter((s) => {
    const nameMatches = s.source.trim().length > 0 && normalizedContext.includes(s.source.trim().toLowerCase());
    const urlMatches = Boolean(s.url) && normalizedContext.includes(s.url!.trim().toLowerCase());
    return !nameMatches && !urlMatches;
  });
}
