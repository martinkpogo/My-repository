import type { Env } from "./types";
import { getPage, plainText } from "./notion";
import { runCheckHandoffs } from "./checkHandoffs";

/**
 * POST /notion/webhook -- the externally-created-Handoff detection path.
 * Complements the runtime's own immediate continuation (checkHandoffs.ts's
 * maybeAutoContinueCheckHandoffs, source: "runtime_auto"): that one fires
 * when a Hat inside THIS Worker queues a Handoff; this one fires when a
 * Handoff is queued directly in Notion by an authorized external writer
 * (today, the isolated Sales Claude Project) -- a human would otherwise
 * have to notice it manually before the next scheduled discovery cycle.
 *
 * This module only detects and triggers the EXISTING discovery/pickup
 * engine (runCheckHandoffs) -- it never writes to Notion itself, never
 * invokes the Sales Claude Project, and never performs identity-sensitive
 * work. See checkHandoffs.ts's discoverPendingSalesHandoffs for how a
 * detected Sales Handoff specifically stays a detect-and-notify-only
 * operation rather than automatic execution.
 */

/**
 * Notion signs every webhook event delivery with HMAC-SHA256 over the raw
 * request body, using the subscription's verification token as the key --
 * arriving hex-encoded, prefixed "sha256=", in the X-Notion-Signature
 * header. Mirrors readai.ts's verifyReadAiSignature exactly (same HMAC
 * verification shape, different key encoding: Notion's token is a plain
 * string, not base64).
 */
export async function verifyNotionSignature(env: Env, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader || !env.NOTION_WEBHOOK_SECRET) return false;
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const providedHex = signatureHeader.slice(expectedPrefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.NOTION_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHex = bytesToHex(new Uint8Array(sigBytes));
  return timingSafeEqualHex(computedHex, providedHex);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Notion's one-time subscription-verification handshake: when a webhook
 * subscription is first created (or re-verified) in the Notion integration
 * dashboard, Notion POSTs a bare { "verification_token": "..." } body to
 * the configured endpoint -- unsigned, since no shared secret exists yet.
 * Martin must copy that token from here (wrangler tail) into the Notion
 * dashboard's verification dialog, and separately into this Worker's own
 * NOTION_WEBHOOK_SECRET (`wrangler secret put`) so subsequent signed
 * deliveries can be verified. Nothing here registers or alters the actual
 * subscription -- it only recognizes and acknowledges Notion's own
 * handshake request.
 */
function extractVerificationToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const token = (payload as Record<string, unknown>).verification_token;
  return typeof token === "string" && token.trim() ? token : null;
}

/**
 * Pulls the affected page id out of a Notion webhook event, when the event
 * is about a page at all. Deliberately minimal: the event is a signal only
 * (per the task's explicit instruction not to assume the payload carries
 * the complete Handoff row) -- the live page is always re-fetched from
 * Notion before any decision is made from it.
 */
function extractPageIdFromEvent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const entity = (payload as Record<string, unknown>).entity;
  if (!entity || typeof entity !== "object") return null;
  const { id, type } = entity as Record<string, unknown>;
  if (type !== "page" || typeof id !== "string" || !id.trim()) return null;
  return id;
}

const ROUTABLE_UNITS = new Set(["Finance", "Sales", "Research & Intelligence", "Marketing", "Strategy"]);

export type HandoffWebhookFilterResult =
  | { relevant: true; toUnit: string; entityToken: string; matterToken: string }
  | { relevant: false; reason: string };

/**
 * The filtering gate described in the architecture's "HANDOFF FILTERING"
 * section -- confirms the webhook-referenced page is genuinely a live,
 * actionable, opaque-token-bearing Pending Work Handoff before the
 * discovery engine is woken up for it at all. This is a smart filter, not
 * a second processing path: the actual claim/pickup decision remains
 * entirely inside runCheckHandoffs's existing discovery functions (each of
 * which re-queries Notion itself and applies claimPendingHandoff's own
 * live-Status idempotency gate) -- this function exists only to avoid
 * waking that engine for events that are obviously not a relevant Handoff.
 */
export function evaluateHandoffPageForWebhook(
  env: Env,
  page: { properties: Record<string, any>; parent?: { data_source_id?: string }; archived?: boolean; inTrash?: boolean },
): HandoffWebhookFilterResult {
  if (page.archived || page.inTrash) {
    return { relevant: false, reason: "page is archived/trashed" };
  }
  if (page.parent?.data_source_id !== env.HANDOFFS_DATA_SOURCE_ID) {
    return { relevant: false, reason: "page does not belong to the canonical Handoffs data source" };
  }
  const type = plainText(page.properties.Type);
  if (type !== "Work") {
    return { relevant: false, reason: `Type is "${type || "(empty)"}", not "Work"` };
  }
  const status = plainText(page.properties.Status);
  if (status !== "Pending") {
    return { relevant: false, reason: `Status is "${status || "(empty)"}", not Pending -- already claimed, held, or closed` };
  }
  const toUnit = plainText(page.properties["To Unit"]);
  if (!ROUTABLE_UNITS.has(toUnit)) {
    return { relevant: false, reason: `"To Unit" ("${toUnit || "(empty)"}") is missing or not a Unit with routing/pickup logic` };
  }
  const entityToken = plainText(page.properties.Entity_Token).trim();
  if (!entityToken) {
    return { relevant: false, reason: "missing Entity_Token" };
  }
  const matterToken = plainText(page.properties.Matter_Token).trim();
  if (!matterToken) {
    return { relevant: false, reason: "missing Matter_Token" };
  }
  return { relevant: true, toUnit, entityToken, matterToken };
}

/**
 * The full /notion/webhook request handler. Deterministic and fail-closed:
 * authentication/verification happens synchronously before anything else,
 * and only a request that passes every gate (signature valid, event is
 * about a page, that page is a genuinely relevant Pending Work Handoff)
 * goes on to wake the discovery engine -- via ctx.waitUntil, so the
 * response returns immediately rather than making Notion's delivery wait
 * on a full 5-Unit discovery sweep.
 */
export async function handleNotionWebhookRequest(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const rawBody = await request.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const signatureHeader = request.headers.get("X-Notion-Signature");

  // The one-time, unsigned verification handshake -- recognized only when
  // there is no signature header at all (a genuine event delivery always
  // carries one once the subscription is verified). Never treated as an
  // event, never used to authenticate anything beyond itself.
  if (!signatureHeader) {
    const verificationToken = extractVerificationToken(payload);
    if (verificationToken) {
      console.log(`Notion webhook verification handshake received -- verification_token: ${verificationToken}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // No signature and not a recognizable handshake -- fail closed.
    return new Response("forbidden", { status: 403 });
  }

  if (!env.NOTION_WEBHOOK_SECRET) {
    console.error("Notion webhook event received but NOTION_WEBHOOK_SECRET is not configured -- rejecting (fail closed)");
    return new Response("forbidden", { status: 403 });
  }
  const validSignature = await verifyNotionSignature(env, rawBody, signatureHeader);
  if (!validSignature) {
    console.error("Notion webhook event rejected -- invalid signature");
    return new Response("forbidden", { status: 403 });
  }

  // Authenticated from here on. The event is a signal only -- the payload
  // is never trusted to carry the complete Handoff row.
  const pageId = extractPageIdFromEvent(payload);
  if (!pageId) {
    // Not a page event (or a page event without an id we can act on) --
    // a routine, expected no-op for the many Notion events this Worker
    // has no reason to react to.
    return new Response(JSON.stringify({ ok: true, ignored: "not a page event" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let page;
  try {
    page = await getPage(env, pageId);
  } catch (err) {
    console.error(`Notion webhook: failed to retrieve page ${pageId}`, err);
    // The event itself was authentic; retrieval failing is an operational
    // problem, not evidence the event was invalid -- report success to
    // Notion (it isn't Notion's fault, and retrying identically won't
    // help) while logging for review, mirroring the existing discovery
    // failure-notification pattern rather than leaving this silent.
    return new Response(JSON.stringify({ ok: false, error: "page retrieval failed, logged" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const filter = evaluateHandoffPageForWebhook(env, page);
  if (!filter.relevant) {
    console.log(`Notion webhook: ignoring page ${pageId} -- ${filter.reason}`);
    return new Response(JSON.stringify({ ok: true, ignored: filter.reason }), { status: 200, headers: { "content-type": "application/json" } });
  }

  // A genuinely relevant Pending Work Handoff, with both opaque tokens
  // present. Wake the existing discovery/pickup engine -- Martin's own DM
  // is the same default front door every other externally-created Handoff
  // (Finance/Research/Marketing/Strategy, and now Sales) already registers
  // against when no live Telegram session exists yet (see
  // discoverPendingFinanceHandoffs et al.). The engine re-queries Notion
  // and re-applies its own claim/pickup gates itself -- this handler's own
  // filter above is only a wake-up decision, never the authority.
  const chatId = Number(env.MARTIN_TELEGRAM_USER_ID);
  ctx.waitUntil(
    runCheckHandoffs(env, chatId, undefined, { source: "notion_webhook" }).catch((err) =>
      console.error(`Notion webhook: runCheckHandoffs failed for page ${pageId}`, err),
    ),
  );

  return new Response(JSON.stringify({ ok: true, detected: { toUnit: filter.toUnit, matterToken: filter.matterToken } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
