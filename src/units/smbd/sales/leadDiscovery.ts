import type { Env } from "../../../types";
import { createPage, plainText, queryDataSource, richText, title } from "../../../notion";
import { aiJson } from "../../../ai";
import { logActivity } from "../../../log";
import { sendHatMessage } from "../../../telegram";
import { getGovernance } from "../../../governance";

/**
 * Canonical Notion source for the Lead Business Object -- the Lead/Entity
 * distinction and the lead_discovery authority list (can/cannot) this
 * module enforces. Fetched live, never restated as hardcoded rules, per
 * the same evidence discipline every other Hat's governance uses.
 */
const LEAD_BUSINESS_OBJECT_PAGE_ID = "3ddcb004-e583-81cc-8a9a-ecb861f061e9";

const HAT_TARGET_NAME = "Lead Discovery";

export const LEAD_SIGNAL_USAGE = [
  "Send a discovered lead signal as:",
  "/lead",
  "Name: <organisation or person>",
  "Source: <public URL where this was found>",
  "Evidence: <what was found / why this looks like a lead>",
  "Contact: <optional -- email/phone, only if publicly listed>",
  "",
  "Name, Source, and Evidence are required. Source must be a real, checkable URL -- Lead Discovery never fabricates a source.",
].join("\n");

export interface ParsedLeadSignal {
  name: string;
  source: string;
  evidence: string;
  contact: string;
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
    const match = line.match(/^\s*(Name|Source|Evidence|Contact)\s*:\s*(.*)$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const name = fields.name ?? "";
  const source = fields.source ?? "";
  const evidence = fields.evidence ?? "";
  if (!name || !source || !evidence) return null;
  return { name, source, evidence, contact: fields.contact ?? "" };
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

interface LeadClassification {
  genuine: boolean;
  category: string;
  reason: string;
}

async function classifyLeadSignal(env: Env, redactedSignal: string): Promise<LeadClassification | null> {
  const governance = await getGovernance(env, LEAD_BUSINESS_OBJECT_PAGE_ID, "Lead Business Object");
  if (!governance) {
    console.error("Lead Discovery classification blocked -- Lead Business Object governance retrieval failed");
    return null;
  }

  return aiJson<LeadClassification>(env, {
    taskId: "lead.discovery_classification",
    system: [
      "You are screening a proactively discovered lead signal for ENIG, a diagnose-first positioning/communications consultancy. Below is the canonical Lead Business Object definition, retrieved from Notion -- authoritative for what counts as a genuine, in-scope Lead. Follow it exactly.",
      "=== LEAD BUSINESS OBJECT (retrieved from Notion's canonical governance) ===",
      governance,
      "=== TASK (execution mechanics -- not part of the governance above) ===",
      "You are given only a sanitized description of the signal and its public source -- never the discovered identity or contact. Decide whether this reads like a genuine, in-scope business lead (a real organisation/person with an evident need this consultancy could address) as opposed to noise, spam, or an out-of-scope situation. Never invent detail not present in the evidence given.",
      'Return JSON: {"genuine": true|false, "category": "<short industry/segment label, or empty string>", "reason": "..."}.',
    ].join("\n\n"),
    user: redactedSignal,
    light: true,
  });
}

interface LeadDuplicateMatch {
  id: string;
  name: string;
  kind: "Lead" | "Entity";
}

/**
 * Mechanical, code-only duplicate check -- mirrors salesExecutive.ts's
 * findEntityMatch exactly for the same reason: identity matching never
 * needs an AI call, and keeping it mechanical means the discovered
 * identity never has to cross into an AI prompt to be deduplicated.
 * Never auto-merges or auto-selects; every candidate is surfaced to
 * Martin, per the Universal Role Contract's "never auto-select" rule.
 */
async function findLeadDuplicates(env: Env, name: string, contact: string): Promise<LeadDuplicateMatch[]> {
  const matches: LeadDuplicateMatch[] = [];

  const existingLeads = await queryDataSource(env, env.LEADS_DATA_SOURCE_ID, {
    property: "Lead",
    title: { contains: name },
  });
  for (const p of existingLeads) {
    matches.push({ id: p.id, name: plainText(p.properties.Lead), kind: "Lead" });
  }

  if (contact) {
    const byContactDetails = await queryDataSource(env, env.LEADS_DATA_SOURCE_ID, {
      property: "Contact Details",
      rich_text: { contains: contact },
    });
    for (const p of byContactDetails) {
      if (!matches.some((m) => m.id === p.id)) {
        matches.push({ id: p.id, name: plainText(p.properties.Lead), kind: "Lead" });
      }
    }
  }

  // Entity is read-only here -- Lead Discovery may check for a possible
  // duplicate against an existing Entity, but per the Lead Business
  // Object's boundary_rule ("identity or discovery evidence alone does
  // not create an Entity") it never writes to ENTITY_DATA_SOURCE_ID.
  //
  // This is explicitly best-effort, not required: this Worker's own
  // Notion integration has had its connection to Entity/Matters/Proposals
  // removed entirely (see SALES_EXECUTIVE_PAUSED's comment in router.ts),
  // so this query is expected to fail in the current deployment. The Lead
  // Business Object's own authority list says Lead Discovery may
  // "identify possible duplicates" -- not that it must -- so a failure
  // here degrades to "no Entity duplicate-check available" rather than
  // blocking Lead creation, which the Leads-only check below still covers.
  try {
    const existingEntities = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Name",
      title: { contains: name },
    });
    for (const p of existingEntities) {
      matches.push({ id: p.id, name: plainText(p.properties.Name), kind: "Entity" });
    }
  } catch (err) {
    console.error("Lead Discovery: Entity duplicate-check unavailable (expected if Entity access is disconnected)", err);
  }

  return matches.slice(0, 5);
}

/**
 * Entry point for a Martin-supplied discovery signal (Telegram /lead
 * command, wired independently of SALES_EXECUTIVE_PAUSED in router.ts/
 * index.ts -- Lead Discovery runs in the shared Worker regardless of
 * whether the isolated Sales Executive project's client-facing pipeline
 * is paused). Never creates or modifies an Entity, never sets Lead status
 * past its initial value, never drafts a proposal or quote -- those
 * remain exclusively Sales Executive's authority.
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
      decisionRationale: "Could not retrieve canonical Lead governance and/or no AI provider was eligible/available. Refusing to record the Lead without it.",
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

  let duplicates: LeadDuplicateMatch[];
  let page: { url: string };
  try {
    duplicates = await findLeadDuplicates(env, signal.name, signal.contact);
    page = await createPage(env, env.LEADS_DATA_SOURCE_ID, {
      Lead: title(signal.name),
      Organisation: richText(signal.name),
      Contact: richText(signal.name),
      "Contact Details": richText(signal.contact),
      Source: richText(signal.source),
      "Discovery Evidence": richText(signal.evidence),
      Status: { status: { name: "Not started" } },
      // Entity relation deliberately left unset -- per the Lead Business
      // Object's boundary_rule, discovery evidence alone never creates or
      // links an Entity. That relation is only ever populated later, by
      // the inbound-enquiry or Sales Executive flow once a response
      // demonstrates real engagement.
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

  await logActivity(env, {
    entry: `Lead recorded: ${signal.name}`,
    type: "Discovery",
    area: "Sales",
    activity: `Category: ${classification.category || "unclassified"}. Source: ${signal.source}.`,
    decisionRationale: classification.reason,
    nextActions: duplicates.length > 0 ? "Possible duplicate(s) -- Martin to review before Sales Executive picks this up." : "Prepared for Sales Executive.",
    outcome: "Complete",
  });

  const duplicateNote =
    duplicates.length > 0
      ? `\n\n⚠️ Possible duplicate(s) found -- not merged automatically:\n${duplicates.map((d) => `• [${d.kind}] ${d.name}`).join("\n")}`
      : "";

  await sendHatMessage(
    env,
    target,
    `Lead recorded: *${signal.name}*\nCategory: ${classification.category || "unclassified"}\nSource: ${signal.source}\n${page.url}${duplicateNote}\n\nThis is a Lead only -- no Entity created, no qualification performed. Sales Executive picks this up from here.`,
  );
}
