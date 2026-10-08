import type { Env } from "./types";
import { evaluateAccess, NON_GOVERNED_PAGE_TARGET, type AccessContext } from "./access";

const API = "https://api.notion.com/v1";

type NotionPropertyValue = Record<string, unknown>;
export type NotionProperties = Record<string, NotionPropertyValue>;

export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, any>;
  /**
   * Which database/data source this page actually lives in, e.g.
   * { type: "data_source_id", data_source_id: "..." } -- only populated by
   * getPage (createPage/updatePage callers already know the data source
   * they targeted). Needed wherever a caller must confirm a page genuinely
   * belongs to a specific canonical database rather than trusting an
   * external signal (e.g. notionWebhook.ts confirming a webhook-referenced
   * page is actually a Handoffs-database row before treating it as one).
   */
  parent?: { type: string; data_source_id?: string; page_id?: string; database_id?: string };
  archived?: boolean;
  inTrash?: boolean;
}

async function notionFetch(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": env.NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

export function title(text: string): NotionPropertyValue {
  return { title: [{ text: { content: text.slice(0, 2000) } }] };
}

export function richText(text: string): NotionPropertyValue {
  return { rich_text: [{ text: { content: text.slice(0, 2000) } }] };
}

/**
 * Like richText, but for content longer than a single 2,000-char rich-text
 * item -- split across up to 100 items (Notion's per-property limit) so the
 * full text is stored rather than silently truncated. Throws rather than
 * truncating if the text exceeds that limit: a caller storing canonical
 * content must fail closed, never persist a partial record.
 */
export const RICH_TEXT_LONG_MAX_CHARS = 2000 * 100;
export function richTextLong(text: string): NotionPropertyValue {
  if (text.length > RICH_TEXT_LONG_MAX_CHARS) {
    throw new Error(`richTextLong: content is ${text.length} chars, above Notion's ${RICH_TEXT_LONG_MAX_CHARS}-char rich-text property limit`);
  }
  const items: { text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += 2000) items.push({ text: { content: text.slice(i, i + 2000) } });
  return { rich_text: items };
}

export function select(name: string): NotionPropertyValue {
  return { select: { name } };
}

export function number(value: number): NotionPropertyValue {
  return { number: value };
}

export function relation(pageIds: string[]): NotionPropertyValue {
  return { relation: pageIds.map((id) => ({ id })) };
}

export function url(value: string): NotionPropertyValue {
  return { url: value };
}

export async function queryDataSource(
  env: Env,
  dataSourceId: string,
  access: AccessContext,
  filter?: Record<string, unknown>,
  options?: { pageSize?: number; sortByCreatedDescending?: boolean },
): Promise<NotionPage[]> {
  // Access is evaluated before the network is touched at all -- an
  // unauthorized read never reaches Notion. `access` is a required
  // parameter precisely so no caller can reach this without declaring
  // which kind of execution context it is running under.
  evaluateAccess(env, { operation: "read", dataSourceId }, access);
  const body: Record<string, unknown> = { page_size: options?.pageSize ?? 20 };
  if (filter) body.filter = filter;
  if (options?.sortByCreatedDescending) {
    body.sorts = [{ timestamp: "created_time", direction: "descending" }];
  }
  const data = await notionFetch(env, `/data_sources/${dataSourceId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  // Notion's data-source query does not reliably exclude archived/trashed
  // pages from results on its own (confirmed live: an archived Handoff was
  // returned by a Status=Pending discovery query, causing a WorkSession to
  // repeatedly fail trying to edit it -- "Can't edit block that is
  // archived"). Filter them out here, once, so every caller (every
  // discovery loop) is protected rather than each having to guard against
  // this individually.
  return (data.results ?? [])
    .filter((p: any) => !p.archived && !p.in_trash)
    .map((p: any) => ({ id: p.id, url: p.url, properties: p.properties }));
}

export async function createPage(
  env: Env,
  dataSourceId: string,
  properties: NotionProperties,
  access: AccessContext,
): Promise<NotionPage> {
  // A create targets the data source the caller named, so that name IS
  // the authoritative target -- there is no page to resolve. Access
  // decides from the resolved ActionDefinition whether this particular
  // governed source is one Martin's approval was required for.
  evaluateAccess(env, { operation: "create", dataSourceId }, access);
  const data = await notionFetch(env, `/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
    }),
  });
  return { id: data.id, url: data.url, properties: data.properties };
}

/**
 * Resolves the data source a page ACTUALLY lives in, from Notion itself.
 *
 * This exists because updatePage receives only a pageId, and authorizing a
 * mutation against a caller-supplied dataSourceId would be authorizing
 * against the caller's own claim about what it is touching. An approval
 * minted for HANDOFFS must never be able to authorize an update to
 * MATTERS/ENTITIES/PROPOSALS (or any other governed source), and that is
 * only mechanically true if the target comes from the page, not the
 * caller. Fails closed when the parent cannot be resolved to a data
 * source -- an unresolvable target is never treated as "whatever the
 * caller said".
 */
async function resolvePageDataSourceId(env: Env, pageId: string): Promise<string> {
  const page = await fetchPageUnchecked(env, pageId);
  const parent = page.parent;
  if (parent?.type === "data_source_id" && parent.data_source_id) {
    return parent.data_source_id;
  }
  throw new Error(
    `updatePage: could not resolve an authoritative data source for page ${pageId} (parent type "${parent?.type ?? "none"}") -- refusing to authorize a governed mutation against an unverified target.`,
  );
}

export async function updatePage(env: Env, pageId: string, properties: NotionProperties, access: AccessContext): Promise<NotionPage> {
  const dataSourceId = await resolvePageDataSourceId(env, pageId);
  // Access is evaluated against the page's REAL data source, so an
  // ApprovalProof's targetDataSourceId is compared against the actual
  // target rather than anything the caller asserted.
  evaluateAccess(env, { operation: "update", dataSourceId, pageId }, access);
  const data = await notionFetch(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  return { id: data.id, url: data.url, properties: data.properties };
}

/**
 * Fetches a page WITHOUT consulting Access.
 *
 * This exists for one purpose only: determining what a page IS, so that the
 * operation on it can be authorized against the page's real target rather
 * than a caller's claim. It is never the way a caller reads a page -- it is
 * module-private for exactly that reason, so that no call site outside this
 * file can reach a governed read that Access never saw.
 */
async function fetchPageUnchecked(env: Env, pageId: string): Promise<NotionPage> {
  const data = await notionFetch(env, `/pages/${pageId}`);
  return { id: data.id, url: data.url, properties: data.properties, parent: data.parent, archived: data.archived, inTrash: data.in_trash };
}

/**
 * The target a page-anchored operation is authorized against: the data
 * source the page genuinely lives in, or the non-governed marker when it does
 * not live in any governed data source at all (a standalone governance page,
 * for instance).
 *
 * Reads of such a page are still routed through Access -- a page outside every
 * governed source is a weaker target, not an unevaluated one. Writes never
 * accept the marker (see evaluateAccess), because there is no such thing as a
 * governed mutation of a page that belongs to no governed source.
 */
async function resolvePageTarget(env: Env, pageId: string, operation: string): Promise<{ target: string; page: NotionPage }> {
  const page = await fetchPageUnchecked(env, pageId);
  const parent = page.parent;
  if (parent?.type === "data_source_id" && parent.data_source_id) {
    return { target: parent.data_source_id, page };
  }
  if (operation === "read") {
    return { target: NON_GOVERNED_PAGE_TARGET, page };
  }
  throw new Error(
    `${operation}: could not resolve an authoritative governed source for page ${pageId} (parent type "${parent?.type ?? "none"}") -- refusing to ${operation} governed state on a target that belongs to no governed source.`,
  );
}

/**
 * Reads a Notion page, authorized against the data source the page actually
 * lives in.
 *
 * The target is resolved from Notion itself rather than accepted from the
 * caller, for the same reason updatePage does it: authorizing a read against
 * a caller's claim about what it is touching would mean the read's scope was
 * whatever the caller said it was.
 */
export async function getPage(env: Env, pageId: string, access: AccessContext): Promise<NotionPage> {
  const { target, page } = await resolvePageTarget(env, pageId, "read");
  evaluateAccess(env, { operation: "read", dataSourceId: target, pageId }, access);
  return page;
}

/**
 * Appends a heading plus the given text (as paragraph blocks, chunked to
 * Notion's 2,000-char rich-text limit) to the end of a page's body. Used to
 * keep an immutable snapshot of each canonical record version in the page
 * itself, alongside whatever its properties currently hold.
 *
 * This is a governed WRITE, not a cosmetic one: it changes the canonical
 * record's own content, and appending a version snapshot is part of committing
 * that version. It is therefore authorized as an `update` against the page's
 * real data source, and is gated exactly like any other update -- an Action
 * that can append a version snapshot is the Action that can change the
 * record, and no separate "just appending text" exemption exists.
 */
export async function appendTextBlocks(env: Env, pageId: string, heading: string, text: string, access: AccessContext): Promise<void> {
  // Authorized before the first network write, and against the page's real
  // data source rather than a caller-supplied one.
  const { target } = await resolvePageTarget(env, pageId, "update");
  evaluateAccess(env, { operation: "update", dataSourceId: target, pageId }, access);
  const paragraphs: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    paragraphs.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text.slice(i, i + 2000) } }] } });
  }
  const blocks = [
    { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: heading.slice(0, 2000) } }] } },
    ...paragraphs,
  ];
  // Notion accepts at most 100 children per append request.
  for (let i = 0; i < blocks.length; i += 100) {
    await notionFetch(env, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
    });
  }
}

/**
 * Creates one child page under an existing record's page, holding `text`
 * (paragraph blocks chunked to Notion's 2,000-char rich-text limit, at most
 * 100 children per request). Used to keep each version of a canonical record
 * as its own readable page, written once and never edited.
 *
 * Like appendTextBlocks this is a governed WRITE, not a cosmetic one: it is
 * authorized as an `update` against the PARENT record's real data source
 * (resolved from Notion, never accepted from the caller), so the Action that
 * can commit a version is the Action that can create its page, and no
 * separate "just a child page" exemption exists.
 */
export async function createVersionPage(
  env: Env,
  parentPageId: string,
  pageTitle: string,
  text: string,
  access: AccessContext,
): Promise<{ id: string; url: string }> {
  const { target } = await resolvePageTarget(env, parentPageId, "update");
  evaluateAccess(env, { operation: "update", dataSourceId: target, pageId: parentPageId }, access);
  const blocks: Record<string, unknown>[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text.slice(i, i + 2000) } }] } });
  }
  const data = await notionFetch(env, `/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      properties: { title: { title: [{ text: { content: pageTitle.slice(0, 2000) } }] } },
      children: blocks.slice(0, 100),
    }),
  });
  for (let i = 100; i < blocks.length; i += 100) {
    await notionFetch(env, `/blocks/${data.id}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
    });
  }
  return { id: data.id, url: data.url };
}

export function plainText(prop: any): string {
  if (!prop) return "";
  if (typeof prop.url === "string") return prop.url;
  if (prop.title) return prop.title.map((t: any) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.plain_text).join("");
  if (prop.select) return prop.select?.name ?? "";
  if (prop.number !== undefined) return String(prop.number ?? "");
  if (prop.email) return prop.email;
  if (prop.phone_number) return prop.phone_number;
  return "";
}

export function relationIds(prop: any): string[] {
  return (prop?.relation ?? []).map((r: any) => r.id);
}

/**
 * Reads a Notion auto-incrementing Unique ID property (e.g. "Entity_ID",
 * "Matter_ID") as a display string, honoring a configured prefix if any.
 * Used as a stable, non-identifying stand-in for a real Name/title
 * property wherever code must reference an Entity/Matter without
 * resolving its real name. Returns "" if the property is empty.
 */
export function uniqueId(prop: any): string {
  const value = prop?.unique_id;
  if (!value || value.number === null || value.number === undefined) return "";
  return value.prefix ? `${value.prefix}-${value.number}` : String(value.number);
}

/**
 * Retrieves a Notion page's block-children content as plain text, paginating
 * as needed.
 *
 * Two callers, one reader. **Governance pages** (Hat Definitions, Universal
 * Role Contract, etc.) are a flat sequence of a `code` block (the
 * machine-readable yaml definition) followed by prose blocks (the
 * human-readable explanation) — code blocks are tagged so the two stay
 * distinguishable. **An approved Call Notes record's page body** is the other:
 * Strategy reads it as the substantive evidence behind an attested record
 * (see `src/units/strategy/strategyEvidence.ts`), and that live record was
 * verified to hold its evidence as top-level heading / paragraph / list /
 * divider blocks, which is exactly what this function returns.
 *
 * Only top-level blocks are read; nested children are deliberately NOT
 * recursed into — that is the boundary of this helper, not an oversight. If a
 * governed record ever kept its evidence inside toggles, synced blocks,
 * columns, or similar containers, that would be a scope change to approve,
 * never a reason to add a second, recursive retrieval path beside this one.
 * Not a general Notion renderer — just enough to make a page's own text usable
 * as context.
 */
export async function getPageContent(env: Env, pageId: string, access: AccessContext): Promise<string> {
  // Same rule as getPage: the read is authorized against the page's real
  // target, resolved from Notion rather than asserted by the caller.
  const { target } = await resolvePageTarget(env, pageId, "read");
  evaluateAccess(env, { operation: "read", dataSourceId: target, pageId }, access);
  const parts: string[] = [];
  let cursor: string | undefined;
  do {
    const query = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await notionFetch(env, `/blocks/${pageId}/children${query}`);
    for (const block of data.results ?? []) {
      const text = plainTextFromBlock(block);
      if (text) parts.push(text);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return parts.join("\n\n");
}

function plainTextFromBlock(block: any): string {
  const type = block?.type;
  const value = type ? block[type] : undefined;
  const richTextArray = value?.rich_text;
  if (!Array.isArray(richTextArray)) return "";
  const text = richTextArray.map((t: any) => t?.plain_text ?? "").join("");
  if (!text) return "";
  if (type === "code") {
    const language = value.language ?? "";
    return `[CODE${language ? ` language=${language}` : ""}]\n${text}\n[/CODE]`;
  }
  if (typeof type === "string" && type.startsWith("heading_")) {
    return `## ${text}`;
  }
  return text;
}
