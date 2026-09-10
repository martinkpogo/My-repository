import type { Env } from "./types";

const API = "https://api.notion.com/v1";

type NotionPropertyValue = Record<string, unknown>;
export type NotionProperties = Record<string, NotionPropertyValue>;

export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, any>;
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
  filter?: Record<string, unknown>,
  options?: { pageSize?: number; sortByCreatedDescending?: boolean },
): Promise<NotionPage[]> {
  const body: Record<string, unknown> = { page_size: options?.pageSize ?? 20 };
  if (filter) body.filter = filter;
  if (options?.sortByCreatedDescending) {
    body.sorts = [{ timestamp: "created_time", direction: "descending" }];
  }
  const data = await notionFetch(env, `/data_sources/${dataSourceId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (data.results ?? []).map((p: any) => ({ id: p.id, url: p.url, properties: p.properties }));
}

export async function createPage(
  env: Env,
  dataSourceId: string,
  properties: NotionProperties,
): Promise<NotionPage> {
  const data = await notionFetch(env, `/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
    }),
  });
  return { id: data.id, url: data.url, properties: data.properties };
}

export async function updatePage(env: Env, pageId: string, properties: NotionProperties): Promise<NotionPage> {
  const data = await notionFetch(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  return { id: data.id, url: data.url, properties: data.properties };
}

export async function getPage(env: Env, pageId: string): Promise<NotionPage> {
  const data = await notionFetch(env, `/pages/${pageId}`);
  return { id: data.id, url: data.url, properties: data.properties };
}

export function plainText(prop: any): string {
  if (!prop) return "";
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
 * Retrieves a Notion page's block-children content as plain text, paginating
 * as needed. Governance pages (Hat Definitions, Universal Role Contract,
 * etc.) are a flat sequence of a `code` block (the machine-readable yaml
 * definition) followed by prose blocks (the human-readable explanation) —
 * code blocks are tagged so the two stay distinguishable. Only top-level
 * blocks are read; nested children are not recursed into. Not a general
 * Notion renderer — just enough to make a governance page's own text usable
 * as authoritative context.
 */
export async function getPageContent(env: Env, pageId: string): Promise<string> {
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
