import type { Env } from "./types";
import { getPage, plainText, relationIds, uniqueId, type NotionPage, type NotionProperties } from "./notion";
import type { AccessContext, GovernedSource } from "./access";
import { resolveEntityMatterFromTokens } from "./identityResolution";
import { extractCallNotesReference, mentionsCallNotesReference, readApprovalRecord } from "./records/callNotes/callNotesReference";
import { parseRecordApprovalMarker, type CallNotesApprovalRecord, type RecordApprovalAttestation } from "./records/callNotes/callNotesMarker";

/**
 * Runtime resolution of a Handoff's future `Sources` rich-text property:
 * direct links to exact canonical Notion pages, fetched BY PAGE ID and
 * validated against the route contract, the page's real parent database,
 * the Handoff's own Entity/Matter bindings, lifecycle state, and -- where
 * the source type has one -- its recorded approval attestation.
 *
 * **This is direct-page resolution, deliberately not lookup.** Every
 * reference is fetched as the exact page its URL names. Nothing here
 * searches a database, matches a title, or infers which record the sender
 * "meant": a URL that cannot be resolved to one exact canonical page is
 * refused, never approximated. That is the whole point of the property --
 * it replaces the fragile free-text `Call_Notes_ID: <id>` reference
 * convention (which required an exact database QUERY and could only fail
 * closed when the query found zero or several records) with an unambiguous
 * page-identity reference, while keeping every gate the query path had.
 *
 * **Compatibility seam (the live Handoffs database has no `Sources`
 * property yet).** The path is activated per-Handoff by the PRESENCE of the
 * property on the record: `extractHandoffSources` returns `legacy` when the
 * property is absent, and every existing consumer keeps behaving exactly as
 * before (the free-text `Call_Notes_ID` reference convention in
 * `src/records/callNotes/callNotesRecord.ts`). When the property IS
 * present, this resolver governs and the legacy free-text reference is
 * never a fallback -- a Sources-enabled Handoff whose references do not
 * validate is refused outright. Nothing here writes to Notion, migrates
 * the schema, or requires the property to exist: the resolver reads
 * whatever the record actually carries.
 *
 * **What is validated, and where.** Source types come from the page's REAL
 * parent database (read back from Notion by `getPage`, never from the URL's
 * appearance or from anything the caller claims). The route contract
 * (`HANDOFF_SOURCE_ROUTE_CONTRACTS`, keyed by the Handoff's own recorded
 * `From Unit`/`To Unit`) declares which types are required, optional, or
 * prohibited for that route -- explicitly, so "what may travel this route"
 * is one reviewable table rather than behaviour implied by code paths.
 * Per-type validation then runs: for `call_notes`, the canonical Call Notes
 * record's Entity/Matter relations must be exactly the pages the Handoff's
 * own tokens resolve to, its Status must be one that carries approved
 * current evidence, its registry fields must be readable, and its
 * `Approval Attestation` must re-parse against those exact fields (the
 * same `parseRecordApprovalMarker` the legacy query path validates -- no
 * new approval mechanism, and Call Notes approval hashing / evidence
 * versioning is untouched).
 *
 * **Identity boundary.** A source page is a canonical operational record
 * referenced by opaque page identity; resolving one reads no real-world
 * identity (the operational Entity/Matter schemas carry none -- see the
 * identity architecture decision in identityResolution.ts) and nothing
 * fetched here is written anywhere. The Handoff's own identity-token
 * protections, the five `source_boundary_check` checks, and the durable
 * source-boundary attestation in `Reason` (src/handoffWriter.ts) are
 * independent of -- and unaffected by -- this resolver: a Sources
 * reference never substitutes for the attestation, and the attestation is
 * never re-performed here.
 *
 * **Fail closed, always.** Every failure mode returns
 * `{ ok: false, reason }` with a non-sensitive reason. There is no partial
 * success, no "use what validated", and no fallback to titles, narrative
 * text, inferred identity, or database searches.
 */

/** The Handoff property this module resolves. */
export const HANDOFF_SOURCES_PROPERTY = "Sources";

/**
 * The source types a `Sources` reference can name -- the governed canonical
 * databases, reusing access.ts's GovernedSource vocabulary so the type of a
 * reference is decided by the same mapping Access uses. A reference's type
 * is determined by the page's ACTUAL parent data source, never by the URL.
 */
export type HandoffSourceType = GovernedSource;

/**
 * A route contract: what may, must, and must not travel a Handoff route as
 * a `Sources` reference. Keyed by the Handoff's own recorded
 * `From Unit`/`To Unit` (a Handoff's destination is a fact, consumed as
 * established -- see checkHandoffs.ts's deriveHandoffDestination).
 *
 * Required/optional/prohibited are kept explicit and separate on purpose:
 * a type that is neither required nor optional is refused even if it is not
 * listed as prohibited, and `prohibited` exists to name -- visibly, for
 * review -- the recognizable types that must never travel this route, so
 * "why was my link refused" is answerable from this table alone.
 */
export interface HandoffSourceRouteContract {
  /** Source types that MUST be present on a Sources-enabled Handoff of this route. */
  readonly required: readonly HandoffSourceType[];
  /** Source types that MAY be present (at most one reference of each type). */
  readonly optional: readonly HandoffSourceType[];
  /** Source types that must NOT be present, even though they are recognizable canonical pages. */
  readonly prohibited: readonly HandoffSourceType[];
}

/**
 * The route contracts that exist today -- deliberately few. A route that is
 * not listed here has NO contract, and a Sources-enabled Handoff on an
 * uncontracted route is refused fail-closed: whether a source type may
 * travel a route is a route-contract decision, added here deliberately,
 * never inferred because some code path happened to accept it.
 *
 * - `Sales->Strategy` -- the commercial-diagnosis Handoff. Its canonical
 *   evidence record (when it has one) is an approved Call Notes record, so
 *   `call_notes` is the one optional source: present it must validate
 *   fully; absent the Handoff carries narrative evidence as before.
 *   `handoffs` is prohibited: a Handoff is never evidence for another
 *   Handoff, and a self/cycle reference would make evidence unresolvable.
 */
export const HANDOFF_SOURCE_ROUTE_CONTRACTS: Readonly<Record<string, HandoffSourceRouteContract>> = {
  "Sales->Strategy": {
    required: [],
    optional: ["call_notes"],
    prohibited: ["handoffs"],
  },
};

/** The route key a contract lookup uses -- the Handoff's own recorded From/To Unit. */
export function handoffSourceRouteKey(fromUnit: string, toUnit: string): string {
  return `${fromUnit.trim()}->${toUnit.trim()}`;
}

export function handoffSourceRouteContract(fromUnit: string, toUnit: string): HandoffSourceRouteContract | undefined {
  return HANDOFF_SOURCE_ROUTE_CONTRACTS[handoffSourceRouteKey(fromUnit, toUnit)];
}

/** Extracts a Notion property's rich-text items in the shapes both the read (plain_text/href) and write (text.link) representations use. */
function richTextItems(value: unknown): Array<{ text?: { link?: { url?: unknown } }; plain_text?: unknown; href?: unknown }> {
  const v = value as { rich_text?: unknown[] } | undefined;
  return Array.isArray(v?.rich_text) ? (v!.rich_text as any) : [];
}

export type NotionPageLink =
  | { ok: true; pageId: string }
  | { ok: false; reason: string };

/** Formats a 32-hex page id as Notion's dashed UUID representation. */
function formatPageId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parses ONE direct Notion PAGE link into its exact page id.
 *
 * Fail closed on every shape that is not an exact page link:
 *
 *   - not a URL at all, or a non-Notion host;
 *   - a database/data-source/view link (`/database/...`, `/data_source/...`,
 *     or the `?v=` database-view parameter) -- a database link is not a page
 *     link, and accepting one would re-open exactly the "which record did
 *     the sender mean" ambiguity this property exists to remove;
 *   - no 32-hex page id anywhere in the path.
 *
 * It never searches, never guesses, and never resolves by title.
 */
export function parseNotionPageLink(raw: string): NotionPageLink {
  const value = (raw ?? "").trim();
  if (!value) {
    return { ok: false, reason: "an empty Sources entry is not a page link." };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not a URL, so it cannot name an exact page.` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not an http(s) Notion page link.` };
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "notion.so" && !host.endsWith(".notion.so")) {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not a notion.so page link -- only exact canonical Notion pages may be sources.` };
  }
  const path = parsed.pathname;
  if (/(^|\/)(database|data_source|view)(\/|$)/i.test(path)) {
    return { ok: false, reason: `"${value.slice(0, 120)}" is a database/data-source/view link, not a direct page link -- name the exact canonical page.` };
  }
  if (parsed.searchParams.has("v")) {
    return { ok: false, reason: `"${value.slice(0, 120)}" carries the ?v= database-view parameter, which identifies a database view rather than an exact page.` };
  }
  // An id-shaped run, either Notion's dashed UUID form or a bare 32-hex id.
  // The boundaries matter: a name-slug may itself end in hex-looking letters
  // ("Acme-" ends in 'e'), so stripping dashes before matching would let the
  // slug bleed into the id and produce a shifted, wrong page id. Requiring a
  // non-alphanumeric neighbour on each side (or the path boundary) means only
  // a standalone id ever matches.
  const idShape = /(?<![0-9a-z])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-z])/gi;
  const hexRuns = (path.match(idShape) ?? []).map((m) => m.replace(/-/g, ""));
  if (hexRuns.length === 0) {
    return { ok: false, reason: `"${value.slice(0, 120)}" contains no Notion page id, so it cannot be resolved to an exact page.` };
  }
  // The page id is the last id-shaped run in the path (a name-slug precedes
  // it in notion.so's pretty URLs; a bare id URL has exactly one).
  return { ok: true, pageId: formatPageId(hexRuns[hexRuns.length - 1].toLowerCase()) };
}

export type HandoffSourceExtraction =
  | { ok: true; mode: "legacy" }
  | { ok: true; mode: "sources"; pageIds: string[] }
  | { ok: false; reason: string };

/**
 * Reads the Handoff's own `Sources` property, if it has one.
 *
 * `legacy` (no fetches, no validation) is the compatibility seam: the live
 * Handoffs database has no `Sources` property, so every existing Handoff
 * reads back legacy and its consumers behave exactly as before. A PRESENT
 * property turns the Sources path on and must carry at least one direct
 * page link; duplicate references to the same page are refused right here
 * (before any fetch), as a duplicate is a conflicting reference by
 * construction.
 */
export function extractHandoffSources(properties: NotionProperties | undefined): HandoffSourceExtraction {
  const prop = (properties as Record<string, unknown> | undefined)?.[HANDOFF_SOURCES_PROPERTY];
  if (prop === undefined || prop === null) {
    return { ok: true, mode: "legacy" };
  }
  const urls: string[] = [];
  for (const item of richTextItems(prop)) {
    const linked = (item.text?.link?.url ?? item.href) as unknown;
    if (typeof linked === "string" && linked.trim()) {
      urls.push(linked.trim());
      continue;
    }
    const text = typeof item.plain_text === "string" ? item.plain_text.trim() : "";
    if (/^https?:\/\//i.test(text)) urls.push(text);
  }
  if (urls.length === 0) {
    return {
      ok: false,
      reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property is present but carries no link -- a Sources-enabled Handoff must reference at least one exact canonical page, and nothing is inferred to fill the gap.`,
    };
  }
  const pageIds: string[] = [];
  for (const url of urls) {
    const link = parseNotionPageLink(url);
    if (!link.ok) {
      return { ok: false, reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries an unusable reference: ${link.reason}` };
    }
    if (pageIds.includes(link.pageId)) {
      return {
        ok: false,
        reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property references page ${link.pageId} more than once -- duplicate references are refused rather than de-duplicated.`,
      };
    }
    pageIds.push(link.pageId);
  }
  return { ok: true, mode: "sources", pageIds };
}

/** A validated canonical Call Notes source: which approved record the link names, and the evidence of its approval. */
export interface ResolvedCallNotesSource {
  pageId: string;
  callNotesId: string;
  /** The record's lifecycle Status as read from the page itself. */
  status: string;
  record: CallNotesApprovalRecord;
  attestation: RecordApprovalAttestation;
  page: NotionPage;
}

export interface ResolvedHandoffSourceRef {
  type: HandoffSourceType;
  pageId: string;
}

export type HandoffSourcesResolution =
  | { ok: true; mode: "legacy" }
  | {
      ok: true;
      mode: "sources";
      sources: ResolvedHandoffSourceRef[];
      /** The one validated canonical Call Notes source, when the Handoff carries one. */
      callNotes?: ResolvedCallNotesSource;
    }
  | { ok: false; reason: string };

/** Maps a page's REAL parent data source (read back from Notion) to its canonical source type. */
function handoffSourceTypeForDataSource(env: Env, dataSourceId: string): HandoffSourceType | null {
  const pairs: Array<[HandoffSourceType, string | undefined]> = [
    ["entities", env.ENTITY_DATA_SOURCE_ID],
    ["matters", env.MATTERS_DATA_SOURCE_ID],
    ["proposals", env.PROPOSALS_DATA_SOURCE_ID],
    ["handoffs", env.HANDOFFS_DATA_SOURCE_ID],
    ["leads", env.LEADS_DATA_SOURCE_ID],
    ["activity_log", env.ACTIVITY_LOG_DATA_SOURCE_ID],
    ["call_notes", env.CALL_NOTES_DATA_SOURCE_ID],
  ];
  const match = pairs.find(([, id]) => id && id === dataSourceId);
  return match ? match[0] : null;
}

/**
 * Validates one fetched source page against its own type's contract. The
 * type was already determined from the page's REAL parent data source and
 * permitted by the route contract; this is the per-type substance.
 *
 * Types with no implemented validation refuse rather than pass: a route
 * contract that names a type before its validation exists would otherwise
 * accept an unvalidated source, which is exactly the weakening this
 * resolver exists to prevent.
 */
async function validateSourcePage(
  type: HandoffSourceType,
  page: NotionPage,
  binding: { entityId: string; matterId: string; entityToken: string; matterToken: string },
): Promise<{ ok: true; callNotes?: ResolvedCallNotesSource } | { ok: false; reason: string }> {
  switch (type) {
    case "call_notes": {
      const entityRelations = relationIds(page.properties?.Entity);
      if (entityRelations.length !== 1 || entityRelations[0] !== binding.entityId) {
        return {
          ok: false,
          reason: `Call Notes source ${page.id} carries Entity relation [${entityRelations.join(", ") || "none"}] but the Handoff's Entity resolves to ${binding.entityId} -- the source is not bound to this Handoff's Entity.`,
        };
      }
      const matterRelations = relationIds(page.properties?.Matter);
      if (matterRelations.length !== 1 || matterRelations[0] !== binding.matterId) {
        return {
          ok: false,
          reason: `Call Notes source ${page.id} carries Matter relation [${matterRelations.join(", ") || "none"}] but the Handoff's Matter resolves to ${binding.matterId} -- the source is not bound to this Handoff's Matter.`,
        };
      }
      const status = plainText(page.properties?.Status);
      if (status !== "Ready" && status !== "Consumed") {
        return {
          ok: false,
          reason: `Call Notes source ${page.id} reports Status "${status || "(empty)"}" -- only Ready or Consumed carries current approved evidence (this resolver never writes, so Consumed remains readable exactly as Strategy's legacy retrieval accepts it).`,
        };
      }
      const registry = readApprovalRecord(page, binding.entityToken, binding.matterToken);
      if (!registry.ok) {
        return { ok: false, reason: `Call Notes source ${page.id} cannot carry a checkable approval: ${registry.reason}` };
      }
      const attestation = await parseRecordApprovalMarker(
        plainText(page.properties?.["Approval Attestation"]),
        registry.record,
      );
      if (!attestation.ok) {
        return { ok: false, reason: `Call Notes source ${page.id} does not carry a valid recorded approval attestation: ${attestation.reason}` };
      }
      return {
        ok: true,
        callNotes: {
          pageId: page.id,
          callNotesId: registry.record.callNotesId,
          status,
          record: registry.record,
          attestation: attestation.attestation,
          page,
        },
      };
    }
    case "matters": {
      const matterToken = uniqueId(page.properties?.Matter_ID);
      if (!matterToken || matterToken !== binding.matterToken) {
        return {
          ok: false,
          reason: `Matter source ${page.id} carries Matter_ID "${matterToken || "(empty)"}" but this Handoff's Matter_Token is "${binding.matterToken}" -- the source is not this Handoff's Matter.`,
        };
      }
      const entityRelations = relationIds(page.properties?.Entity);
      if (entityRelations.length !== 1 || entityRelations[0] !== binding.entityId) {
        return {
          ok: false,
          reason: `Matter source ${page.id} is not related to the Entity page this Handoff's Entity_Token resolves to (${binding.entityId}).`,
        };
      }
      return { ok: true };
    }
    case "entities": {
      const entityToken = uniqueId(page.properties?.Entity_ID);
      if (!entityToken || entityToken !== binding.entityToken) {
        return {
          ok: false,
          reason: `Entity source ${page.id} carries Entity_ID "${entityToken || "(empty)"}" but this Handoff's Entity_Token is "${binding.entityToken}" -- the source is not this Handoff's Entity.`,
        };
      }
      return { ok: true };
    }
    default:
      return {
        ok: false,
        reason: `a ${type} page was referenced as a Handoff source, but no per-type source validation is implemented for ${type} -- refusing rather than accepting an unvalidated source.`,
      };
  }
}

/**
 * The one resolution entry point. Reads the Handoff's own properties
 * (the `Sources` property, the recorded From/To Unit, the tokens) and
 * resolves every reference to an exactly-fetched, validated canonical page
 * -- or returns `legacy` when the property is absent, or a refusal.
 *
 * Consumers keep their own evidence/lifecycle semantics on top of this:
 * Sales's consume path still requires `Ready` before transitioning, and
 * Strategy still reads the page body only after this resolution succeeded.
 * This resolver adds no write of any kind.
 */
export async function resolveHandoffSources(
  env: Env,
  input: {
    properties: NotionProperties;
    tokens: { entityToken: string; matterToken: string };
    route: { fromUnit: string; toUnit: string };
    access: AccessContext;
    /**
     * Test seam, following the same pattern as
     * `discoverPendingSalesHandoffsForUnit(declaration)` and
     * `unitsWithHandoffPickup(manifests)`: a contract table to resolve
     * against instead of the production one, so the generic route-contract
     * machinery (required sources, per-type validation of `matters` /
     * `entities` sources) can be exercised without a production route that
     * permits those types. Production callers never pass it; omitting it
     * resolves against `HANDOFF_SOURCE_ROUTE_CONTRACTS` exactly as
     * production does.
     */
    contracts?: Readonly<Record<string, HandoffSourceRouteContract>>;
  },
): Promise<HandoffSourcesResolution> {
  const refuse = (detail: string): HandoffSourcesResolution => ({ ok: false, reason: detail });

  const extraction = extractHandoffSources(input.properties);
  if (!extraction.ok) return refuse(extraction.reason);
  if (extraction.mode === "legacy") return { ok: true, mode: "legacy" };

  const contract = (input.contracts ?? HANDOFF_SOURCE_ROUTE_CONTRACTS)[handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)];
  if (!contract) {
    return refuse(
      `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property is present, but route "${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)}" has no Handoff source route contract -- which sources may travel a route is an explicit contract decision, so an uncontracted route is refused rather than guessed.`,
    );
  }

  // Binding targets first: a Handoff whose own tokens do not resolve has no
  // Entity/Matter for any source to be checked against, so every reference
  // would be unverifiable -- report that rather than dressing it up as a
  // source-specific problem.
  const resolved = await resolveEntityMatterFromTokens(env, input.tokens.entityToken, input.tokens.matterToken);
  if (!resolved) {
    return refuse(
      `the Handoff's Entity_Token "${input.tokens.entityToken || "(empty)"}" / Matter_Token "${input.tokens.matterToken || "(empty)"}" did not resolve to a real, related Entity/Matter record, so no source reference's bindings can be verified -- without that check any page would do.`,
    );
  }
  const binding = {
    entityId: resolved.entityId,
    matterId: resolved.matterId,
    entityToken: input.tokens.entityToken.trim(),
    matterToken: input.tokens.matterToken.trim(),
  };

  const sources: ResolvedHandoffSourceRef[] = [];
  let callNotes: ResolvedCallNotesSource | undefined;

  for (const pageId of extraction.pageIds) {
    // The EXACT page, fetched by id through the governed read path (Access
    // evaluates it against the page's real data source). No search, no
    // title match, no second pass with a looser filter.
    let page: NotionPage;
    try {
      page = await getPage(env, pageId, input.access);
    } catch (err) {
      return refuse(
        `source page ${pageId} could not be read (${err instanceof Error ? err.message : String(err)}) -- an inaccessible source is refused, never approximated by another record.`,
      );
    }
    if (page.archived || page.inTrash) {
      return refuse(`source page ${pageId} is archived or in the trash -- only a live canonical record may be a source.`);
    }
    const dataSourceId = page.parent?.type === "data_source_id" ? page.parent.data_source_id : undefined;
    if (!dataSourceId) {
      return refuse(`source page ${pageId} is not a row of a canonical database (parent type "${page.parent?.type ?? "none"}") -- only canonical records may be sources.`);
    }
    const type = handoffSourceTypeForDataSource(env, dataSourceId);
    if (!type) {
      return refuse(`source page ${pageId} lives in data source ${dataSourceId}, which is not one of ENIG's canonical source databases -- refused rather than treated as an unnamed source.`);
    }
    if (contract.prohibited.includes(type)) {
      return refuse(`source page ${pageId} is a ${type} page, and ${type} sources are prohibited on route ${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)} by the route contract.`);
    }
    if (!contract.required.includes(type) && !contract.optional.includes(type)) {
      return refuse(
        `source page ${pageId} is a ${type} page, which is neither required nor optional on route ${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)} -- the route contract does not permit ${type} sources.`,
      );
    }
    // One reference of each type: the Handoff's Entity/Matter are singular,
    // so two pages of one type cannot both be "the" reference -- they are
    // conflicting references, refused rather than arbitrated.
    if (sources.some((s) => s.type === type)) {
      return refuse(`the Handoff references more than one ${type} page -- which one is the source is ambiguous, so none is accepted.`);
    }
    const validated = await validateSourcePage(type, page, binding);
    if (!validated.ok) return refuse(validated.reason);
    sources.push({ type, pageId });
    if (validated.callNotes) callNotes = validated.callNotes;
  }

  for (const required of contract.required) {
    if (!sources.some((s) => s.type === required)) {
      return refuse(`route ${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)} requires a ${required} source and the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries none -- a mandatory source is never substituted from narrative text or a free-text reference.`);
    }
  }

  // Free-text consistency: the legacy `Call_Notes_ID` reference convention
  // still exists in Reason/Handoff free text, and both must agree when both
  // are present. The canonical page is the authority here; the free-text
  // reference is checked against it and is never used as a fallback.
  const reference = extractCallNotesReference(input.properties);
  if (reference.ok) {
    if (!callNotes) {
      return refuse(
        `the Handoff's free text records Call_Notes_ID "${reference.callNotesId}", but its ${HANDOFF_SOURCES_PROPERTY} property carries no canonical Call Notes page -- with the Sources path enabled the canonical page is the authoritative reference, and the free-text id is never used as a fallback for it.`,
      );
    }
    if (callNotes.callNotesId !== reference.callNotesId) {
      return refuse(
        `the Handoff's free text records Call_Notes_ID "${reference.callNotesId}" but its ${HANDOFF_SOURCES_PROPERTY} property references Call Notes record "${callNotes.callNotesId}" -- conflicting references, so which record is the source is ambiguous and nothing is consumed.`,
      );
    }
  } else if (mentionsCallNotesReference(input.properties)) {
    // The free-text transport is PRESENT but broken (empty, malformed, or
    // itself conflicting across the two fields) right beside a Sources
    // property. Two transports that disagree about the same reference is a
    // conflict, and a conflict is refused rather than resolved by letting
    // one of them silently win -- the Sources page cannot be said to back a
    // reference that was never legibly written.
    return refuse(
      `the Handoff's free text carries a Call_Notes_ID reference that cannot be used beside its ${HANDOFF_SOURCES_PROPERTY} property (${reference.reason}) -- conflicting or unusable transports for the same reference are refused rather than resolved by letting one silently win.`,
    );
  }

  return { ok: true, mode: "sources", sources, ...(callNotes ? { callNotes } : {}) };
}
