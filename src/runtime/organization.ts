import type { Unit } from "../types";
import type { HatManifest, UnitManifest } from "../units/unitManifest";
import type { WorkContract } from "./workContract";

/**
 * The Organization resolution boundary (ENIG Operating Model, current
 * architecture: "Organization owns organizational resolution" --
 * Business Function -> Unit -> optional Specialization -> Hat ->
 * Responsibility).
 *
 * WHAT IT IS: a deterministic resolver. It reads the canonical definitions
 * (the Unit's registered manifest, its declared Hats and their
 * `responsibilityId`) plus the Work's resolved `requested_outcome` /
 * `current_context`, and returns exactly one Organization context or a
 * fail-closed reason. No AI provider call happens here, no default Unit,
 * no default Hat, no "closest match": an ambiguity stops the request.
 *
 * WHAT IT IS NOT: an intake interpreter. Where a Unit has several Hats and
 * the Work was addressed to none of them, an upstream AI intake
 * classification may PROPOSE candidate Hat names
 * (`current_context.interpreted_hats`). Those candidates are untrusted
 * input this function validates against the canonical definitions -- it
 * can reject them, it can never be talked into substituting one, and a
 * proposal naming a Hat this Unit does not own fails closed rather than
 * falling back. The evidence records whether an interpretation was
 * consulted and why, so "did a model touch this decision?" is answerable
 * from the resolution itself rather than from reading the code path.
 *
 * Handoff destination (`current_context.handoff`) is a FACT: when a Work
 * is entered from a Handoff, `To Unit`/`To Hat` are consumed as the
 * established destination, never re-decided, never reclassified.
 */

/** The resolved organizational context of one Work. */
export interface OrganizationContext {
  /**
   * No canonical Business Function mapping exists in this repository --
   * the Business Function layer is declared in Notion, which is not
   * readable from here. Deliberately null rather than invented: see the
   * Operating Model's Known gaps.
   */
  business_function: string | null;
  unit: Unit;
  specialization: string | null;
  hat: string;
  responsibility: string;
}

export type OrganizationFailureReason =
  /** The addressed Unit has no registered manifest -- no organizational definition to resolve against. */
  | "missing_manifest"
  /** The addressed Unit and the manifest (or the Handoff destination) disagree. */
  | "unit_mismatch"
  /** An addressee or Handoff destination names a Hat this Unit's manifest does not declare. */
  | "unknown_hat"
  /** The resolved Hat declares no Responsibility id -- the Responsibility scope is unresolvable. */
  | "responsibility_missing"
  /** No unique Hat could be resolved: several Hats, no addressee, no usable interpretation. Ambiguity stops. */
  | "ambiguous_ownership";

/** How the Organization was resolved -- auditable, not implied. */
export type OrganizationResolutionSource =
  | "handoff_destination"
  | "explicit_address"
  | "single_hat_ownership"
  | "intake_interpretation";

export interface OrganizationEvidence {
  resolved_from: OrganizationResolutionSource;
  /** True when untrusted intake interpretation candidates were consulted (and validated). False means the resolution is purely structural. */
  interpretation_consulted: boolean;
  evaluated: {
    addressed_unit: string | null;
    addressed_hat: string | null;
    interpreted_hats: readonly string[];
    handoff_destination: { to_unit: string; to_hat: string | null } | null;
  };
}

export type OrganizationResolution =
  | { kind: "resolved"; organization: OrganizationContext; evidence: OrganizationEvidence }
  | { kind: "failed"; reason: OrganizationFailureReason; detail: string };

/**
 * Resolves the Organization context for one Work entry.
 *
 * Deterministic order of authority for the Hat:
 *   1. Handoff destination (`To Hat`) -- a fact; not re-decided.
 *   2. An explicitly addressed Hat -- validated against the manifest.
 *   3. Single-Hat ownership -- the Unit's manifest declares one Hat.
 *   4. A validated intake interpretation -- exactly one candidate this
 *      Unit's manifest declares.
 * Anything else, including a mismatched destination, fails closed.
 */
export function resolveOrganization(contract: WorkContract, manifest: UnitManifest | undefined): OrganizationResolution {
  // Organization resolution reads `current_context` plus the canonical
  // ownership definitions; `requested_outcome` is carried on the contract
  // as the evidence of WHAT was asked, never parsed for ownership here.
  const context = contract.current_context;
  const evaluated = {
    addressed_unit: context.addressed_unit ?? null,
    addressed_hat: context.addressed_hat ?? null,
    interpreted_hats: context.interpreted_hats ?? [],
    handoff_destination: context.handoff
      ? { to_unit: context.handoff.toUnit, to_hat: context.handoff.toHat ?? null }
      : null,
  };

  if (!manifest) {
    return {
      kind: "failed",
      reason: "missing_manifest",
      detail: `no Unit manifest is registered for "${context.handoff?.toUnit ?? context.addressed_unit ?? "the addressed Unit"}" -- refusing to resolve an organizational context without a canonical definition`,
    };
  }

  const hatNames = Object.keys(manifest.hats);

  // The manifest lookup itself is a mechanical step the caller performs
  // (findUnitManifest, or chat's injected lookup hook); what this boundary
  // decides is whether the resolved Unit/Hat/Responsibility agree with the
  // canonical definitions.
  if (context.addressed_unit && context.addressed_unit !== manifest.unit && !context.handoff) {
    return {
      kind: "failed",
      reason: "unit_mismatch",
      detail: `Work addressed to Unit "${context.addressed_unit}" but resolved against ${manifest.unit}'s manifest`,
    };
  }

  if (context.handoff) {
    if (context.handoff.toUnit !== manifest.unit) {
      return {
        kind: "failed",
        reason: "unit_mismatch",
        detail: `Handoff ${context.handoff.handoffId ?? ""} is addressed to Unit "${context.handoff.toUnit}", not "${manifest.unit}" -- the destination is a fact and cannot be redirected here`,
      };
    }
    if (context.handoff.toHat) {
      const hat = manifest.hats[context.handoff.toHat];
      if (!hat) {
        return {
          kind: "failed",
          reason: "unknown_hat",
          detail: `Handoff destination names Hat "${context.handoff.toHat}", which ${manifest.unit} does not declare -- the destination cannot be resolved against this Unit's canonical definition`,
        };
      }
      return resolved(manifest, hat, "handoff_destination", evaluated);
    }
    // Destination Unit is a fact; when it names no Hat, ownership falls to
    // the Unit's own single Hat if that is unambiguous -- never to a guess.
    if (hatNames.length === 1) {
      return resolved(manifest, manifest.hats[hatNames[0]], "single_hat_ownership", evaluated);
    }
    return {
      kind: "failed",
      reason: "ambiguous_ownership",
      detail: `Handoff destination ${manifest.unit} names no Hat, and ${manifest.unit} owns ${hatNames.length} Hats -- ambiguity stops rather than guessing which owns this Responsibility`,
    };
  }

  if (context.addressed_hat) {
    const hat = manifest.hats[context.addressed_hat];
    if (!hat) {
      return {
        kind: "failed",
        reason: "unknown_hat",
        detail: `"${context.addressed_hat}" isn't a registered ${manifest.unit} Hat.`,
      };
    }
    return resolved(manifest, hat, "explicit_address", evaluated);
  }

  if (hatNames.length === 1) {
    return resolved(manifest, manifest.hats[hatNames[0]], "single_hat_ownership", evaluated);
  }

  const validCandidates = (context.interpreted_hats ?? []).filter((name) => manifest.hats[name]);
  if (validCandidates.length === 1) {
    const hat = manifest.hats[validCandidates[0]];
    return resolved(manifest, hat, "intake_interpretation", evaluated);
  }

  return {
    kind: "failed",
    reason: "ambiguous_ownership",
    detail:
      validCandidates.length === 0
        ? `${manifest.unit} owns ${hatNames.length} Hats and this Work names none of them unambiguously -- ambiguity stops rather than defaulting to one`
        : `${manifest.unit} intake resolved ${validCandidates.length} possible Hats (${validCandidates.join(", ")}) -- ambiguity stops rather than picking one`,
  };
}

function resolved(
  manifest: UnitManifest,
  hat: HatManifest,
  source: OrganizationResolutionSource,
  evaluated: OrganizationEvidence["evaluated"],
): OrganizationResolution {
  if (!hat.responsibilityId || !hat.responsibilityId.trim()) {
    return {
      kind: "failed",
      reason: "responsibility_missing",
      detail: `${manifest.unit}/${hat.name} declares no Responsibility id -- the Responsibility scope cannot be resolved for this Work`,
    };
  }
  return {
    kind: "resolved",
    organization: {
      // Canonical Business Function definitions live in Notion and are not
      // readable from this repository; never invented here.
      business_function: null,
      unit: manifest.unit,
      specialization: hat.specialization ?? null,
      hat: hat.name,
      responsibility: hat.responsibilityId,
    },
    evidence: { resolved_from: source, interpretation_consulted: source === "intake_interpretation", evaluated },
  };
}
