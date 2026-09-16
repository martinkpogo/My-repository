import type { Env } from "../../../types";
import { createPage, getPage, plainText, queryDataSource, relation, richText, title } from "../../../notion";
import { aiJson } from "../../../ai";
import { logActivity } from "../../../log";
import { sendHatMessage } from "../../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../../governance";

/**
 * Canonical Notion governance for this Hat. Explicit page ID, not title
 * search, per the Universal Role Contract's evidence rule -- mirrors every
 * other Hat's own SALES_EXECUTIVE_HAT_DEFINITION_PAGE_ID-style constant
 * (see salesExecutive.ts). This is the authoritative source for Lead
 * Discovery's purpose, responsibilities, authority limits, and operating
 * boundary -- never restated as hardcoded rules in this file.
 */
const LEAD_DISCOVERY_HAT_DEFINITION_PAGE_ID = "3ddcb004-e583-8160-b090-c0441ba32279";

const HAT_TARGET_NAME = "Lead Discovery";

export const LEAD_SIGNAL_USAGE = [
  "Send a discovered lead signal as:",
  "/lead",
  "Name: <organisation or person>",
  "Source: <public URL where this was found>",
  "Evidence: <what was found / why this looks like a lead>",
  "Contact: <optional -- email/phone, only if publicly listed>",
  "Entity: <optional -- a Notion Entity page URL/ID, only if you already know this Lead belongs to an existing Entity>",
  "",
  "Name, Source, and Evidence are required. Source must be a real, checkable URL -- Lead Discovery never fabricates a source. Entity, if given, is verified against the referenced record, never searched for -- Lead Discovery does not traverse Notion to resolve identity on its own.",
].join("\n");

export interface ParsedLeadSignal {
  name: string;
  source: string;
  evidence: string;
  contact: string;
  entityRef: string;
}

/**
 * Line-based parsing only -- deliberately no AI involved in reading the raw
 * signal. This is what keeps the discovered identity/contact out of any AI
 * prompt entirely: the fields land in the Leads DB straight from this parse,
 * and only a redacted description (see redactSignalForClassification) ever
 * reaches classifyLeadSignal.
 */
export function parseLeadSignal(body: string): ParsedLeadSignal | null {
  const fields: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*(Name|Source|Evidence|Contact|Entity)\s*:\s*(.*)$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const name = fields.name ?? "";
  const source = fields.source ?? "";
  const evidence = fields.evidence ?? "";
  if (!name || !source || !evidence) return null;
  return { name, source, evidence, contact: fields.contact ?? "", entityRef: fields.entity ?? "" };
}

export function isCheckableUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Replaces the literal discovered name/contact with placeholders before
 * anything reaches an AI call -- the identity itself is never sent, only a
 * sanitized description of the signal and its public source. Best-effort
 * (plain substring substitution), same limitation as identityRedaction.ts's
 * redactIdentityTerms, and used only to screen for genuineness/scope --
 * never to extract or reconstruct the identity.
 */
export function redactSignalForClassification(signal: ParsedLeadSignal): string {
  let evidence = signal.evidence;
  if (signal.name) {
    evidence = evidence.split(signal.name).join("[Organisation/Contact]");
  }
  if (signal.contact) {
    evidence = evidence.split(signal.contact).join("[Contact Details]");
  }
  return `Source: ${signal.source}\nEvidence: ${evidence}`;
}

interface LeadDiscoveryGovernance {
  hatDefinition: string;
  universalRoleContract: string;
}

/**
 * Retrieves the governance this Hat operates under. Returns null if either
 * required source can't be retrieved; callers must treat null as "cannot
 * proceed," never substitute hardcoded text in its place -- mirrors
 * salesExecutive.ts's getSalesExecutiveGovernance contract exactly.
 */
async function getLeadDiscoveryGovernance(env: Env): Promise<LeadDiscoveryGovernance | null> {
  const [hatDefinition, universalRoleContract] = await Promise.all([
    getGovernance(env, LEAD_DISCOVERY_HAT_DEFINITION_PAGE_ID, "Sales -- Lead Discovery Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
  ]);
  if (!hatDefinition || !universalRoleContract) return null;
  return { hatDefinition, universalRoleContract };
}

interface LeadClassification {
  genuine: boolean;
  category: string;
  reason: string;
}

async function classifyLeadSignal(env: Env, redactedSignal: string): Promise<LeadClassification | null> {
  const governance = await getLeadDiscoveryGovernance(env);
  if (!governance) {
    console.error("Lead Discovery classification blocked -- governance retrieval failed");
    return null;
  }

  return aiJson<LeadClassification>(env, {
    taskId: "lead.discovery_classification",
    system: [
      "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for this role -- follow them exactly as written.",
      "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
      governance.universalRoleContract,
      "=== HAT DEFINITION ===",
      governance.hatDefinition,
      "=== TASK (execution mechanics -- not part of the governance above) ===",
      "You are given only a sanitized description of a discovered signal and its public source -- never the discovered identity or contact, per this Hat's authority limits. Decide whether this reads like a genuine, in-scope business lead (a real organisation/person with an evident need this consultancy could address) as opposed to noise, spam, or an out-of-scope situation. Never invent detail not present in the evidence given.",
      'Return JSON: {"genuine": true|false, "category": "<short industry/segment label, or empty string>", "reason": "..."}.',
    ].join("\n\n"),
    user: redactedSignal,
    light: true,
  });
}

interface LeadDuplicateMatch {
  id: string;
  name: string;
}

/**
 * Mechanical, code-only duplicate check against Lead Discovery's own
 * authoritative acquisition record (the Leads database) -- never an AI
 * call, and never a query against Entity. Checking the Leads database for
 * a possible duplicate Lead is explicitly authorized ("Check available
 * authorized context for possible duplicate Leads"); querying Entity by
 * name is not -- the Hat Definition's Execution Requirements say "If an
 * existing Entity is explicitly provided in authorized context and
 * reliably matches, relate the Lead to it; do not discover or traverse to
 * resolve identity," which rules out a name-search against Entity. Never
 * auto-merges; every candidate is surfaced to Martin, per the Universal
 * Role Contract's "never auto-select" rule.
 */
async function findDuplicateLeads(env: Env, name: string, contact: string): Promise<LeadDuplicateMatch[]> {
  const matches: LeadDuplicateMatch[] = [];

  const existingLeads = await queryDataSource(env, env.LEADS_DATA_SOURCE_ID, {
    property: "Lead",
    title: { contains: name },
  });
  for (const p of existingLeads) {
    matches.push({ id: p.id, name: plainText(p.properties.Lead) });
  }

  if (contact) {
    const byContactDetails = await queryDataSource(env, env.LEADS_DATA_SOURCE_ID, {
      property: "Contact Details",
      rich_text: { contains: contact },
    });
    for (const p of byContactDetails) {
      if (!matches.some((m) => m.id === p.id)) {
        matches.push({ id: p.id, name: plainText(p.properties.Lead) });
      }
    }
  }

  return matches.slice(0, 5);
}

type ExplicitEntityResolution =
  | { status: "not_given" }
  | { status: "matched"; entityId: string; entityName: string }
  | { status: "conflict"; entityName: string; note: string }
  | { status: "unresolvable"; note: string };

/**
 * Extracts a Notion page ID from either a raw ID or a pasted notion.so URL.
 * Returns null if the input doesn't contain a recognizable 32-hex-character
 * page ID -- callers must treat that as "cannot resolve," never guess.
 */
function extractNotionPageId(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length < 32) return null;
  const id = hex.slice(-32);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Verifies an explicitly provided Entity reference against the real record
 * -- never searches for one. This is the one Entity-relating path the Hat
 * Definition authorizes: "If an existing Entity is explicitly provided in
 * authorized context and reliably matches, relate the Lead to it; do not
 * discover or traverse to resolve identity." A mismatch, an unparseable
 * reference, or an inaccessible Entity record are all surfaced as-is --
 * never resolved by inference, and never block Lead creation itself
 * (the Lead is still recorded, just without the relation).
 */
async function resolveExplicitEntity(env: Env, entityRef: string, leadName: string): Promise<ExplicitEntityResolution> {
  if (!entityRef) return { status: "not_given" };

  const pageId = extractNotionPageId(entityRef);
  if (!pageId) {
    return { status: "unresolvable", note: `Could not read "${entityRef}" as a Notion page reference -- Entity relation not set.` };
  }

  try {
    const page = await getPage(env, pageId);
    const entityName = plainText(page.properties.Name);
    const a = entityName.toLowerCase();
    const b = leadName.toLowerCase();
    const reliablyMatches = Boolean(a) && (a.includes(b) || b.includes(a));
    if (!reliablyMatches) {
      return {
        status: "conflict",
        entityName,
        note: `The explicitly provided Entity ("${entityName}") does not clearly match the Lead name ("${leadName}") -- Entity relation not set. Review before linking.`,
      };
    }
    return { status: "matched", entityId: page.id, entityName };
  } catch (err) {
    console.error("Lead Discovery: explicit Entity reference could not be verified", err);
    return { status: "unresolvable", note: "Entity access is currently unavailable to verify the explicitly provided reference -- Entity relation not set." };
  }
}

/**
 * Entry point for a Martin-supplied discovery signal (Telegram /lead
 * command, wired independently of SALES_EXECUTIVE_PAUSED in router.ts/
 * index.ts -- Lead Discovery runs in the shared Worker regardless of
 * whether the isolated Sales Executive project's client-facing pipeline
 * is paused). Never creates or modifies an Entity, never qualifies
 * Lead-to-Prospect, never drafts a proposal or quote -- those remain
 * exclusively Sales Executive's authority, per the Hat Definition's
 * Operating Boundary: Lead Discovery owns proactive discovery -> Lead
 * only; Sales Executive owns everything from a response or expression of
 * interest onward.
 */
export async function handleLeadDiscoverySignal(env: Env, chatId: number, threadId: number | undefined, body: string): Promise<void> {
  const target = { chatId, threadId, hat: HAT_TARGET_NAME };

  const signal = parseLeadSignal(body);
  if (!signal) {
    await sendHatMessage(env, target, LEAD_SIGNAL_USAGE);
    return;
  }

  if (!isCheckableUrl(signal.source)) {
    await sendHatMessage(
      env,
      target,
      `Couldn't record this as a Lead -- Source must be a real, checkable URL (http/https). Got: "${signal.source}". Lead Discovery never fabricates or accepts an unverifiable source.`,
    );
    return;
  }

  const classification = await classifyLeadSignal(env, redactSignalForClassification(signal));
  if (!classification) {
    await logActivity(env, {
      entry: `Lead Discovery blocked -- classification unavailable: ${signal.name}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: "Could not retrieve canonical Lead Discovery governance and/or no AI provider was eligible/available. Refusing to record the Lead without it.",
      outcome: "Blocked",
    });
    await sendHatMessage(
      env,
      target,
      `Couldn't screen this signal for *${signal.name}* -- governance retrieval or AI classification failed. Not recorded. Please resend once resolved.`,
    );
    return;
  }

  if (!classification.genuine) {
    await logActivity(env, {
      entry: `Lead signal screened out: ${signal.name}`,
      type: "Discovery",
      area: "Sales",
      decisionRationale: classification.reason,
      outcome: "Complete",
    });
    await sendHatMessage(env, target, `Screened out, not recorded as a Lead: ${classification.reason}`);
    return;
  }

  const entityResolution = await resolveExplicitEntity(env, signal.entityRef, signal.name);

  let duplicates: LeadDuplicateMatch[];
  let page: { url: string };
  try {
    duplicates = await findDuplicateLeads(env, signal.name, signal.contact);
    page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
      Lead: title(signal.name),
      Organisation: richText(signal.name),
      Contact: richText(signal.name),
      "Contact Details": richText(signal.contact),
      Source: richText(signal.source),
      "Discovery Evidence": richText(signal.evidence),
      // "Not started" is the only pre-existing Status option this
      // reconciles to today -- see the Architect-facing note in this
      // module's PR/report about the Leads database Status schema not
      // yet having New/Ready for Outreach/Outreach/Responded/Converted/
      // Closed as distinct options. Lead Discovery only ever sets this
      // one value (its own initial/owned state); it never attempts
      // "Ready for Outreach" or any later-lifecycle value, both because
      // those aren't real options yet and because most of them belong to
      // Sales Executive's own authority regardless.
      Status: { status: { name: "Not started" } },
      ...(entityResolution.status === "matched" ? { Entity: relation([entityResolution.entityId]) } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Lead Discovery: Leads database write/query failed for ${signal.name}`, err);
    await logActivity(env, {
      entry: `Lead Discovery blocked -- Leads database unavailable: ${signal.name}`,
      type: "Blocker",
      area: "Sales",
      decisionRationale: `Notion call against LEADS_DATA_SOURCE_ID failed: ${message}`,
      outcome: "Blocked",
    });
    await sendHatMessage(
      env,
      target,
      `Couldn't record this Lead for *${signal.name}* -- the Leads database call failed: ${message}. Not recorded. This likely means the Worker's Notion integration isn't connected to the Leads database yet -- check its sharing settings.`,
    );
    return;
  }

  const entityNote =
    entityResolution.status === "matched"
      ? `\n\nRelated to existing Entity: ${entityResolution.entityName}.`
      : entityResolution.status === "conflict" || entityResolution.status === "unresolvable"
        ? `\n\n⚠️ ${entityResolution.note}`
        : "";

  await logActivity(env, {
    entry: `Lead recorded: ${signal.name}`,
    type: "Discovery",
    area: "Sales",
    activity: `Category: ${classification.category || "unclassified"}. Source: ${signal.source}.`,
    decisionRationale: [classification.reason, entityResolution.status !== "not_given" && entityResolution.status !== "matched" ? entityResolution.note : ""]
      .filter(Boolean)
      .join(" "),
    nextActions:
      duplicates.length > 0
        ? "Possible duplicate Lead(s) -- Martin to review before Sales Executive picks this up."
        : "Prepared for Sales Executive follow-up.",
    outcome: "Complete",
  });

  const duplicateNote =
    duplicates.length > 0
      ? `\n\n⚠️ Possible duplicate Lead(s) found -- not merged automatically:\n${duplicates.map((d) => `• ${d.name}`).join("\n")}`
      : "";

  // Route/notify toward the isolated Sales Executive environment via the
  // same existing pattern router.ts's SALES_PAUSED_MESSAGE already uses for
  // Sales-bound work -- no new Handoff record, no cross-Hat mechanism.
  // Sales Executive discovers prepared Leads directly from the Leads
  // database (its own environment has full Entity/Matters/Proposals
  // access), the same way it's described as already operating there.
  await sendHatMessage(
    env,
    target,
    `Lead recorded: *${signal.name}*\nCategory: ${classification.category || "unclassified"}\nSource: ${signal.source}\n${page.url}${entityNote}${duplicateNote}\n\nThis is a Lead only -- no Entity created, no qualification performed. Prepared for the isolated Sales Executive environment to pick up from here.`,
  );
}
