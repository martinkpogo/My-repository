import type { Env } from "./types";
import { getPage, plainText, relationIds, uniqueId, type NotionPage, type NotionProperties } from "./notion";
import type { AccessContext, GovernedSource } from "./access";
import { resolveEntityMatterFromTokens } from "./identityResolution";
import { extractCallNotesReference, mentionsCallNotesReference, readApprovalRecord } from "./records/callNotes/callNotesReference";
import { parseRecordApprovalMarker, type CallNotesApprovalRecord, type RecordApprovalAttestation } from "./records/callNotes/callNotesMarker";
import { extractDocText, getValidGoogleAccessToken, getWatchedGoogleDoc, getWatchedGoogleSheet } from "./googleOAuth";
import { getSessionStub } from "./sessionRouting";

/**
 * Runtime resolution of a Handoff's `Sources` rich-text property: direct
 * links to exact canonical artifacts -- Notion pages fetched BY PAGE ID,
 * and (since Phase 2) exact Google Docs -- each validated against the route
 * contract, the artifact's own binding to this Handoff's Entity/Matter, its
 * lifecycle state, and -- where the source type has one -- its recorded
 * approval attestation.
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
 * **Compatibility seam (activation by property presence).** The path is
 * activated per-Handoff by the PRESENCE of the property on the record:
 * `extractHandoffSources` returns `legacy` when the property is absent.
 * Absent `Sources` is NOT a blanket licence for consumers to keep going as
 * before: `resolveHandoffSources` applies the route contract to that case
 * first, and a route that requires an Entity/Matter -- an uncontracted
 * route, or one whose contract requires a token or lists an
 * `entities`/`matters` artifact as required or optional -- refuses it
 * outright, with no fetch. Only a route whose contract declares generic
 * handling AND requires no source artifact accepts a Handoff with no
 * `Sources`: a `required` entry can only be supplied from inside the
 * property, so an absent property never bypasses one, and such a route's
 * required-artifact check refuses instead of returning legacy mode. When
 * it is accepted it
 * establishes NO identity: the binding is the empty pair, nothing is read
 * from the retired `Entity_Token`/`Matter_Token` columns, and nothing is
 * inferred to fill the gap. On such a route a consumer's existing
 * behaviour is unchanged -- `src/records/callNotes/callNotesRecord.ts`
 * still runs the free-text `Call_Notes_ID` reference convention exactly as
 * it always did. When the property IS present, this resolver governs and
 * the legacy free-text reference is never a fallback -- a Sources-enabled
 * Handoff whose references do not validate, or whose binding cannot be
 * established, is refused outright rather than resolved half-way. Nothing
 * here writes to Notion: the single governed writer (src/handoffWriter.ts,
 * Phase 2) owns the write side, and the resolver reads whatever the record
 * actually carries.
 *
 * **What is validated, and where.** Source types come from the page's REAL
 * parent database (read back from Notion by `getPage`, never from the URL's
 * appearance or from anything the caller claims). The route contract
 * (`HANDOFF_SOURCE_ROUTE_CONTRACTS`, keyed by the Handoff's own recorded
 * `From Unit`/`To Unit`) declares which types are required, optional, or
 * prohibited for that route -- explicitly, so "what may travel this route"
 * is one reviewable table rather than behaviour implied by code paths.
 * Per-type validation then runs: for `call_notes`, the canonical Call Notes
 * record's Entity/Matter relations must be exactly the pages this Handoff's
 * VALIDATED binding names (the binding is derived ONLY from the opaque
 * token pair its own `Sources` payload declares, resolved through the
 * authorized operational stores -- canonical `entities`/`matters` pages
 * it also declares are cross-checked against that binding, never used to
 * produce one), its Status must be one that
 * carries approved
 * current evidence, its registry fields must be readable, and its
 * `Approval Attestation` must re-parse against those exact fields (the
 * same `parseRecordApprovalMarker` the legacy query path validates -- no
 * new approval mechanism; the marker format, including its six-field
 * `fields_hash` after the 2026-10-17 canonical-schema alignment, is owned
 * by `src/records/callNotes/callNotesMarker.ts`).
 *
 * **Google sources bind through registration, never through access (Phase
 * 2).** A `Sources` entry may also name an exact Google Doc
 * (`docs.google.com/document/d/<file-id>/...`) or Google Sheet
 * (`docs.google.com/spreadsheets/d/<file-id>/...`). The URL identifies the
 * FILE; it proves nothing about the relationship. Validation order for a
 * Google reference: the route contract must permit the type; the exact file
 * must be found in this Worker's own watch registry
 * (`google_doc_watch:`/`google_sheet_watch:` -- the trusted server-side
 * registration records written only for files this system itself created);
 * for a Doc, its recorded proposal/Work binding must resolve, through that
 * Work's persisted state, to exactly this Handoff's Matter (and Entity, when
 * the Work recorded one) -- account access, a title, or a mention of a
 * token in file content is NEVER treated as proof of the relationship; the
 * file's actual type is then verified through the authorized Drive API
 * (never assumed from the URL); and only after all of that passes may the
 * Doc's content be read, read-only, through the Docs API
 * (`readGoogleDocSourceContent`). A Google Sheet is parsed and refused: the
 * watched-sheet registration carries account identity only -- no
 * proposal/Work/Entity/Matter binding and no declared bounded worksheet
 * range -- so no trusted relationship and no safe read scope can be
 * established for it today, and the refusal names exactly that missing
 * contract rather than reading every tab of an unbounded spreadsheet.
 *
 * **Managed import cycle (the same discipline as src/access.ts).** This
 * module imports `googleOAuth.ts` (watch registry + Google API access),
 * which transitively imports the Unit registry, which transitively imports
 * this module through the Units' evidence paths. The cycle is therefore
 * real and deliberate: every reference to a googleOAuth binding here
 * happens strictly inside a function body at call time, never at module
 * initialization, so module-evaluation order cannot dereference an
 * unfinished binding. The same rule the registry build already follows.
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
 * never re-performed here. What DOES come from here is the attestation's
 * operational Entity/Matter binding on the receiving side: the tokens
 * `parseSourceBoundaryMarker` binds a recorded marker to are the ones this
 * resolution proved from the payload's own declared token entries, never a
 * value a consumer read off the record for itself, never one taken from a
 * canonical page, and never one taken from a retired Handoff token
 * property (those no longer exist). A Handoff on the compatibility path --
 * no `Sources`, and only where its route contract permits that -- proves
 * no binding at all, so it carries empty token values rather than a
 * substitute.
 *
 * **Fail closed, always.** Every failure mode returns
 * `{ ok: false, reason }` with a non-sensitive reason. There is no partial
 * success, no "use what validated", and no fallback to titles, narrative
 * text, inferred identity, or database searches.
 */

/** The Handoff property this module resolves. */
export const HANDOFF_SOURCES_PROPERTY = "Sources";

/**
 * The source types a `Sources` reference can name. Two families, kept
 * explicit: the governed canonical Notion databases (reusing access.ts's
 * GovernedSource vocabulary, so a Notion reference's type is decided by the
 * same mapping Access uses, from the page's REAL parent data source -- never
 * from the URL), and the two governed Google artifact types (whose type is
 * claimed by the URL's shape and then RE-VERIFIED against the file's actual
 * mimeType through the authorized Drive API before any content is read).
 */
export type GoogleHandoffSourceType = "google_doc" | "google_sheet";

export type HandoffSourceType = GovernedSource | GoogleHandoffSourceType;

/**
 * One extracted reference, before any fetch. A Notion reference carries
 * only its page id (its TYPE is never taken from the URL -- it is decided
 * from the page's real parent data source at resolution). A Google
 * reference carries the type its URL claims plus the exact file id; that
 * claim is verified against the Drive API at resolution. A token reference
 * carries an OPAQUE operational Entity/Matter token -- the Handoff's
 * identity transport since the token properties were retired -- never a
 * page, never a title, never a lookup the runtime performs beyond the
 * authorized operational stores (see `parseHandoffSourceToken`).
 */
export type HandoffSourceRef =
  | { kind: "notion"; pageId: string }
  | { kind: "google"; type: GoogleHandoffSourceType; fileId: string }
  | { kind: "token"; tokenKind: HandoffSourceTokenKind; token: string };

/** Which operational record an opaque token names. */
export type HandoffSourceTokenKind = "entity" | "matter";

/**
 * The exact syntax an opaque operational token must have to be accepted
 * from a `Sources` payload: ENIG's own token shape (the same
 * `PREFIX-NUMBER` form `resolveEntityMatterFromTokens` and every direct
 * request path already require), validated here so a token entry can never
 * smuggle free text, a title, or an identity-bearing value into the
 * identity transport. The value is preserved EXACTLY; nothing is trimmed
 * past the entry boundaries, case-folded, or re-spelled.
 */
export const HANDOFF_SOURCE_TOKEN_SHAPE = /^([A-Z]{1,6}-\d{1,6})$/;

/**
 * The `Sources` text prefix that marks one rich-text item as an opaque
 * operational token rather than an artifact URL. It is what makes the two
 * entry kinds distinguishable with NO fetch, NO title lookup, and NO
 * inference: an artifact entry is always a link (or http(s) text) naming an
 * exact page/file, a token entry is always this prefix plus one token, and
 * anything else is refused as unusable rather than guessed at.
 */
export const HANDOFF_SOURCE_TOKEN_PREFIX = "token";

/** The canonical `Sources` text for one opaque token entry, e.g. `token:entity:ENT-28`. */
export function handoffSourceTokenText(kind: HandoffSourceTokenKind, token: string): string {
  return `${HANDOFF_SOURCE_TOKEN_PREFIX}:${kind}:${token}`;
}

export type HandoffSourceTokenParse =
  | { ok: true; tokenKind: HandoffSourceTokenKind; token: string }
  | { ok: false; reason: string };

/**
 * Parses ONE `Sources` text item as an opaque token entry. Returns
 * `{ ok: false }` with a precise reason for every shape that is not exactly
 * `token:<entity|matter>:<TOKEN>` with a syntactically valid token. A caller
 * uses this only for items it has already decided are token-shaped (the
 * prefix is what decides that); it never guesses which kind a malformed
 * entry was "meant" to be.
 */
export function parseHandoffSourceToken(raw: string): HandoffSourceTokenParse {
  const value = (raw ?? "").trim();

  // Normalize by removing backslashes - handles both escaped and unescaped tokens
  const normalizedValue = value.replace(/\\:/g, ':');

  const match = /^token:(entity|matter):(.+)$/.exec(normalizedValue);
  if (!match) {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not an opaque token entry (expected token:entity:<TOKEN> or token:matter:<TOKEN>).` };
  }
  const tokenKind = match[1] as HandoffSourceTokenKind;
  const token = match[2].trim();
  if (!HANDOFF_SOURCE_TOKEN_SHAPE.test(token)) {
    return {
      ok: false,
      reason: `"${value.slice(0, 120)}" carries "${token.slice(0, 120)}", which is not a syntactically valid opaque ${tokenKind} token (expected PREFIX-NUMBER).`,
    };
  }
  return { ok: true, tokenKind, token };
}

/**
 * A route contract: what may, must, and must not travel a Handoff route as
 * a `Sources` reference. Keyed by the Handoff's own recorded
 * `From Unit`/`To Unit` (a Handoff's destination is a fact, consumed as
 * established -- see checkHandoffs.ts's deriveHandoffDestination).
 *
 * **Token requirements and artifact requirements are separate, on purpose.**
 * A route's operational identity (WHICH Entity/Matter this Handoff is about)
 * is expressed by `requiresEntityToken`/`requiresMatterToken` and carried as
 * opaque token entries in `Sources`. A route's evidence/artifact needs are
 * expressed by `required`/`optional`/`prohibited`, which govern only
 * canonical page and Google file references. The two are never conflated:
 * a canonical `entities`/`matters` PAGE is an artifact reference that must
 * agree with the token-derived binding, never the thing that ESTABLISHES
 * identity merely by being present. That separation is what lets a route
 * require identity without requiring any particular artifact page, and lets
 * a declared generic route require neither.
 *
 * Required/optional/prohibited are kept explicit and separate on purpose:
 * a type that is neither required nor optional is refused even if it is not
 * listed as prohibited, and `prohibited` exists to name -- visibly, for
 * review -- the recognizable types that must never travel this route, so
 * "why was my link refused" is answerable from this table alone.
 */
export interface HandoffSourceRouteContract {
  /**
   * Whether this route REQUIRES an opaque Entity token entry in `Sources`.
   * A Handoff on such a route that carries no Entity token is refused; one
   * that carries two is refused as ambiguous. A route that does not require
   * an Entity token REFUSES an Entity token entry outright: the route does
   * not deal in Entity identity, so one arriving is a contract violation,
   * never something to quietly ignore.
   */
  readonly requiresEntityToken: boolean;
  /** The Matter-side counterpart of `requiresEntityToken`. */
  readonly requiresMatterToken: boolean;
  /**
   * Artifact source types that MUST be present on a Sources-enabled
   * Handoff of this route. Governed independently of the token
   * requirements above: these are canonical evidence references, never the
   * identity transport.
   */
  readonly required: readonly HandoffSourceType[];
  /** Artifact source types that MAY be present (at most one reference of each type). */
  readonly optional: readonly HandoffSourceType[];
  /** Artifact source types that must NOT be present, even though they are recognizable canonical pages. */
  readonly prohibited: readonly HandoffSourceType[];
}

/**
 * The route contracts that exist today -- deliberately few. A route that is
 * not listed here has NO contract, and a Sources-enabled Handoff on an
 * uncontracted route is refused fail-closed: whether a source type may
 * travel a route is a route-contract decision, added here deliberately,
 * never inferred because some code path happened to accept it.
 *
 * - `Sales->Strategy` -- the commercial-diagnosis Handoff. This route needs
 *   an Entity and a Matter (the diagnosis is about one Matter of one
 *   Entity), so both tokens are REQUIRED and carried as opaque `Sources`
 *   token entries. `call_notes` is OPTIONAL: present it must validate fully
 *   against the token-derived binding (its own Entity/Matter relations, its
 *   lifecycle Status, its registry fields, and its re-parsed Approval
 *   Attestation); absent the Handoff carries narrative evidence as before.
 *   `entities`/`matters` PAGES are OPTIONAL artifact references here -- a
 *   producer may additionally name the canonical pages, which are then
 *   fetched and cross-checked against the token binding, but their absence
 *   costs the route nothing because identity never depended on them.
 *   `handoffs` is prohibited: a Handoff is never evidence for another
 *   Handoff, and a self/cycle reference would make evidence unresolvable.
 *
 * - `Strategy->Finance` -- the value-based quote request Martin's approval
 *   of a Strategy intervention commits. This route is NOT generic and
 *   requires both tokens outright: the quote is priced for one Matter of
 *   one Entity, and a Sources-enabled Handoff of this route may never
 *   travel without an opaque, syntactically valid Entity/Matter token pair
 *   that resolves (through the authorized operational stores) to real,
 *   correctly-related records -- resolution refuses one carrying either
 *   missing, unresolvable, or contradictory. `call_notes` is OPTIONAL and
 *   carries the upstream Sales -> Strategy Handoff's own canonical Call
 *   Notes reference, forwarded by the Strategy producer when (and only
 *   when) that reference exists and re-validates on its own route -- the
 *   same exact canonical page -- so Finance can resolve the same approved
 *   record the diagnosis was grounded in. Absent, the Handoff carries the
 *   Strategy boundary representation and the upstream commercial-value
 *   determination as before, and no Call Notes reference is ever fabricated
 *   to fill the gap. `entities`/`matters` PAGES are OPTIONAL artifact
 *   references, cross-checked against the token binding when present, never
 *   required for identity. `handoffs` is prohibited for the same reason as
 *   on Sales->Strategy.
 *
 * - `Finance->Sales` -- the approved-quote Draft Proposal request. Both
 *   tokens are required for the same reason as Strategy->Finance: Sales
 *   must know exactly which Matter and Entity the quote prices. No artifact
 *   source is required or permitted today beyond the tokens, so the
 *   contract permits no optional artifact type (a future producer that has
 *   a canonical artifact to forward adds it here deliberately).
 *
 * - `Strategy->Marketing` / `Strategy->Sales` -- the Martin-approved routing
 *   of a completed Strategy diagnosis to another Unit. Both tokens are
 *   required for exactly the reason the retired `Entity_Token`/`Matter_Token`
 *   writes on these two routes carried: a diagnosis is about one Matter of
 *   one Entity, and both the receiving Unit's pickup and the Work created
 *   from it need that binding. These entries exist so removing the retired
 *   property writes costs these routes NOTHING -- the same identity, on the
 *   one sanctioned transport, with the same discovery, pickup and binding
 *   behaviour as before. No artifact source is declared for them today.
 *
 * A route whose contract requires neither token and neither requires nor
 * permits `entities`/`matters` (see `handoffRouteRequiresEntityMatter`) is
 * a declared GENERIC route: Handoffs on it do not carry, and are never
 * forced to acquire, an Entity/Matter. No production route is declared
 * generic today -- a generic route is an explicit contract decision (a
 * `contracts` table entry naming one with both token flags false and no
 * entity/matter artifact type), never an absence of contract: an
 * uncontracted route stays what it always was, an Entity/Matter-bound
 * route refused fail-closed. Genericity is read ONLY from the contract
 * entry, never inferred from a payload whose fields happen to be absent.
 *
 * **Absence of `Sources` is a deliberate contract decision, never a
 * fallback.** A Handoff on a route that requires tokens (or a required
 * artifact) and declares no `Sources` property at all has established no
 * operational reference and is refused -- it is never treated as "legacy"
 * identity, because the separate `Entity_Token`/`Matter_Token` properties
 * are no longer read or written anywhere and carry no authority. Only a
 * route that requires neither (a declared generic route) accepts a
 * Handoff with no `Sources`, and then it accepts it as carrying no
 * binding at all -- not as carrying some identity this resolver chose to
 * read from somewhere else.
 *
 * The Google source types (`google_doc`, `google_sheet`) have their full
 * per-type validation implemented in this module, but NO production route
 * contract lists them today: which routes may carry a Google artifact is a
 * route-contract governance decision (recorded in docs/enig-operating-model.md's
 * Open questions), added here deliberately, never inferred because the
 * validation happens to exist. A Sources payload naming a Google file on a
 * route that does not list its type is refused -- at the writer and at
 * resolution alike.
 */
export const HANDOFF_SOURCE_ROUTE_CONTRACTS: Readonly<Record<string, HandoffSourceRouteContract>> = {
  "Sales->Strategy": {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: ["call_notes", "entities", "matters"],
    prohibited: ["handoffs"],
  },
  "Strategy->Finance": {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: ["call_notes", "entities", "matters"],
    prohibited: ["handoffs"],
  },
  "Finance->Sales": {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: [],
    prohibited: ["handoffs"],
  },
  "Strategy->Marketing": {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: [],
    prohibited: ["handoffs"],
  },
  "Strategy->Sales": {
    requiresEntityToken: true,
    requiresMatterToken: true,
    required: [],
    optional: [],
    prohibited: ["handoffs"],
  },
};

/** The route key a contract lookup uses -- the Handoff's own recorded From/To Unit. */
export function handoffSourceRouteKey(fromUnit: string, toUnit: string): string {
  return `${fromUnit.trim()}->${toUnit.trim()}`;
}

export function handoffSourceRouteContract(
  fromUnit: string,
  toUnit: string,
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): HandoffSourceRouteContract | undefined {
  return (contracts ?? HANDOFF_SOURCE_ROUTE_CONTRACTS)[handoffSourceRouteKey(fromUnit, toUnit)];
}

/** The route key for a `{ fromUnit, toUnit }` route descriptor. */
function routeKeyOf(route: { fromUnit: string; toUnit: string }): string {
  return handoffSourceRouteKey(route.fromUnit, route.toUnit);
}

/**
 * Whether a Handoff travelling this route needs an Entity/Matter binding at
 * all -- the generic-route declaration, answered from the route's contract
 * alone: a route that requires neither token and neither requires nor
 * permits an `entities` or a `matters` source is a declared generic route
 * (its workflow needs no Entity/Matter, so no token entry, no source
 * reference, and no discovered Work is ever forced to acquire one). An
 * uncontracted route returns true -- nothing has declared it generic, so
 * today's behaviour (Entity/Matter required) stands. This is the ONLY
 * thing that makes a Handoff generic; there is no inference from what a
 * particular payload happens to carry.
 */
export function handoffRouteRequiresEntityMatter(
  fromUnit: string,
  toUnit: string,
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): boolean {
  const contract = (contracts ?? HANDOFF_SOURCE_ROUTE_CONTRACTS)[handoffSourceRouteKey(fromUnit, toUnit)];
  if (!contract) return true;
  const carries = (type: HandoffSourceType) => contract.required.includes(type) || contract.optional.includes(type);
  return contract.requiresEntityToken || contract.requiresMatterToken || carries("entities") || carries("matters");
}

/**
 * The canonical Entity/Matter binding a Handoff's operational context
 * resolves to: the exact page ids of the two canonical records, their
 * opaque operational tokens, and the Matter's lifecycle Status. Produced
 * ONLY by this module's resolution -- from the opaque token entries in the
 * Handoff's own `Sources` payload, resolved through the authorized
 * operational stores (`resolveEntityMatterFromTokens`, which reads the
 * canonical Matters and Entities data sources and NEVER the Isolated Sales
 * Identity Resolution Registry) -- and passed through the runtime context
 * from there, so no consumer re-resolves the Handoff's identity from
 * record properties it reads itself.
 *
 * The separate `Entity_Token`/`Matter_Token` Handoff properties are NOT
 * read or written anywhere and are not an identity authority: a Handoff
 * with no `Sources` payload has no binding, and nothing infers one.
 */
export interface HandoffSourceBinding {
  entityId: string;
  matterId: string;
  entityToken: string;
  matterToken: string;
  /** The Matter page's own lifecycle Status as read from the canonical Matter record during token resolution. */
  matterStatus: string | null;
}

/**
 * The opaque Entity/Matter token pair a `Sources` payload declares, before
 * any resolution. Both sides are optional here so extraction can report a
 * half-declared pair precisely; `resolveHandoffSources` decides per route
 * whether a missing side is a contract violation and refuses either way
 * rather than resolving half a binding.
 */
export interface HandoffSourceTokenPair {
  entityToken?: string;
  matterToken?: string;
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
 *   - not a URL at all, or a host outside the accepted set (notion.so, any
 *     notion.so subdomain, or the exact host app.notion.com);
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
  /**
   * Accepted hosts: `notion.so` and its subdomains (the long-standing
 * canonical form), plus the exact host `app.notion.com`. Notion's
 * canonical page links increasingly use `app.notion.com`, and a Handoff
 * whose `Sources` names one was refused purely for its hostname even
 * though it is the same exact-page reference. `app.notion.com` is added
 * as one EXACT host only -- no `notion.com` subdomain wildcard -- so the
 * accepted set stays closed and a lookalike host (`evil.app.notion.com`,
 * `notion.com` itself, or any other subdomain) is still refused fail-closed.
 */
  if (host !== "notion.so" && !host.endsWith(".notion.so") && host !== "app.notion.com") {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not a notion.so page link (nor an app.notion.com one) -- only exact canonical Notion pages may be sources.` };
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

export type GoogleFileLink =
  | { ok: true; fileType: GoogleHandoffSourceType; fileId: string }
  | { ok: false; reason: string };

/**
 * A Google file id: Drive's own character set (`A-Za-z0-9_-`), bounded
 * below so a truncated path segment never resolves to a "file", and bounded
 * above so a whole path cannot be swallowed as one id. Real Google file ids
 * are 33+ characters; the floor here is deliberately low enough not to
 * encode that provider detail as a contract.
 */
const GOOGLE_FILE_ID_SHAPE = /^[A-Za-z0-9_-]{10,}$/;

/**
 * Parses ONE direct Google file link into its exact file id and the type
 * its URL claims.
 *
 * Fail closed on every shape that is not a recognized direct file link:
 * not a URL, not the exact `docs.google.com` host (a lookalike host is
 * refused, never normalized into one), a path that is not
 * `/document/d/<id>` or `/spreadsheets/d/<id>` (including `/presentation/`,
 * `/forms/`, `drive.google.com/file/d/...`, and the `/u/<n>/` account
 * variants, which are refused rather than approximated), and a missing or
 * unrecognizable file id.
 *
 * The returned `fileType` is what the URL CLAIMS. Resolution re-verifies
 * the actual type through the authorized Drive API before any content is
 * read -- this parse never establishes the file's real type by itself.
 */
export function parseGoogleFileLink(raw: string): GoogleFileLink {
  const value = (raw ?? "").trim();
  if (!value) {
    return { ok: false, reason: "an empty Sources entry is not a Google file link." };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not a URL, so it cannot name an exact Google file.` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `"${value.slice(0, 120)}" is not an http(s) Google file link.` };
  }
  if (parsed.hostname.toLowerCase() !== "docs.google.com") {
    return {
      ok: false,
      reason: `"${value.slice(0, 120)}" is not a docs.google.com direct file link -- only exact Google Docs/Sheets file URLs on docs.google.com may be sources (drive.google.com share links, shortcuts, and lookalike hosts are refused, never resolved by search).`,
    };
  }
  const match = /^\/(document|spreadsheets)\/d\/([^/]+)/.exec(parsed.pathname);
  if (!match) {
    return {
      ok: false,
      reason: `"${value.slice(0, 120)}" is not a direct file link -- expected /document/d/<file-id>/ or /spreadsheets/d/<file-id>/.`,
    };
  }
  const fileId = match[2];
  if (!GOOGLE_FILE_ID_SHAPE.test(fileId)) {
    return {
      ok: false,
      reason: `"${value.slice(0, 120)}" does not carry a recognizable Google file id, so it cannot be resolved to an exact file.`,
    };
  }
  return { ok: true, fileType: match[1] === "document" ? "google_doc" : "google_sheet", fileId };
}

/**
 * One entry a runtime producer may write into a `Sources` payload, before
 * it is rendered to rich text. An `artifact` entry names one exact
 * canonical page or Google file by URL. A `token` entry carries an opaque
 * operational Entity/Matter token -- the identity transport -- never a page,
 * never a title, never an identity-bearing value.
 */
export type HandoffSourceWriteEntry =
  | { kind: "artifact"; url: string }
  | { kind: "token"; tokenKind: HandoffSourceTokenKind; token: string };

/**
 * The write shape for a `Sources` payload: one rich-text item per entry. An
 * artifact entry carries its `text.link.url`; a token entry is link-less
 * plain text in the exact `token:<kind>:<TOKEN>` form
 * (`handoffSourceTokenText`). The single sanctioned way a runtime producer
 * builds the property (the writer's extraction reads exactly these two
 * shapes), so no producer hand-assembles rich-text items and no reference
 * can be written as free text the read side would then have to guess
 * about. The two entry kinds are distinguished on read by the presence of a
 * link versus the token prefix -- deterministically, with no fetch, no title
 * lookup, and no inference.
 */
export function sourcesRichText(entries: readonly HandoffSourceWriteEntry[]): {
  rich_text: Array<{ type: "text"; text: { content: string; link?: { url: string } } }>;
} {
  return {
    rich_text: entries.map((entry) =>
      entry.kind === "token"
        ? { type: "text" as const, text: { content: handoffSourceTokenText(entry.tokenKind, entry.token) } }
        : { type: "text" as const, text: { content: entry.url, link: { url: entry.url } } },
    ),
  };
}

export type HandoffSourceExtraction =
  | { ok: true; mode: "legacy" }
  | { ok: true; mode: "sources"; refs: HandoffSourceRef[]; tokens: HandoffSourceTokenPair }
  | { ok: false; reason: string };

/**
 * Reads the Handoff's own `Sources` property, if it has one.
 *
 * `legacy` (no fetches, no validation) means the record declares NO
 * `Sources` property at all -- and it establishes NOTHING: a Handoff with no
 * `Sources` carries no operational reference, and whether its route accepts
 * that is a route-contract decision made downstream (see
 * `HANDOFF_SOURCE_ROUTE_CONTRACTS` and `resolveHandoffSources`), never a
 * fallback to some other identity transport. The separate
 * `Entity_Token`/`Matter_Token` properties are not consulted here or
 * anywhere.
 *
 * A PRESENT property must carry at least one entry -- an opaque token, an
 * exact Notion page link, or a recognized direct Google Docs/Sheets URL.
 * Anything else is refused right here, before any fetch: a text item that
 * is neither a valid token entry nor a valid artifact link is refused as
 * unusable rather than silently dropped, so a malformed or
 * identity-bearing entry can never be "treated as absent". Duplicate
 * references to the same page id or the same Google file id are refused the
 * same way (a duplicate is a conflicting reference by construction -- the
 * same file named twice through two URL shapes is still one reference
 * written twice), as is a second token of the same kind.
 */
export function extractHandoffSources(properties: NotionProperties | undefined): HandoffSourceExtraction {
  const prop = (properties as Record<string, unknown> | undefined)?.[HANDOFF_SOURCES_PROPERTY];
  if (prop === undefined || prop === null) {
    return { ok: true, mode: "legacy" };
  }
  /**
   * Each item resolves to exactly one raw entry: a linked URL (artifact), a
   * `token:`-prefixed plain-text item (token), or an http(s) plain-text item
   * (artifact, the read-side tolerance for a hand-written link). An item
   * that resolves to none of those -- non-empty text that is neither -- is
   * refused as unusable rather than skipped, so nothing a sender wrote is
   * ever silently discarded into "absent".
   */
  /**
   * Reconstruct entries from Notion's rich-text representation before
   * classification. Notion may split a single logical entry across several
   * adjacent plain-text rich-text items (and may interleave page mentions as
   * their own items), so adjacent unlinked text fragments are concatenated
   * and then split on embedded newlines to recover the intended entries.
   * Linked items and mentions stay distinct entries and are never absorbed
   * into an adjacent text run.
   */
  const rawEntries: Array<{ kind: "url"; url: string } | { kind: "token"; text: string }> = [];
  const textBuffer: string[] = [];
  const isStandaloneEntry = (text: string): boolean =>
    text.toLowerCase().startsWith(`${HANDOFF_SOURCE_TOKEN_PREFIX}:`) || /^https?:\/\//i.test(text);
  const flushTextBuffer = (): HandoffSourceExtraction | undefined => {
    const combined = textBuffer.join("");
    textBuffer.length = 0;
    for (const line of combined.split(/\n/)) {
      const text = line.trim();
      if (!text) continue;
      if (text.toLowerCase().startsWith(`${HANDOFF_SOURCE_TOKEN_PREFIX}:`)) {
        rawEntries.push({ kind: "token", text });
        continue;
      }
      if (/^https?:\/\//i.test(text)) {
        rawEntries.push({ kind: "url", url: text });
        continue;
      }
      return { ok: false, reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries an unusable entry: "${text.slice(0, 120)}" is neither an opaque token entry (${HANDOFF_SOURCE_TOKEN_PREFIX}:entity:<TOKEN> / ${HANDOFF_SOURCE_TOKEN_PREFIX}:matter:<TOKEN>) nor an http(s) link to an exact canonical artifact -- refused rather than silently treated as absent.` };
    }
  };
  for (const item of richTextItems(prop)) {
    const linked = (item.text?.link?.url ?? item.href) as unknown;
    if (typeof linked === "string" && linked.trim()) {
      const flushed = flushTextBuffer();
      if (flushed && !flushed.ok) return flushed;
      rawEntries.push({ kind: "url", url: linked.trim() });
      continue;
    }
    const content = (item.text as { content?: unknown } | undefined)?.content;
    const raw =
      typeof item.plain_text === "string"
        ? item.plain_text
        : typeof content === "string"
          ? content
          : "";
    // Normalize escaped colons consistently here, before classification, so
    // an escaped token prefix is not rejected as a fragment. parseHandoffSourceToken
    // performs the same normalization on its input (idempotent).
    const normalized = raw.replace(/\\:/g, ":");
    const text = normalized.trim();
    if (!text) continue;
    if (isStandaloneEntry(text)) {
      const flushed = flushTextBuffer();
      if (flushed && !flushed.ok) return flushed;
      if (text.toLowerCase().startsWith(`${HANDOFF_SOURCE_TOKEN_PREFIX}:`)) {
        rawEntries.push({ kind: "token", text });
      } else {
        rawEntries.push({ kind: "url", url: text });
      }
      continue;
    }
    textBuffer.push(normalized);
  }
  const flushed = flushTextBuffer();
  if (flushed && !flushed.ok) return flushed;
  if (rawEntries.length === 0) {
    return {
      ok: false,
      reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property is present but carries no entry -- a Sources-enabled Handoff must reference at least one opaque token or exact canonical artifact, and nothing is inferred to fill the gap.`,
    };
  }
  const refs: HandoffSourceRef[] = [];
  for (const entry of rawEntries) {
    if (entry.kind === "token") {
      const token = parseHandoffSourceToken(entry.text);
      if (!token.ok) {
        return { ok: false, reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries a malformed token entry: ${token.reason}` };
      }
      if (refs.some((r) => r.kind === "token" && r.tokenKind === token.tokenKind)) {
        return {
          ok: false,
          reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries more than one ${token.tokenKind} token -- which token names the Handoff's ${token.tokenKind} is ambiguous, so none is accepted.`,
        };
      }
      refs.push({ kind: "token", tokenKind: token.tokenKind, token: token.token });
      continue;
    }
    const url = entry.url;
    const notion = parseNotionPageLink(url);
    if (notion.ok) {
      if (refs.some((r) => r.kind === "notion" && r.pageId === notion.pageId)) {
        return {
          ok: false,
          reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property references page ${notion.pageId} more than once -- duplicate references are refused rather than de-duplicated.`,
        };
      }
      refs.push({ kind: "notion", pageId: notion.pageId });
      continue;
    }
    const google = parseGoogleFileLink(url);
    if (google.ok) {
      if (refs.some((r) => r.kind === "google" && r.fileId === google.fileId)) {
        return {
          ok: false,
          reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property references Google file ${google.fileId} more than once -- duplicate references are refused rather than de-duplicated.`,
        };
      }
      refs.push({ kind: "google", type: google.fileType, fileId: google.fileId });
      continue;
    }
    return {
      ok: false,
      reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries an unusable reference: "${url.slice(0, 120)}" is neither an exact Notion page link (${notion.reason}) nor a recognized direct Google Docs/Sheets file link (${google.reason})`,
    };
  }
  const tokens: HandoffSourceTokenPair = {};
  for (const ref of refs) {
    if (ref.kind !== "token") continue;
    if (ref.tokenKind === "entity") tokens.entityToken = ref.token;
    else tokens.matterToken = ref.token;
  }
  return { ok: true, mode: "sources", refs, tokens };
}

/**
 * The opaque Entity/Matter token pair a Handoff's `Sources` payload declares,
 * or an empty pair when it declares no usable payload. Deterministic and
 * fetch-free -- it is the SAME `extractHandoffSources` every other runtime
 * path uses, so there is one parser and no parallel reader. For display and
 * for pre-resolution filtering only: never an identity authority. A token
 * still has to resolve through `resolveHandoffContextBinding` (the
 * authorized operational stores) before anything acts on it, and a
 * contradictory or unverifiable payload refuses there rather than being
 * smoothed over by this read.
 */
export function declaredHandoffTokens(properties: NotionProperties | undefined): HandoffSourceTokenPair {
  const extraction = extractHandoffSources(properties);
  if (!extraction.ok || extraction.mode !== "sources") return {};
  return extraction.tokens;
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
  /** The exact identity resolved: a dashed Notion page id, or the Google file id for a `google_doc` source. */
  id: string;
}

/**
 * A validated Google Doc source: the exact file, its registered account,
 * and the proposal/Work binding its registration carries -- the hop this
 * source's Entity/Matter trust is established through (the bound Work's
 * persisted state must name exactly this Handoff's Matter). Content is NOT
 * read here; consumers read it through `readGoogleDocSourceContent`, only
 * after this resolution has passed.
 */
export interface ResolvedGoogleDocSource {
  fileId: string;
  accountIdentifier: string;
  title: string;
  proposal: { workId: string; proposalId: string; version: number };
}

/** The subset of a bound Work's persisted state the Google-source binding check needs. */
export interface BoundWorkIdentity {
  entityId?: string;
  matterId?: string;
}

export type HandoffSourcesResolution =
  | { ok: true; mode: "legacy" }
  | {
      ok: true;
      mode: "sources";
      sources: ResolvedHandoffSourceRef[];
      /**
       * The Entity/Matter binding this resolution PROVED: established
       * ONLY from the opaque `token:entity:`/`token:matter:` entries this
       * payload declares, resolved through `resolveEntityMatterFromTokens`
       * -- the canonical Matters and Entities data sources, never the
       * Isolated Sales Identity Resolution Registry -- which is also what
       * enforces the Matter->Entity relationship proof this binding
       * carries. Canonical `entities`/`matters` PAGE references the same
       * payload declares are cross-checks against that binding: they can
       * only REFUSE it for disagreeing, never establish one, stand in for
       * a missing token, or supply a token -- and no separate Handoff
       * token property is consulted, because those properties no longer
       * exist. Established means established: on a route requiring a
       * binding, a missing, half or unresolvable pair fails the whole
       * resolution closed rather than resolving half-way. The only payload
       * reaching `mode: "sources"` with an empty binding is one on a route
       * its contract declares generic, where the empty pair is the
       * deliberate, contract-permitted result -- never a gap to be filled
       * from a page link or from a retired column.
       */
      binding: HandoffSourceBinding;
      /** The one validated canonical Call Notes source, when the Handoff carries one. */
      callNotes?: ResolvedCallNotesSource;
      /** The one validated Google Doc source, when the Handoff carries one. */
      googleDoc?: ResolvedGoogleDocSource;
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
          reason: `Matter source ${page.id} carries Matter_ID "${matterToken || "(empty)"}" but this Handoff's Matter token is "${binding.matterToken}" -- the source is not this Handoff's Matter.`,
        };
      }
      const entityRelations = relationIds(page.properties?.Entity);
      if (entityRelations.length !== 1 || entityRelations[0] !== binding.entityId) {
        return {
          ok: false,
          reason: `Matter source ${page.id} is not related to the Entity page this Handoff's Entity token resolves to (${binding.entityId}).`,
        };
      }
      return { ok: true };
    }
    case "entities": {
      const entityToken = uniqueId(page.properties?.Entity_ID);
      if (!entityToken || entityToken !== binding.entityToken) {
        return {
          ok: false,
          reason: `Entity source ${page.id} carries Entity_ID "${entityToken || "(empty)"}" but this Handoff's Entity token is "${binding.entityToken}" -- the source is not this Handoff's Entity.`,
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

/** The mimeType the Drive API reports for each Google source type the URL claims. */
const GOOGLE_DRIVE_MIME_TYPES: Record<GoogleHandoffSourceType, string> = {
  google_doc: "application/vnd.google-apps.document",
  google_sheet: "application/vnd.google-apps.spreadsheets",
};

/**
 * Validates one extracted Google reference. Every step fails closed with a
 * non-sensitive reason and no write:
 *
 *   1. **Trusted registration** -- the exact file id must be found in this
 *      Worker's own watch registry, which is written only for files the
 *      system itself created (opt-in-by-creation). A file the system does
 *      not own has no binding to anything, and account access alone is
 *      never treated as a relationship.
 *   2. **Business binding** (Docs only) -- the registration's proposal/Work
 *      binding must resolve, through that Work's persisted state, to
 *      exactly this Handoff's Matter (and Entity, when the Work recorded
 *      one). No title match, no token mention in file content, no
 *      second-guessing.
 *   3. **Actual file type** -- verified through the authorized Drive API
 *      (`files.get fields=id,mimeType,trashed`), never assumed from the
 *      URL: a link that claims a Doc but resolves to another type, or to a
 *      trashed file, is refused.
 *
 * A Google Sheet is parsed but refused at step 1/2: the watched-sheet
 * registration carries account identity only -- no proposal/Work/Entity/
 * Matter binding and no declared bounded worksheet range -- so neither a
 * trusted relationship nor a safe read scope can be established for it
 * today. The refusal names that missing contract precisely; nothing about
 * a Sheet is ever read.
 */
async function validateGoogleSource(
  env: Env,
  ref: { type: GoogleHandoffSourceType; fileId: string },
  binding: { entityId: string; matterId: string },
  readBoundWorkState: (workId: string) => Promise<BoundWorkIdentity | undefined>,
): Promise<{ ok: true; googleDoc?: ResolvedGoogleDocSource } | { ok: false; reason: string }> {
  if (ref.type === "google_sheet") {
    const sheet = await getWatchedGoogleSheet(env, ref.fileId);
    if (!sheet) {
      return {
        ok: false,
        reason: `spreadsheet ${ref.fileId} is not registered by this Worker, and no trusted relationship exists between an arbitrary spreadsheet and this Handoff's Entity/Matter -- account access alone is never treated as proof of a relationship.`,
      };
    }
    return {
      ok: false,
      reason: `spreadsheet ${ref.fileId} is registered for comment polling, but the watched-sheet registration carries account identity only -- no proposal/Work/Entity/Matter binding, and no declared bounded worksheet range. No trusted relationship between this exact spreadsheet and this Handoff's Matter can be established, so the source is refused before any read: the missing contract is a registration binding the sheet to the Handoff's Entity/Matter (or another authorized canonical business record) plus a deterministic bounded range to read.`,
    };
  }

  const doc = await getWatchedGoogleDoc(env, ref.fileId);
  if (!doc) {
    return {
      ok: false,
      reason: `document ${ref.fileId} is not registered by this Worker, and no trusted relationship exists between an arbitrary Drive file and this Handoff's Entity/Matter -- account access alone is never treated as proof of a relationship.`,
    };
  }
  if (!doc.proposal) {
    return {
      ok: false,
      reason: `document ${ref.fileId} is registered, but its registration carries no proposal/Work binding, so nothing ties this exact file to an Entity/Matter -- refusing rather than inventing a binding from account access or the file's title.`,
    };
  }
  let state: BoundWorkIdentity | undefined;
  try {
    state = await readBoundWorkState(doc.proposal.workId);
  } catch (err) {
    return {
      ok: false,
      reason: `document ${ref.fileId} is bound to Work ${doc.proposal.workId}, whose state could not be read (${err instanceof Error ? err.message : String(err)}) -- an unverifiable binding is refused, never assumed.`,
    };
  }
  if (!state) {
    return {
      ok: false,
      reason: `document ${ref.fileId} is bound to Work ${doc.proposal.workId}, which no longer has readable state -- the binding to this Handoff's Entity/Matter cannot be verified.`,
    };
  }
  if (!state.matterId || state.matterId !== binding.matterId) {
    return {
      ok: false,
      reason: `document ${ref.fileId} is bound (through its registered Proposal work ${doc.proposal.workId}) to Matter ${state.matterId || "(none recorded)"} but this Handoff's Matter resolves to ${binding.matterId} -- the document is not bound to this Handoff's Matter.`,
    };
  }
  if (state.entityId && state.entityId !== binding.entityId) {
    return {
      ok: false,
      reason: `document ${ref.fileId} is bound (through its registered Proposal work ${doc.proposal.workId}) to Entity ${state.entityId} but this Handoff's Entity resolves to ${binding.entityId} -- the document is not bound to this Handoff's Entity.`,
    };
  }

  const token = await getValidGoogleAccessToken(env, doc.accountIdentifier);
  if (!token) {
    return {
      ok: false,
      reason: `the account this document is registered under holds no currently authorized Google token, so the file's actual type cannot be verified through the Drive API -- the source is refused rather than read unverified.`,
    };
  }
  let file: { id?: string; mimeType?: string; trashed?: boolean };
  try {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ref.fileId)}?fields=id,name,mimeType,trashed`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      return {
        ok: false,
        reason: `the Drive API could not verify document ${ref.fileId} (HTTP ${response.status}) -- the actual file type could not be established, so the source is refused rather than read unverified.`,
      };
    }
    file = (await response.json()) as { id?: string; mimeType?: string; trashed?: boolean };
  } catch (err) {
    return {
      ok: false,
      reason: `the Drive API could not verify document ${ref.fileId} (${err instanceof Error ? err.message : String(err)}) -- the actual file type could not be established, so the source is refused rather than read unverified.`,
    };
  }
  if (file.trashed) {
    return { ok: false, reason: `document ${ref.fileId} is in the trash -- only a live file may be a source.` };
  }
  if (file.mimeType !== GOOGLE_DRIVE_MIME_TYPES[ref.type]) {
    return {
      ok: false,
      reason: `the link claims a ${ref.type} but the Drive API reports mimeType "${file.mimeType || "(none)"}" for file ${ref.fileId} -- the actual file type is verified through the API, never assumed from the URL.`,
    };
  }
  return {
    ok: true,
    googleDoc: {
      fileId: ref.fileId,
      accountIdentifier: doc.accountIdentifier,
      title: doc.title,
      proposal: { workId: doc.proposal.workId, proposalId: doc.proposal.proposalId, version: doc.proposal.version },
    },
  };
}

/** The production binding hop: the bound Work's own Durable Object (the same cross-session read workContinuation makes). */
function defaultReadBoundWorkState(env: Env): (workId: string) => Promise<BoundWorkIdentity | undefined> {
  return async (workId) => (await getSessionStub(env, workId).getState()) as BoundWorkIdentity | undefined;
}

/**
 * The one resolution entry point. Reads the Handoff's own `Sources`
 * property and its recorded From/To Unit, and resolves every reference to
 * an exactly-fetched, validated canonical artifact -- opaque tokens through
 * the authorized operational stores, Notion pages by id, Google Docs
 * through the registration binding chain above -- or returns `legacy` when
 * the property is entirely absent (which establishes NO identity), or a
 * refusal.
 *
 * **The Entity/Matter binding comes from the opaque token entries.** The
 * Handoff's identity is the `token:entity:<TOKEN>` / `token:matter:<TOKEN>`
 * entries its `Sources` payload declares. Each pair is resolved through
 * `resolveEntityMatterFromTokens` -- the authorized operational stores
 * (canonical Matters/Entities data sources), never the Isolated Sales
 * Identity Resolution Registry and never any real-world identity mapping --
 * and a pair that does not resolve to real, correctly-related records is
 * refused. Any canonical `entities`/`matters` PAGE the Handoff also names
 * is an artifact reference that must AGREE with that token-derived binding;
 * it never establishes identity by being present, and its absence costs
 * nothing on a route that does not require it.
 *
 * The separate `Entity_Token`/`Matter_Token` Handoff properties are NOT
 * read here or anywhere: they are no longer an identity authority, so a
 * Handoff that declares no `Sources` at all carries no binding, and nothing
 * infers one from those columns.
 *
 * Consumers keep their own evidence/lifecycle semantics on top of this:
 * Sales's consume path still requires `Ready` before transitioning, and
 * Strategy still reads the canonical record's `Note` property only after
 * this resolution succeeded.
 * This resolver adds no write of any kind.
 */
export async function resolveHandoffSources(
  env: Env,
  input: {
    properties: NotionProperties;
    /**
     * Optional: the operational tokens the CALLER already holds, reconciled
     * against the tokens the `Sources` payload declares. Production callers
     * OMIT this; when passed, a contradiction between the caller's tokens
     * and the payload's tokens fails closed rather than letting one
     * transport win. It is never a substitute for a missing payload token
     * and never a fallback for one that failed to resolve.
     */
    tokens?: { entityToken: string; matterToken: string };
    route: { fromUnit: string; toUnit: string };
    access: AccessContext;
    /**
     * Test seam for the Google-source binding hop: reads the persisted
     * state of the Work a Google Doc's registration is bound to. In
     * production this resolves through that Work's own Durable Object
     * (`WorkSession.getState`, via getSessionStub -- the same
     * cross-session read `workContinuation` makes); omitting it uses that
     * production path exactly. Production callers never pass it.
     */
    readBoundWorkState?: (workId: string) => Promise<BoundWorkIdentity | undefined>;
    /**
     * Test seam, following the same pattern as
     * `discoverPendingSalesHandoffsForUnit(declaration)` and
     * `unitsWithHandoffPickup(manifests)`: a contract table to resolve
     * against instead of the production one, so the generic route-contract
     * machinery (token requirements, required sources, per-type validation
     * of `matters` / `entities` sources, and the Google source types no
     * production route permits yet) can be exercised without a production
     * route. Production callers never pass it; omitting it resolves against
     * `HANDOFF_SOURCE_ROUTE_CONTRACTS` exactly as production does.
     */
    contracts?: Readonly<Record<string, HandoffSourceRouteContract>>;
  },
): Promise<HandoffSourcesResolution> {
  const refuse = (detail: string): HandoffSourcesResolution => ({ ok: false, reason: detail });

  const extraction = extractHandoffSources(input.properties);
  if (!extraction.ok) return refuse(extraction.reason);
  if (extraction.mode === "legacy") {
    /**
     * No `Sources` property at all. This establishes NOTHING: whether the
     * route accepts a Handoff that declares no operational reference is a
     * contract decision, never a fallback to the retired token columns. A
     * route that requires an Entity/Matter (uncontracted, or one whose
     * contract names a token or an entity/matter artifact) refuses here. A
     * declared generic route is accepted ONLY when its contract also
     * requires no source artifact: a `required` entry can only be supplied
     * from inside `Sources`, so an absent property would silently bypass it
     * -- that case refuses too, rather than returning a legacy mode that
     * skips the contract's requirement. A generic route with no required
     * artifact accepts the Handoff as carrying no binding, which is exactly
     * what it does carry.
     */
    const routeRequires = handoffRouteRequiresEntityMatter(input.route.fromUnit, input.route.toUnit, input.contracts);
    if (routeRequires) {
      return refuse(
        `the Handoff declares no "${HANDOFF_SOURCES_PROPERTY}" property, and route "${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)}" requires an Entity/Matter binding -- the separate Entity_Token/Matter_Token properties are no longer read, so a Handoff with no Sources establishes no identity and nothing is inferred to fill the gap.`,
      );
    }
    const legacyContract = (input.contracts ?? HANDOFF_SOURCE_ROUTE_CONTRACTS)[handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)];
    if (legacyContract && legacyContract.required.length > 0) {
      // `routeRequires` is false only for a declared generic route, so a
      // contract here exists (an uncontracted route refused above). Its
      // required artifacts are the check that must not be skipped: they can
      // only travel inside Sources, so a Handoff carrying none of the
      // property cannot satisfy them.
      return refuse(
        `the Handoff declares no "${HANDOFF_SOURCES_PROPERTY}" property, and route "${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)}" requires a ${legacyContract.required.join(", ")} source -- a required artifact can only travel inside Sources, so an absent property is refused rather than the contract's requirement skipped.`,
      );
    }
    return { ok: true, mode: "legacy" };
  }

  const contract = (input.contracts ?? HANDOFF_SOURCE_ROUTE_CONTRACTS)[handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)];
  if (!contract) {
    return refuse(
      `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property is present, but route "${handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit)}" has no Handoff source route contract -- which sources may travel a route is an explicit contract decision, so an uncontracted route is refused rather than guessed.`,
    );
  }

  // ---- The opaque token entries: the Handoff's operational identity ------
  // Extracted from the payload itself (deterministically, before any fetch),
  // enforced against the route contract, and -- when the caller also passed
  // tokens -- reconciled against those. A route that does not require a
  // given token kind REFUSES that kind outright: the route does not deal in
  // it, so one arriving is a contract violation, never something to ignore.
  const tokenRefs = extraction.refs.filter((r): r is Extract<HandoffSourceRef, { kind: "token" }> => r.kind === "token");
  const declaredEntityToken = tokenRefs.find((r) => r.tokenKind === "entity")?.token;
  const declaredMatterToken = tokenRefs.find((r) => r.tokenKind === "matter")?.token;
  if (declaredEntityToken && !contract.requiresEntityToken) {
    return refuse(`the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries an Entity token, but route ${routeKeyOf(input.route)} does not require one -- a route that does not deal in Entity identity refuses the token rather than ignoring it.`);
  }
  if (declaredMatterToken && !contract.requiresMatterToken) {
    return refuse(`the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries a Matter token, but route ${routeKeyOf(input.route)} does not require one -- a route that does not deal in Matter identity refuses the token rather than ignoring it.`);
  }
  if (contract.requiresEntityToken && !declaredEntityToken) {
    return refuse(`route ${routeKeyOf(input.route)} requires an opaque Entity token in the Handoff's ${HANDOFF_SOURCES_PROPERTY} property, and the Handoff carries none -- a required token is never substituted from a free-text reference, a title, or the retired token properties.`);
  }
  if (contract.requiresMatterToken && !declaredMatterToken) {
    return refuse(`route ${routeKeyOf(input.route)} requires an opaque Matter token in the Handoff's ${HANDOFF_SOURCES_PROPERTY} property, and the Handoff carries none -- a required token is never substituted from a free-text reference, a title, or the retired token properties.`);
  }
  if (input.tokens) {
    const callerEntity = input.tokens.entityToken.trim();
    const callerMatter = input.tokens.matterToken.trim();
    if (callerEntity && declaredEntityToken && callerEntity !== declaredEntityToken) {
      return refuse(
        `the caller's Entity token "${callerEntity}" contradicts the Entity token "${declaredEntityToken}" this Handoff's ${HANDOFF_SOURCES_PROPERTY} property declares -- contradictory bindings are refused rather than resolved by letting one transport win.`,
      );
    }
    if (callerMatter && declaredMatterToken && callerMatter !== declaredMatterToken) {
      return refuse(
        `the caller's Matter token "${callerMatter}" contradicts the Matter token "${declaredMatterToken}" this Handoff's ${HANDOFF_SOURCES_PROPERTY} property declares -- contradictory bindings are refused rather than resolved by letting one transport win.`,
      );
    }
  }

  // ---- Pass 1: fetch, type, and permit every ARTIFACT reference ----------
  const routeKey = routeKeyOf(input.route);
  const seenTypes = new Set<HandoffSourceType>();


  /**
   * The route-contract permission check for ARTIFACT references: prohibited
   * is refused by name; a type the contract neither requires nor permits is
   * refused (the table decides, never code-path accident); and one
   * reference of each type -- the Handoff's Entity/Matter are singular, so
   * two sources of one type cannot both be "the" reference -- they are
   * conflicting references, refused rather than arbitrated. Opaque token
   * entries are governed by `requiresEntityToken`/`requiresMatterToken`
   * above, never by this artifact check.
   */
  const permitType = (type: HandoffSourceType, describe: string): string | null => {
    if (contract.prohibited.includes(type)) {
      return `source ${describe} is a ${type}, and ${type} sources are prohibited on route ${routeKey} by the route contract.`;
    }
    if (!contract.required.includes(type) && !contract.optional.includes(type)) {
      return `source ${describe} is a ${type}, which is neither required nor optional on route ${routeKey} -- the route contract does not permit ${type} sources.`;
    }
    if (seenTypes.has(type)) {
      return `the Handoff references more than one ${type} source -- which one is the source is ambiguous, so none is accepted.`;
    }
    seenTypes.add(type);
    return null;
  };

  type SourceSlot =
    | { kind: "page"; type: HandoffSourceType; page: NotionPage }
    | { kind: "google"; ref: { type: GoogleHandoffSourceType; fileId: string } };
  const slots: SourceSlot[] = [];

  for (const ref of extraction.refs) {
    if (ref.kind === "token") continue; // identity transport, handled above and in pass 2 -- never an artifact
    if (ref.kind === "google") {
      // Permission first (no network); the full binding/type chain runs in
      // pass 3, once the Entity/Matter binding exists to check it against.
      const denied = permitType(ref.type, `Google file ${ref.fileId}`);
      if (denied) return refuse(denied);
      slots.push({ kind: "google", ref });
      continue;
    }

    // The EXACT page, fetched by id through the governed read path (Access
    // evaluates it against the page's real data source). No search, no
    // title match, no second pass with a looser filter.
    let page: NotionPage;
    try {
      page = await getPage(env, ref.pageId, input.access);
    } catch (err) {
      return refuse(
        `source page ${ref.pageId} could not be read (${err instanceof Error ? err.message : String(err)}) -- an inaccessible source is refused, never approximated by another record.`,
      );
    }
    if (page.archived || page.inTrash) {
      return refuse(`source page ${ref.pageId} is archived or in the trash -- only a live canonical record may be a source.`);
    }
    const dataSourceId = page.parent?.type === "data_source_id" ? page.parent.data_source_id : undefined;
    if (!dataSourceId) {
      return refuse(`source page ${ref.pageId} is not a row of a canonical database (parent type "${page.parent?.type ?? "none"}") -- only canonical records may be sources.`);
    }
    const type = handoffSourceTypeForDataSource(env, dataSourceId);
    if (!type) {
      return refuse(`source page ${ref.pageId} lives in data source ${dataSourceId}, which is not one of ENIG's canonical source databases -- refused rather than treated as an unnamed source.`);
    }
    const denied = permitType(type, `page ${ref.pageId}`);
    if (denied) return refuse(denied);
    slots.push({ kind: "page", type, page });
  }

  // ---- Pass 2: the canonical Entity/Matter binding ------------------------
  // The binding is established ONLY from the opaque token entries this
  // payload declares, resolved through the authorized operational stores
  // (`resolveEntityMatterFromTokens`: the canonical Matters and Entities
  // data sources -- NEVER the Isolated Sales Identity Resolution Registry,
  // never a real-world identity mapping, and never a title search). The
  // canonical `entities`/`matters` PAGES never establish it: they are
  // artifact references that pass 3 cross-checks against this binding, so a
  // page can only ever be REFUSED for disagreeing with it -- never read as
  // a substitute for a token, never used to derive one.
  const bindingRequired = handoffRouteRequiresEntityMatter(input.route.fromUnit, input.route.toUnit, input.contracts);
  let binding: HandoffSourceBinding;
  if (!declaredEntityToken && !declaredMatterToken) {
    if (bindingRequired) {
      return refuse(
        `route ${routeKey} needs an Entity/Matter binding and this Handoff's ${HANDOFF_SOURCES_PROPERTY} property declares no opaque token pair to establish it -- a canonical Entity/Matter page is never read as a substitute for a token, no Handoff property is consulted for one, and nothing is searched, titled, or inferred to fill the gap.`,
      );
    }
    // A declared GENERIC route: it carries no binding at all, which is
    // exactly what such a Handoff is meant to carry. Nothing is invented,
    // and genericity was read from the contract above, never inferred from
    // this payload's emptiness.
    binding = { entityId: "", matterId: "", entityToken: "", matterToken: "", matterStatus: null };
  } else {
    if (!declaredEntityToken || !declaredMatterToken) {
      return refuse(
        `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property declares ${declaredEntityToken ? "an Entity token but no Matter token" : "a Matter token but no Entity token"} -- a Handoff's operational binding is one Entity/Matter pair, so half a pair establishes nothing and is refused rather than bound to whatever else happens to be on the record.`,
      );
    }
    const resolved = await resolveEntityMatterFromTokens(env, declaredEntityToken, declaredMatterToken);
    if (!resolved) {
      return refuse(
        `the opaque token pair ${declaredEntityToken} / ${declaredMatterToken} this Handoff's ${HANDOFF_SOURCES_PROPERTY} property declares does not resolve to real, correctly-related Entity/Matter records in ENIG's operational stores -- a Handoff whose identity cannot be established is refused rather than bound to some other record.`,
      );
    }
    binding = {
      entityId: resolved.entityId,
      matterId: resolved.matterId,
      entityToken: declaredEntityToken,
      matterToken: declaredMatterToken,
      matterStatus: resolved.matterStatus,
    };
  }

  // ---- Pass 3: per-type validation against that binding -------------------
  const sources: ResolvedHandoffSourceRef[] = [];
  let callNotes: ResolvedCallNotesSource | undefined;
  let googleDoc: ResolvedGoogleDocSource | undefined;

  for (const slot of slots) {
    if (slot.kind === "google") {
      const validated = await validateGoogleSource(env, slot.ref, binding, input.readBoundWorkState ?? defaultReadBoundWorkState(env));
      if (!validated.ok) return refuse(validated.reason);
      sources.push({ type: slot.ref.type, id: slot.ref.fileId });
      if (validated.googleDoc) googleDoc = validated.googleDoc;
      continue;
    }
    // Every artifact -- including a canonical `entities`/`matters` page --
    // is validated against the token-derived binding. A page that disagrees
    // with it (wrong `Entity_ID`/`Matter_ID`, or a Matter belonging to a
    // different Entity) is refused by name; it can never redefine the
    // binding it is checked against.
    const validated = await validateSourcePage(slot.type, slot.page, binding);
    if (!validated.ok) return refuse(validated.reason);
    sources.push({ type: slot.type, id: slot.page.id });
    if (validated.callNotes) callNotes = validated.callNotes;
  }

  for (const required of contract.required) {
    if (!sources.some((s) => s.type === required)) {
      return refuse(`route ${routeKey} requires a ${required} source and the Handoff's ${HANDOFF_SOURCES_PROPERTY} property carries none -- a mandatory source is never substituted from narrative text or a free-text reference.`);
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

  return {
    ok: true,
    mode: "sources",
    sources,
    binding,
    ...(callNotes ? { callNotes } : {}),
    ...(googleDoc ? { googleDoc } : {}),
  };
}

/**
 * The receiving consumer's entry point for a Handoff's operational identity
 * context -- the ONE place a Unit gets an Handoff's Entity/Matter binding,
 * so no consumer reads record properties or re-resolves identity itself.
 *
 * - A Sources-enabled Handoff is fully resolved through
 *   `resolveHandoffSources` (route contract, the opaque token entries, their
 *   resolution through the authorized operational stores, the exact artifact
 *   pages, the binding relationship proof, lifecycle and approval
 *   validation) and the PROVED binding is returned: its
 *   `entityToken`/`matterToken` are the values the canonical records
 *   themselves carry, so a consumer never re-derives the Handoff's identity
 *   from anything it reads itself.
 * - A Handoff with NO `Sources` property resolves `legacy` with no fetch at
 *   all -- and ONLY on a route declared generic by its contract (a route
 *   needing an Entity/Matter refuses instead, see `resolveHandoffSources`).
 *   It carries no binding, so it returns empty token values: nothing is
 *   read from the retired `Entity_Token`/`Matter_Token` properties, and
 *   nothing is inferred to fill the gap.
 * - Any failure is a refusal with a non-sensitive reason (fail closed),
 *   which consumers report through their own existing paths.
 */
export type HandoffContextBindingResolution =
  | { ok: true; mode: "legacy"; entityToken: string; matterToken: string }
  | {
      ok: true;
      mode: "sources";
      entityToken: string;
      matterToken: string;
      binding: HandoffSourceBinding;
      sources: Extract<HandoffSourcesResolution, { ok: true; mode: "sources" }>;
    }
  | { ok: false; reason: string };

export async function resolveHandoffContextBinding(
  env: Env,
  input: {
    properties: NotionProperties;
    route: { fromUnit: string; toUnit: string };
    access: AccessContext;
    /** The same test seam `resolveHandoffSources` takes; production callers omit it. */
    contracts?: Readonly<Record<string, HandoffSourceRouteContract>>;
    /** The same Google binding-hop seam `resolveHandoffSources` takes; production callers omit it. */
    readBoundWorkState?: (workId: string) => Promise<BoundWorkIdentity | undefined>;
  },
): Promise<HandoffContextBindingResolution> {
  const resolution = await resolveHandoffSources(env, {
    properties: input.properties,
    route: input.route,
    access: input.access,
    ...(input.contracts ? { contracts: input.contracts } : {}),
    ...(input.readBoundWorkState ? { readBoundWorkState: input.readBoundWorkState } : {}),
  });
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  if (resolution.mode === "legacy") {
    // Reachable ONLY for a route declared generic by its contract (a route
    // needing an Entity/Matter never gets here -- it refuses above). Such a
    // Handoff carries no binding, so this reports exactly that: empty token
    // values, never a value read from the retired Handoff token properties.
    return { ok: true, mode: "legacy", entityToken: "", matterToken: "" };
  }
  return {
    ok: true,
    mode: "sources",
    entityToken: resolution.binding.entityToken,
    matterToken: resolution.binding.matterToken,
    binding: resolution.binding,
    sources: resolution,
  };
}


export type GoogleDocContentRead = { ok: true; content: string } | { ok: false; reason: string };

/**
 * Reads the content of an ALREADY VALIDATED Google Doc source, read-only,
 * through the Docs API with the registered account's token. Never called
 * before `resolveHandoffSources` returned this source: the binding (route
 * contract -> registration -> bound Work's Matter -> actual mimeType) is
 * what earns this read. An empty document is refused outright -- a
 * document that holds nothing cannot serve as substantive evidence, and
 * nothing is inferred to fill the gap.
 */
export async function readGoogleDocSourceContent(env: Env, source: ResolvedGoogleDocSource): Promise<GoogleDocContentRead> {
  const token = await getValidGoogleAccessToken(env, source.accountIdentifier);
  if (!token) {
    return {
      ok: false,
      reason: `the account this Google Doc source is registered under holds no currently authorized token, so its content cannot be read -- the source is refused rather than read through another account.`,
    };
  }
  let response: Response;
  try {
    response = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(source.fileId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Google Doc source ${source.fileId} could not be read (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  if (!response.ok) {
    return { ok: false, reason: `Google Doc source ${source.fileId} could not be read (HTTP ${response.status}).` };
  }
  const content = extractDocText(await response.json()).trim();
  if (!content) {
    return {
      ok: false,
      reason: `Google Doc source ${source.fileId} carries no text content -- a document that holds nothing cannot serve as substantive evidence, and nothing is inferred to fill the gap.`,
    };
  }
  return { ok: true, content };
}
