/**
 * The ONE durable free-text marker channel ENIG uses to record a
 * machine-readable fact on a Notion record itself.
 *
 * A marker is a bracket group of `key=value` pairs appended to a free-text
 * property of the record it describes:
 *
 *     [<marker_name> key=value key=value ...]
 *
 * It exists so a fact can be written **atomically with the record it belongs
 * to** (one create/update payload, never a second write that can land
 * alone), with no Notion schema change, no second record, and no separate
 * audit object -- and so a later reader can check the fact against the very
 * record it was read from rather than trusting an ambient claim.
 *
 * Two marker types use this channel, and both MUST keep using it:
 *
 *   - `source_boundary_check` (`src/handoffWriter.ts`) -- the recorded
 *     source-boundary result of a Sales -> Strategy Handoff.
 *   - `record_approval` (`src/units/sales/callNotesMarker.ts`) -- the
 *     recorded approval attestation of a Call Notes record.
 *
 * This module owns the **shared grammar only**: how a marker is shaped, built,
 * and read. Each marker type owns its own field vocabulary, its binding rule,
 * and its fail-closed checks in its own module. Sharing the grammar is what
 * keeps this one mechanism rather than two; keeping the semantics per type is
 * what stops one type's checks from being read as another's.
 *
 * Fail-closed contract for every reader built on this channel: a missing
 * marker, a malformed marker, a marker whose values do not match the record it
 * was read from, or a marker whose recorded result is not the one that type
 * requires, is a **refusal**. Marker presence alone is never the fact it
 * claims to record.
 *
 * Values may not contain whitespace or `]`; the grammar stops a value at
 * either. That is why every binding value in this channel is an opaque token
 * or a hash rather than free prose.
 */

/**
 * The field grammar every marker in this channel shares: `key=value`, where
 * the value runs to the next whitespace or to the closing `]`.
 *
 * Deliberately a single module-level `/g` pattern, used with `matchAll` --
 * which clones the pattern rather than advancing `lastIndex` on the shared
 * one, so a read never carries state into the next read.
 */
export const MARKER_FIELD_PATTERN = /(\w+)=([^\s\]]*)/g;

/** Marker names are identifiers; anything else is a programming error, not input. */
const MARKER_NAME_PATTERN = /^\w+$/;

/** Builds the bracket-group pattern that matches one named marker type. */
export function markerPattern(markerName: string): RegExp {
  if (!MARKER_NAME_PATTERN.test(markerName)) {
    throw new Error(`marker name "${markerName}" is not an identifier -- refusing to build a pattern that could match unintended text.`);
  }
  return new RegExp(`\\[${markerName} ([^\\]]*)\\]`);
}

/**
 * Builds a marker from an ordered field list. Order is the writer's to choose
 * and is not semantically meaningful -- readers key on names, never position.
 */
export function buildMarker(markerName: string, fields: ReadonlyArray<readonly [string, string]>): string {
  if (!MARKER_NAME_PATTERN.test(markerName)) {
    throw new Error(`marker name "${markerName}" is not an identifier -- refusing to build a marker whose name could break out of the bracket group.`);
  }
  const body = fields.map(([key, value]) => `${key}=${value}`).join(" ");
  return `[${markerName} ${body}]`;
}

/**
 * Reads a marker body back as an **ordered** list of `[key, value]` pairs.
 *
 * Ordered and duplicate-preserving on purpose: a `Map` would silently let a
 * later duplicate key overwrite an earlier one, which would turn
 * `result=Rejected result=Approved` into an approval. Readers that must fail
 * closed on a malformed marker use `markerDuplicateKeys` to catch exactly
 * that before they read any value.
 */
export function markerFieldEntries(markerBody: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [, key, value] of markerBody.matchAll(MARKER_FIELD_PATTERN)) {
    entries.push([key, value]);
  }
  return entries;
}

/** The keys recorded more than once in a marker body. Any result means the marker is malformed. */
export function markerDuplicateKeys(entries: ReadonlyArray<readonly [string, string]>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const [key] of entries) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

/**
 * The fail-closed outcome of reading a marker. Shared by every marker type so
 * consumers see one shape: either the evidence is present, correctly bound,
 * and of the required result, or there is a non-sensitive reason to refuse.
 *
 * A refusal reason is a machine-readable explanation for the caller -- never
 * a payload to echo into another Unit's AI input context, and never a
 * container for identity-bearing content.
 */
export type MarkerEvidence<T> = { ok: true; attestation: T } | { ok: false; reason: string };
