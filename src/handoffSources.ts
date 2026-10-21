import type { Env } from "./types";
import { getPage, plainText, relationIds, uniqueId, type NotionPage, type NotionProperties } from "./notion";
import type { AccessContext, GovernedSource } from "./access";
import { resolveEntityMatterFromTokens, type ResolvedEntityMatterIdentity } from "./identityResolution";
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
 * `extractHandoffSources` returns `legacy` when the property is absent,
 * and every existing consumer keeps behaving exactly as before (the
 * free-text `Call_Notes_ID` reference convention in
 * `src/records/callNotes/callNotesRecord.ts`). When the property IS
 * present, this resolver governs and the legacy free-text reference is
 * never a fallback -- a Sources-enabled Handoff whose references do not
 * validate is refused outright. Nothing here writes to Notion: the single
 * governed writer (src/handoffWriter.ts, Phase 2) owns the write side,
 * and the resolver reads whatever the record actually carries.
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
 * VALIDATED binding names (derived from its own `entities`/`matters`
 * sources when it declares them, otherwise resolved from its legacy token
 * properties as the compatibility path), its Status must be one that
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
 * resolution proved (from the canonical sources, or from the legacy fields
 * on the compatibility path), never a value a consumer read off the record
 * for itself.
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
 * claim is verified against the Drive API at resolution.
 */
export type HandoffSourceRef =
  | { kind: "notion"; pageId: string }
  | { kind: "google"; type: GoogleHandoffSourceType; fileId: string };

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
 * - `Sales->Strategy` -- the commercial-diagnosis Handoff. This route needs
 *   an Entity and a Matter (the diagnosis is about one Matter of one
 *   Entity), so the contract PERMITS the canonical `entities` and `matters`
 *   sources explicitly and requires the relationship checks for them: when
 *   both are named, the Matter source's own `Entity` relation must be
 *   exactly the Entity source page. Present they define the Handoff's
 *   binding (see `resolveHandoffSources`); absent, the Handoff's binding
 *   comes from its legacy token properties as the compatibility check, and
 *   a Handoff with neither is refused. Its canonical evidence record (when
 *   it has one) is an approved Call Notes record, so `call_notes` is
 *   optional: present it must validate fully against that same binding;
 *   absent the Handoff carries narrative evidence as before. `handoffs` is
 *   prohibited: a Handoff is never evidence for another Handoff, and a
 *   self/cycle reference would make evidence unresolvable.
 *
 * - `Strategy->Finance` -- the value-based quote request Martin's approval
 *   of a Strategy intervention commits. This route is NOT generic and its
 *   Entity/Matter binding is required outright (`entities`, `matters` in
 *   `required`): the quote is priced for one Matter of one Entity, and a
 *   Sources-enabled Handoff of this route may never travel without
 *   establishing exactly which canonical pages those are -- resolution
 *   refuses one carrying either missing, and the binding is established
 *   from exactly those two pages (cross-checked against the Handoff's own
 *   tokens when those are present). `call_notes` is OPTIONAL and
 *   carries the upstream Sales -> Strategy Handoff's own canonical Call
 *   Notes reference, forwarded by the Strategy producer when (and only
 *   when) that reference exists and re-validates on its own route -- the
 *   same exact canonical page, its URL rebuilt in bare-id form so no title
 *   slug (identity-bearing text) travels in a protected field --
 *   so Finance can resolve the same approved record the diagnosis was
 *   grounded in. Absent, the Handoff carries the Strategy boundary
 *   representation and the upstream commercial-value determination as
 *   before, and no Call Notes reference is ever fabricated to fill the gap.
 *   `handoffs` is prohibited for the same reason as on Sales->Strategy.
 *
 * A route whose contract neither requires nor permits `entities`/`matters`
 * (see `handoffRouteRequiresEntityMatter`) is a declared GENERIC route:
 * Handoffs on it do not carry, and are never forced to acquire, an
 * Entity/Matter. No production route is declared generic today -- a
 * generic route is an explicit contract decision (a `contracts` table entry
 * naming one), never an absence of contract: an uncontracted route stays
 * what it always was, an Entity/Matter-bound route refused fail-closed.
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
    required: [],
    optional: ["call_notes", "entities", "matters"],
    prohibited: ["handoffs"],
  },
  "Strategy->Finance": {
    required: ["entities", "matters"],
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

/**
 * Whether a Handoff travelling this route needs an Entity/Matter binding at
 * all -- the generic-route declaration, answered from the route's contract
 * alone: a route that neither requires nor permits an `entities` or a
 * `matters` source is a declared generic route (its workflow needs no
 * Entity/Matter, so no token property, no source reference, and no
 * discovered Work is ever forced to acquire one). An uncontracted route
 * returns true -- nothing has declared it generic, so today's behaviour
 * (Entity/Matter required) stands. This is the ONLY thing that makes a
 * Handoff generic; there is no inference from what a particular payload
 * happens to carry.
 */
export function handoffRouteRequiresEntityMatter(
  fromUnit: string,
  toUnit: string,
  contracts?: Readonly<Record<string, HandoffSourceRouteContract>>,
): boolean {
  const contract = (contracts ?? HANDOFF_SOURCE_ROUTE_CONTRACTS)[handoffSourceRouteKey(fromUnit, toUnit)];
  if (!contract) return true;
  const carries = (type: HandoffSourceType) => contract.required.includes(type) || contract.optional.includes(type);
  return carries("entities") || carries("matters");
}

/**
 * The one sanctioned read of the legacy `Entity_Token` / `Matter_Token`
 * Handoff properties -- a DELIBERATE temporary compatibility read while the
 * live schema still carries both columns, never an identity authority of
 * its own. Consumers do not read those properties directly: they go through
 * this function (display/legacy-token needs) or through
 * `resolveHandoffContextBinding` (operational context), so there is one
 * place to retire when the migration completes. Never a lookup key, never a
 * fallback that overrides a validated `Sources` reference -- see
 * `resolveHandoffSources`, which treats the same two values as a
 * consistency check against sources and fails closed on a contradiction.
 */
export function readLegacyHandoffTokens(properties: NotionProperties | undefined): { entityToken: string; matterToken: string } {
  const props = (properties as Record<string, unknown> | undefined) ?? {};
  return {
    entityToken: plainText(props.Entity_Token).trim(),
    matterToken: plainText(props.Matter_Token).trim(),
  };
}

/**
 * The canonical Entity/Matter binding a Handoff's operational context
 * resolves to: the exact page ids of the two canonical records, their
 * opaque operational tokens, and the Matter's lifecycle Status when a
 * source read it. Produced ONLY by this module's resolution -- from
 * validated `Sources` references (primary) or from the legacy token
 * properties (compatibility) -- and passed through the runtime context from
 * there, so no consumer re-resolves the Handoff's identity from record
 * properties it reads itself.
 */
export interface HandoffSourceBinding {
  entityId: string;
  matterId: string;
  entityToken: string;
  matterToken: string;
  /** The Matter page's own lifecycle Status as read from the page; null when this binding came from the legacy path, which reads no pages. */
  matterStatus: string | null;
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
 * The write shape for a `Sources` payload: one rich-text item per URL, each
 * carrying its `text.link.url`. The single sanctioned way a runtime producer
 * builds the property (the writer's extraction reads exactly this shape), so
 * no producer hand-assembles rich-text items and no reference can be written
 * as link-less plain text that the read side would then have to guess about.
 */
export function sourcesRichText(urls: readonly string[]): { rich_text: Array<{ type: "text"; text: { content: string; link: { url: string } } }> } {
  return {
    rich_text: urls.map((url) => ({ type: "text" as const, text: { content: url, link: { url } } })),
  };
}

export type HandoffSourceExtraction =
  | { ok: true; mode: "legacy" }
  | { ok: true; mode: "sources"; refs: HandoffSourceRef[] }
  | { ok: false; reason: string };

/**
 * Reads the Handoff's own `Sources` property, if it has one.
 *
 * `legacy` (no fetches, no validation) is the compatibility seam: a
 * Handoff whose record carries no `Sources` property reads back legacy and
 * its consumers behave exactly as before. A PRESENT property turns the
 * Sources path on and must carry at least one direct link -- to an exact
 * Notion page or a recognized direct Google Docs/Sheets URL; anything else
 * is refused right here, before any fetch. Duplicate references to the same
 * page id or the same Google file id are refused the same way (a duplicate
 * is a conflicting reference by construction -- the same file named twice
 * through two URL shapes is still one reference written twice).
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
      reason: `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property is present but carries no link -- a Sources-enabled Handoff must reference at least one exact canonical artifact, and nothing is inferred to fill the gap.`,
    };
  }
  const refs: HandoffSourceRef[] = [];
  for (const url of urls) {
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
  return { ok: true, mode: "sources", refs };
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
       * The Entity/Matter binding this resolution PROVED: derived from the
       * Handoff's own canonical `entities`/`matters` sources (with the
       * Matter->Entity relationship check), cross-checked against the
       * Handoff's legacy token properties when those are present. Always
       * established -- a Sources-enabled Handoff whose binding cannot be
       * established is refused rather than resolved half-way.
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
 * The one resolution entry point. Reads the Handoff's own properties
 * (the `Sources` property, the recorded From/To Unit, and -- only as the
 * compatibility check below -- the legacy token properties) and resolves
 * every reference to an exactly-fetched, validated canonical artifact --
 * Notion pages by id, Google Docs through the registration binding chain
 * above -- or returns `legacy` when the property is absent, or a refusal.
 *
 * **The Entity/Matter binding comes from the sources themselves.** When the
 * Handoff names canonical `entities`/`matters` sources, those exact pages
 * ARE the binding (their `Entity_ID`/`Matter_ID`, plus the relationship
 * proof that the Matter belongs to that Entity), and no token property is
 * required or consulted for it. When the Handoff also carries legacy
 * `Entity_Token`/`Matter_Token`, those are reconciled against what the
 * sources prove and any contradiction fails closed; when it carries ONLY
 * the legacy fields (no entity/matter sources), they resolve exactly as
 * they always have and every source must agree with them. What never
 * happens: a title search, a nearest-record lookup, or a fallback from a
 * failed canonical reference to a token property.
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
     * Optional: the legacy operational tokens to reconcile the validated
     * sources against. Production callers OMIT this -- the Handoff's own
     * `Entity_Token`/`Matter_Token` properties are read here instead
     * (`readLegacyHandoffTokens`, the one sanctioned compatibility read) --
     * and callers that already hold the values may pass them explicitly.
     * Either way they are only ever a CONSISTENCY check against what the
     * sources prove: never the binding's source when canonical sources are
     * present, and never a fallback for a reference that failed.
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
     * machinery (required sources, per-type validation of `matters` /
     * `entities` sources, and the Google source types no production route
     * permits yet) can be exercised without a production route that
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

  // ---- Compatibility/consistency input: the legacy token properties -------
  // Read only when the record carries them (or the caller passed them).
  // This is the deliberate temporary compatibility check the migration
  // keeps, checked BEFORE any source page is fetched -- exactly as this
  // resolver always has -- so a Handoff whose own identity fields do not
  // resolve is refused with that fact, and when they DO resolve every
  // source must agree with them below (a contradiction fails closed, never
  // resolved by letting one transport win). A source-based Handoff with no
  // legacy identity fields skips this entirely: its binding comes from its
  // canonical sources, and no token property is required for it.
  const legacy = input.tokens
    ? { entityToken: input.tokens.entityToken.trim(), matterToken: input.tokens.matterToken.trim() }
    : readLegacyHandoffTokens(input.properties);
  let legacyResolved: ResolvedEntityMatterIdentity | null = null;
  if (legacy.entityToken || legacy.matterToken) {
    legacyResolved = await resolveEntityMatterFromTokens(env, legacy.entityToken, legacy.matterToken);
    if (!legacyResolved) {
      return refuse(
        `the Handoff's Entity_Token "${legacy.entityToken || "(empty)"}" / Matter_Token "${legacy.matterToken || "(empty)"}" did not resolve to a real, related Entity/Matter record, so no source reference's bindings can be verified -- without that check any page would do.`,
      );
    }
  }

  // ---- Pass 1: fetch, type, and permit every reference (no binding yet) ---
  const routeKey = handoffSourceRouteKey(input.route.fromUnit, input.route.toUnit);
  const seenTypes = new Set<HandoffSourceType>();

  /**
   * The route-contract permission check, shared by both reference kinds:
   * prohibited is refused by name; a type the contract neither requires nor
   * permits is refused (the table decides, never code-path accident); and
   * one reference of each type -- the Handoff's Entity/Matter are singular,
   * so two sources of one type cannot both be "the" reference -- they are
   * conflicting references, refused rather than arbitrated.
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
  const entitySource = slots.find((s): s is Extract<SourceSlot, { kind: "page" }> => s.kind === "page" && s.type === "entities");
  const matterSource = slots.find((s): s is Extract<SourceSlot, { kind: "page" }> => s.kind === "page" && s.type === "matters");

  let binding: HandoffSourceBinding;
  if (legacyResolved) {
    // Compatibility path, unchanged: the Handoff's own identity fields
    // resolve to real, related records, so they are the binding and every
    // entity/matter source must AGREE with them (validateSourcePage's
    // per-type refusals below name the exact disagreement).
    binding = {
      entityId: legacyResolved.entityId,
      matterId: legacyResolved.matterId,
      entityToken: legacy.entityToken,
      matterToken: legacy.matterToken,
      matterStatus: legacyResolved.matterStatus,
    };
  } else {
    // Canonical source-based path: the record carries no legacy identity
    // fields, so the binding is derived from its own exact sources -- the
    // entity source's `Entity_ID`, the matter source's `Matter_ID`, and the
    // relationship proof that the Matter belongs to that Entity. Nothing is
    // searched, titled, or inferred to fill either side of the pair.
    if (!entitySource && !matterSource) {
      return refuse(
        `the Handoff's ${HANDOFF_SOURCES_PROPERTY} property declares no canonical Entity/Matter source, and the Handoff carries no legacy Entity_Token/Matter_Token to bind its other sources against -- a Sources-enabled Handoff must establish its Entity/Matter binding from exact canonical references, and nothing is inferred to fill the gap.`,
      );
    }
    let entityId = "";
    let matterId = "";
    let entityToken = "";
    let matterToken = "";
    let matterStatus: string | null = null;

    if (entitySource) {
      entityToken = uniqueId(entitySource.page.properties?.Entity_ID);
      if (!entityToken) {
        return refuse(`Entity source ${entitySource.page.id} carries no Entity_ID -- the page cannot be established as this Handoff's operational Entity record.`);
      }
      entityId = entitySource.page.id;
    }
    if (matterSource) {
      matterToken = uniqueId(matterSource.page.properties?.Matter_ID);
      if (!matterToken) {
        return refuse(`Matter source ${matterSource.page.id} carries no Matter_ID -- the page cannot be established as this Handoff's operational Matter record.`);
      }
      matterId = matterSource.page.id;
      matterStatus = matterSource.page.properties?.Status?.select?.name ?? null;

      // The relationship proof: the Matter source's own canonical Entity
      // relation must be exactly the Entity source (when the Handoff names
      // one). With no entity source on the Handoff, that same relation is
      // what supplies the Entity side -- fetched BY ID (never searched) to
      // read its Entity_ID, so both sides still come from exact canonical
      // records rather than from any lookup.
      const relations = relationIds(matterSource.page.properties?.Entity);
      if (entitySource) {
        if (relations.length !== 1 || relations[0] !== entityId) {
          return refuse(
            `Matter source ${matterId} carries Entity relation [${relations.join(", ") || "none"}] but this Handoff's Entity source is page ${entityId} -- the Matter source does not belong to that Entity, so the two sources cannot both be this Handoff's binding.`,
          );
        }
      } else if (relations.length !== 1 || !relations[0]) {
        return refuse(
          `Matter source ${matterId} carries no single Entity relation ([${relations.join(", ") || "none"}]) -- with no Entity source on this Handoff, the Matter's own canonical Entity relation is the only thing that can establish the Entity side of the binding.`,
        );
      } else {
        let related: NotionPage;
        try {
          related = await getPage(env, relations[0], input.access);
        } catch (err) {
          return refuse(
            `the Entity page ${relations[0]} this Matter source relates to could not be read (${err instanceof Error ? err.message : String(err)}) -- an unreadable relation target is refused, never approximated by another record.`,
          );
        }
        if (related.archived || related.inTrash) {
          return refuse(`the Entity page ${relations[0]} this Matter source relates to is archived or in the trash -- only a live canonical record may be part of a binding.`);
        }
        entityToken = uniqueId(related.properties?.Entity_ID);
        if (!entityToken) {
          return refuse(`the Entity page ${relations[0]} this Matter source relates to carries no Entity_ID -- the relation target cannot be established as an operational Entity record.`);
        }
        entityId = related.id;
      }
    }

    const carriesMatter = contract.required.includes("matters") || contract.optional.includes("matters");
    const carriesEntity = contract.required.includes("entities") || contract.optional.includes("entities");
    if (carriesMatter && !matterId) {
      return refuse(
        `the Handoff declares canonical sources but no canonical Matter source, and carries no legacy Matter_Token -- route ${routeKey} needs a Matter binding, and no search is made for one.`,
      );
    }
    if (carriesEntity && !entityId) {
      return refuse(
        `the Handoff declares canonical sources but no canonical Entity source, and carries no legacy Entity_Token -- route ${routeKey} needs an Entity binding, and no search is made for one.`,
      );
    }
    binding = { entityId, matterId, entityToken, matterToken, matterStatus };
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
    if (!legacyResolved && (slot.type === "entities" || slot.type === "matters")) {
      // Already established as (or as half of) the binding in pass 2: the
      // exact page id, a present `Entity_ID`/`Matter_ID`, and -- for the
      // Matter -- the proven relationship to that Entity. Validating it
      // against the binding it helped define would only restate that check;
      // the sources list still records it.
      sources.push({ type: slot.type, id: slot.page.id });
      continue;
    }
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
 * context -- the ONE place a Unit gets an Handoff's Entity/Matter binding
 * (or its recorded legacy token values) instead of reading the Handoff's
 * `Entity_Token`/`Matter_Token` properties itself.
 *
 * - A Handoff with NO `Sources` property resolves `legacy` with no fetch at
 *   all: the two token values come back exactly as recorded
 *   (`readLegacyHandoffTokens`), so legacy consumers behave byte-identically
 *   to before -- the closed-context contract downstream still treats them as
 *   opaque references, never as lookup keys.
 * - A Sources-enabled Handoff is fully resolved through
 *   `resolveHandoffSources` (exact pages, route contract, the binding
 *   relationship proof, lifecycle and approval validation) and the PROVED
 *   binding is returned: its `entityToken`/`matterToken` are the values the
 *   canonical records themselves carry, so a consumer never re-derives the
 *   Handoff's identity from record properties it reads itself.
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
    const legacy = readLegacyHandoffTokens(input.properties);
    return { ok: true, mode: "legacy", entityToken: legacy.entityToken, matterToken: legacy.matterToken };
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
