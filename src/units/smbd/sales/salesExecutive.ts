import type { Env, WorkState, QualificationResult, QualificationConditionResult } from "../../../types";
import {
  createPage,
  getPage,
  plainText,
  queryDataSource,
  relation,
  richText,
  select,
  title,
  updatePage,
} from "../../../notion";
import { aiJson, aiText } from "../../../ai";
import { logActivity } from "../../../log";
import { sendMessage } from "../../../telegram";
import { getGovernance, UNIVERSAL_ROLE_CONTRACT_PAGE_ID } from "../../../governance";

// Canonical Notion governance sources for this Hat. Explicit page IDs, not
// title search, per the Universal Role Contract's evidence rule (a
// consequential source must be attributable, not guessed at by name match).
const SALES_EXECUTIVE_HAT_DEFINITION_PAGE_ID = "3cfcb004-e583-810f-8281-c448edaa5de6";
// Only needed where an Agent call performs the actual Entity lifecycle
// judgment (qualification) — not fetched for stages where Entity handling
// is already mechanically enforced by code.
const ENTITY_BUSINESS_OBJECT_PAGE_ID = "3cecb004-e583-81a9-b95e-e6ab79a3e5f3";

// Plain-English labels for the Telegram-facing qualification message —
// the raw condition slugs (within_specialization, etc.) stay in the
// Activity Log's decisionRationale for traceability, but Martin shouldn't
// have to read snake_case.
const CONDITION_LABELS: Record<QualificationConditionResult["condition"], string> = {
  within_specialization: "Within our specialization",
  allows_diagnosis_first: "Open to a diagnosis-first approach",
  open_to_ballpark_amount_and_time: "Open to discussing budget & timeline",
  ready_to_commit_required_resources: "Ready to commit the resources needed",
};

function formatQualificationEvidence(conditions: QualificationConditionResult[]): string {
  return conditions
    .map((c) => {
      const label = CONDITION_LABELS[c.condition] ?? c.condition;
      const heading = c.assessment === "Satisfied" ? label : `${label} — ${c.assessment.toLowerCase()}`;
      return `• *${heading}*\n   ${c.evidence}`;
    })
    .join("\n\n");
}

/**
 * Reads the authoritative quote back off the Finance -> SM&BD Handoff's own
 * "Verified Facts & Sources" field, per the same context_transfer discipline
 * Finance's own resolveHandoffBusinessContext applies in the other
 * direction — the receiving Unit reconstructs from the Handoff record
 * itself, never trusts the sending Unit's (or its own prior) session state
 * for a value that crossed a Unit boundary. Returns null on any parse
 * failure; callers must treat null as "cannot proceed."
 */
function parseAuthoritativeQuote(verifiedFactsAndSources: string): { price: number; rationale: string } | null {
  const priceMatch = verifiedFactsAndSources.match(/Authoritative quote:\s*\$([\d,.]+)/);
  if (!priceMatch) return null;
  const price = Number(priceMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(price)) return null;
  const rationaleMatch = verifiedFactsAndSources.match(/Rationale:\s*([\s\S]*)/);
  return { price, rationale: rationaleMatch ? rationaleMatch[1].trim() : "" };
}

interface SalesExecutiveGovernance {
  hatDefinition: string;
  universalRoleContract: string;
  entitySpecification?: string;
}

/**
 * Retrieves the governance this Hat operates under, at the granularity each
 * call site actually needs — Hat Definition + URC always; the Entity
 * specification only where the caller says it's performing a judgment the
 * Entity lifecycle governs. Returns null if any required source can't be
 * retrieved; callers must treat null as "cannot proceed," never substitute
 * hardcoded text in its place (mirrors Finance's getGovernance contract).
 */
async function getSalesExecutiveGovernance(
  env: Env,
  options: { includeEntitySpecification?: boolean } = {},
): Promise<SalesExecutiveGovernance | null> {
  const [hatDefinition, universalRoleContract, entitySpecification] = await Promise.all([
    getGovernance(env, SALES_EXECUTIVE_HAT_DEFINITION_PAGE_ID, "Sales Executive Hat Definition"),
    getGovernance(env, UNIVERSAL_ROLE_CONTRACT_PAGE_ID, "Universal Role Contract"),
    options.includeEntitySpecification
      ? getGovernance(env, ENTITY_BUSINESS_OBJECT_PAGE_ID, "Entity Business Object specification")
      : Promise.resolve(null),
  ]);
  if (!hatDefinition || !universalRoleContract) return null;
  if (options.includeEntitySpecification && !entitySpecification) return null;
  return { hatDefinition, universalRoleContract, entitySpecification: entitySpecification ?? undefined };
}

function buildSalesCallPrepSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for this role — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution context — not part of the governance above) ===",
    "Prepare Martin for a sales call: what we know, what's still unknown, and questions to ask to test the Hat Definition's canonical qualification conditions above. Keep it under 200 words, plain text, no markdown headers.",
  ].join("\n\n");
}

function buildQualificationSystemPrompt(
  hatDefinition: string,
  universalRoleContract: string,
  entitySpecification: string,
): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract, Hat Definition, and Entity Business Object specification are authoritative for evaluating the four canonical qualification conditions — follow them exactly as written. Never infer missing evidence.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== ENTITY BUSINESS OBJECT SPECIFICATION ===",
    entitySpecification,
    "=== RESPONSE FORMAT (execution mechanics — not part of the governance above) ===",
    'Evaluate each of the four canonical qualification conditions named above, strictly from the evidence given. Return JSON: {"conditions":[{"condition":"<canonical condition key, exactly as given above>","evidence":"...","assessment":"Satisfied|Not Satisfied|Insufficient Evidence"}, ...all four...], "overall":"Qualified|Not Qualified|More Information Required"}. overall is Qualified only if ALL four are Satisfied.',
  ].join("\n\n");
}

function buildProposalDraftingSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for the Draft Proposal's required content, structure, and authority limits — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution context — not part of the governance above) ===",
    "Draft the complete client-facing Draft Proposal for the entity/matter/quote data given below, following the Hat Definition's proposal_content_standard exactly (section headers, order, and content rules) and its authority_limits (the quoted price must not be altered, converted, or reinterpreted; internal Finance reasoning not intended for the client must not be disclosed). Keep it concise and professional.",
  ].join("\n\n");
}

function buildProposalRevisionSystemPrompt(hatDefinition: string, universalRoleContract: string): string {
  return [
    "You are executing the Hat defined below, retrieved from ENIG's canonical Notion governance. The Universal Role Contract and Hat Definition are authoritative for how this Draft Proposal may be revised and for the authority limits that apply — follow them exactly as written.",
    "=== UNIVERSAL ROLE CONTRACT (inherited by every Hat) ===",
    universalRoleContract,
    "=== HAT DEFINITION ===",
    hatDefinition,
    "=== TASK (execution context — not part of the governance above) ===",
    "Revise the current Draft Proposal below according to Martin's feedback, keeping the same section structure per the Hat Definition's proposal_content_standard. Per the Hat Definition's authority_limits, you have no authority to change the quoted price — if Martin's feedback appears to require a price change, do not apply it: keep the existing price and add a note prefixed 'NOTE TO MARTIN:' explaining the conflict.",
  ].join("\n\n");
}

export async function handleIncomingEnquiry(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.enquiryText = text;
  await logActivity(env, {
    entry: `Incoming enquiry — work ${state.workId}`,
    type: "Activity",
    area: "SM&BD",
    activity: text,
    outcome: "Active",
  });

  const extracted = await aiJson<{ name?: string; organisation?: string; email?: string; phone?: string }>(env, {
    system:
      "Extract the sender's identifying details from an incoming business enquiry. Return JSON: {name, organisation, email, phone}. Use empty string for anything not present. Never invent a value.",
    user: text,
    light: true,
  });

  const name = extracted?.organisation || extracted?.name || "";
  const email = extracted?.email || "";
  const phone = extracted?.phone || "";

  const match = await findEntityMatch(env, name, email, phone);

  // one_determinate_match: use existing Entity directly — a clean email or
  // phone match doesn't need a confirmation click per the SM&BD AI Project
  // Instructions' entity_identification outcomes.
  if (match.determinate) {
    const page = await getPage(env, match.determinate.id);
    state.entityId = page.id;
    state.entityName = plainText(page.properties.Name);
    await logActivity(env, {
      entry: `Entity matched: ${state.entityName}`,
      type: "Activity",
      area: "SM&BD",
      activity: `Determinate match (email/phone) for incoming enquiry — using existing Entity.`,
      outcome: "Active",
    });
    return proceedToMatterIdentification(env, state);
  }

  const candidates = match.plausible;
  state.candidateEntities = candidates.map((c) => ({ id: c.id, name: c.name }));

  const buttons = [
    ...candidates.map((c) => [{ text: `Use: ${c.name}`, callback_data: `entity:${state.workId}:${c.id}` }]),
    [{ text: `➕ Create new Entity${name ? `: ${name}` : ""}`, callback_data: `entity:${state.workId}:new` }],
  ];

  state.entityDraft = { name: name || "New contact", email, phone, type: extracted?.organisation ? "Organisation" : "Individual" };

  await sendMessage(
    env,
    state.chatId,
    `*New enquiry — Sales Executive*\n\n${text}\n\nIs this an existing Entity, or should I create a new one?`,
    buttons,
    state.threadId,
  );
  state.stage = "awaiting_entity_pick";
  state.awaiting = "entity_pick";
  return state;
}

export async function handleEntityChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    return presentEntityDraft(env, state);
  }

  const page = await getPage(env, choice);
  state.entityId = page.id;
  state.entityName = plainText(page.properties.Name);
  return proceedToMatterIdentification(env, state);
}

/**
 * Shows the drafted new-Entity record to Martin for approval before it's
 * created — per the Universal Role Contract's rule that drafted content is
 * shown in chat for approval before being written to Notion. Nothing is
 * written until handleEntityCreationApproval confirms it.
 */
async function presentEntityDraft(env: Env, state: WorkState): Promise<WorkState> {
  const draft = state.entityDraft ?? { name: "New contact", email: "", phone: "", type: "Individual" };
  state.entityDraft = draft;

  const details = [
    `Name: ${draft.name}`,
    `Type: ${draft.type}`,
    draft.email ? `Email: ${draft.email}` : null,
    draft.phone ? `Phone: ${draft.phone}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  await sendMessage(
    env,
    state.chatId,
    `*Proposed new Entity*\n\n${details}\n\nCreate this Entity?`,
    [
      [
        { text: "✅ Approve", callback_data: `entitynew:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `entitynew:${state.workId}:redo` },
      ],
    ],
    state.threadId,
  );
  state.stage = "awaiting_entity_creation_approval";
  state.awaiting = undefined;
  return state;
}

export async function handleEntityCreationApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(
      env,
      state.chatId,
      "Got it — what should change about this Entity? Tell me what's off or what to take into account, and I'll redraft it.",
      undefined,
      state.threadId,
    );
    state.stage = "entity_redo_requested";
    state.awaiting = "entity_redo_reason";
    return state;
  }

  const draft = state.entityDraft!;
  const page = await createPage(env, env.ENTITY_DATA_SOURCE_ID, {
    Name: title(draft.name),
    "Entity Type": select(draft.type),
    Status: select("Lead"),
    ...(draft.email ? { Email: { email: draft.email } } : {}),
    ...(draft.phone ? { Phone: { phone_number: draft.phone } } : {}),
  });
  state.entityId = page.id;
  state.entityName = draft.name;
  state.entityDraft = undefined;
  await logActivity(env, {
    entry: `Entity created: ${draft.name}`,
    type: "Decision",
    area: "SM&BD",
    decisions: `Created new Entity for work ${state.workId}`,
    decisionRationale: "No existing Entity record matched the incoming enquiry. Approved by Martin.",
    outcome: "Complete",
  });

  return proceedToMatterIdentification(env, state);
}

export async function handleEntityRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const previous = state.entityDraft;
  const extracted = await aiJson<{ name?: string; organisation?: string; email?: string; phone?: string }>(env, {
    system:
      "Extract the sender's identifying details for a business Entity record. Return JSON: {name, organisation, email, phone}. Use empty string for anything not present. Never invent a value.",
    user: `Original enquiry: ${state.enquiryText ?? ""}\n\nPrevious draft: ${JSON.stringify(previous ?? {})}\n\nMartin's redo reasoning: ${reasonText}`,
    light: true,
  });
  const name = extracted?.organisation || extracted?.name || previous?.name || "New contact";
  state.entityDraft = {
    name,
    email: extracted?.email || previous?.email || "",
    phone: extracted?.phone || previous?.phone || "",
    type: extracted?.organisation ? "Organisation" : previous?.type || "Individual",
  };
  return presentEntityDraft(env, state);
}

async function proceedToMatterIdentification(env: Env, state: WorkState): Promise<WorkState> {
  const matters = await queryDataSource(env, env.MATTERS_DATA_SOURCE_ID, {
    property: "Entity",
    relation: { contains: state.entityId },
  });
  const openMatters = matters.filter((m) => {
    const status = plainText(m.properties.Status);
    return status !== "Closed" && status !== "Converted";
  });
  state.candidateMatters = openMatters.map((m) => ({ id: m.id, name: plainText(m.properties.Matter) }));

  const buttons = [
    ...openMatters.map((m) => [
      { text: `Use: ${plainText(m.properties.Matter)}`, callback_data: `matter:${state.workId}:${m.id}` },
    ]),
    [{ text: "➕ New Matter (distinct commercial work)", callback_data: `matter:${state.workId}:new` }],
  ];

  await sendMessage(
    env,
    state.chatId,
    `Entity: *${state.entityName}*.\n\nIs this enquiry part of existing commercial work, or a new Matter?`,
    buttons,
    state.threadId,
  );
  state.stage = "awaiting_matter_pick";
  state.awaiting = "matter_pick";
  return state;
}

export async function handleMatterChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    return draftNewMatter(env, state, state.enquiryText ?? "");
  }

  const page = await getPage(env, choice);
  state.matterId = page.id;
  state.matterName = plainText(page.properties.Matter);
  await ensureEntityIsAtLeastLead(env, state);
  return prepareSalesCall(env, state);
}

/**
 * Drafts a new Matter's title + stated need and presents it to Martin for
 * approval — per the SM&BD AI Project Instructions' Matter identification
 * rule ("pass through the applicable creation authorization gate before
 * creating the Matter record"). Nothing is written to Notion until
 * handleMatterCreationApproval confirms it.
 */
async function draftNewMatter(env: Env, state: WorkState, guidance: string): Promise<WorkState> {
  const summary = await aiJson<{ name: string; stated_need: string }>(env, {
    system:
      "From the enquiry text, produce a short Matter title (max 8 words) and a one-sentence Stated_need. Return JSON {name, stated_need}.",
    user: guidance,
    light: true,
  });
  const name = summary?.name || `Enquiry — ${state.entityName}`;
  const statedNeed = summary?.stated_need || state.enquiryText || "";
  state.matterDraft = { name, statedNeed };

  await sendMessage(
    env,
    state.chatId,
    `*Proposed new Matter*\n\n*${name}*\n${statedNeed}\n\nCreate this Matter?`,
    [
      [
        { text: "✅ Approve", callback_data: `matternew:${state.workId}:approve` },
        { text: "🔁 Redo", callback_data: `matternew:${state.workId}:redo` },
      ],
    ],
    state.threadId,
  );
  state.stage = "awaiting_matter_creation_approval";
  state.awaiting = undefined;
  return state;
}

export async function handleMatterCreationApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(
      env,
      state.chatId,
      "Got it — what should change about this Matter? Tell me what's off or what to take into account, and I'll redraft it.",
      undefined,
      state.threadId,
    );
    state.stage = "matter_redo_requested";
    state.awaiting = "matter_redo_reason";
    return state;
  }

  const draft = state.matterDraft!;
  const page = await createPage(env, env.MATTERS_DATA_SOURCE_ID, {
    Matter: title(draft.name),
    Entity: relation([state.entityId!]),
    Status: select("Open"),
    Stated_need: richText(draft.statedNeed),
    Next_action: richText("Arrange sales call with Martin"),
    Evidence_source: richText(`Telegram enquiry, ${new Date().toISOString()}`),
  });
  state.matterId = page.id;
  state.matterName = draft.name;
  state.matterDraft = undefined;
  await logActivity(env, {
    entry: `Matter created: ${draft.name}`,
    type: "Decision",
    area: "SM&BD",
    decisions: `New distinct unit of commercial work identified for ${state.entityName}.`,
    decisionRationale: "Approved by Martin.",
    outcome: "Complete",
  });

  await ensureEntityIsAtLeastLead(env, state);
  return prepareSalesCall(env, state);
}

export async function handleMatterRedoReason(env: Env, state: WorkState, reasonText: string): Promise<WorkState> {
  const previous = state.matterDraft;
  const guidance = previous
    ? `Original enquiry: ${state.enquiryText ?? ""}\n\nPrevious draft: ${previous.name} — ${previous.statedNeed}\n\nMartin's redo reasoning: ${reasonText}`
    : `${state.enquiryText ?? ""}\n\nMartin's redo reasoning: ${reasonText}`;
  return draftNewMatter(env, state, guidance);
}

async function ensureEntityIsAtLeastLead(env: Env, state: WorkState): Promise<void> {
  const page = await getPage(env, state.entityId!);
  const status = plainText(page.properties.Status);
  if (!status) {
    await updatePage(env, state.entityId!, { Status: select("Lead") });
  }
}

async function prepareSalesCall(env: Env, state: WorkState): Promise<WorkState> {
  const governance = await getSalesExecutiveGovernance(env);
  if (!governance) {
    console.error(`Sales Executive call-prep blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Sales-call preparation blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "SM&BD",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition and/or Universal Role Contract from Notion. Refusing to prepare the call brief without it.",
      outcome: "Blocked",
    });
    // No automatic retry trigger exists at this point in the flow (unlike
    // call notes or proposal feedback, nothing the user sends re-invokes
    // this step) — documented as a known limitation, not solved here.
    await sendMessage(
      env,
      state.chatId,
      `Couldn't prepare the sales-call brief for *${state.entityName}* — couldn't retrieve canonical governance from Notion. There's no automatic retry for this step; please try again once resolved.`,
      undefined,
      state.threadId,
    );
    return state;
  }

  const brief = await aiText(
    env,
    buildSalesCallPrepSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    `Entity: ${state.entityName}\nMatter: ${state.matterName}\nEnquiry: ${state.enquiryText}`,
  );

  await sendMessage(
    env,
    state.chatId,
    `*Sales call prep — ${state.entityName}*\n\n${brief}\n\nWhen the call is done, send me the call notes / insights as a message and I'll process qualification.`,
    [[{ text: "📞 Pull latest Read.ai call", callback_data: `pullcall:${state.workId}:` }]],
    state.threadId,
  );
  await logActivity(env, {
    entry: `Sales call prep sent for ${state.entityName}`,
    type: "Activity",
    area: "SM&BD",
    activity: brief,
    nextActions: "Awaiting Martin's sales call notes.",
    outcome: "Active",
  });
  state.stage = "awaiting_call";
  state.awaiting = "call_notes";
  return state;
}

export async function handleCallNotes(env: Env, state: WorkState, notes: string): Promise<WorkState> {
  state.callNotes = state.callNotes ? `${state.callNotes}\n\n${notes}` : notes;

  await updatePage(env, state.matterId!, {
    Current_understanding: richText(state.callNotes.slice(0, 1900)),
  });

  const governance = await getSalesExecutiveGovernance(env, { includeEntitySpecification: true });
  if (!governance) {
    console.error(`Sales Executive qualification blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Qualification blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "SM&BD",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition, Universal Role Contract, and/or Entity Business Object specification from Notion. Refusing to evaluate qualification without it.",
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `Couldn't evaluate qualification for *${state.entityName}* — couldn't retrieve canonical governance from Notion. Not proceeding without it. Send the call notes again once resolved and I'll re-evaluate.`,
      undefined,
      state.threadId,
    );
    state.awaiting = "call_notes";
    return state;
  }

  const qualification = await aiJson<QualificationResult>(env, {
    system: buildQualificationSystemPrompt(governance.hatDefinition, governance.universalRoleContract, governance.entitySpecification!),
    user: `Enquiry: ${state.enquiryText}\n\nCall notes: ${state.callNotes}`,
  });

  if (!qualification || !Array.isArray(qualification.conditions) || qualification.conditions.length !== 4) {
    await sendMessage(
      env,
      state.chatId,
      "I couldn't determine qualification from the evidence given — the assessment was inconclusive. Please send additional call notes or clarification.",
      undefined,
      state.threadId,
    );
    state.awaiting = "call_notes";
    state.stage = "awaiting_call_clarification";
    return state;
  }

  state.qualification = qualification;
  await logActivity(env, {
    entry: `Qualification evaluated: ${qualification.overall}`,
    type: "Decision",
    area: "SM&BD",
    decisionRationale: qualification.conditions.map((c) => `${c.condition}: ${c.assessment} — ${c.evidence}`).join("\n"),
    outcome: qualification.overall === "Qualified" ? "Active" : "Complete",
  });

  const evidenceText = formatQualificationEvidence(qualification.conditions);

  if (qualification.overall === "Qualified") {
    await sendMessage(
      env,
      state.chatId,
      `*Qualification: Qualified* — all four conditions met.\n\n${evidenceText}\n\nApprove Lead → Prospect for *${state.entityName}*?`,
      [
        [
          { text: "✅ Approve Lead→Prospect", callback_data: `qualify:${state.workId}:approve` },
          { text: "🔁 Redo", callback_data: `qualify:${state.workId}:redo` },
        ],
      ],
      state.threadId,
    );
    state.stage = "awaiting_qualification_approval";
    state.awaiting = undefined;
  } else if (qualification.overall === "More Information Required") {
    await sendMessage(
      env,
      state.chatId,
      `*Qualification: More Information Required*\n\n${evidenceText}\n\nSend the missing information and I'll re-evaluate.`,
      undefined,
      state.threadId,
    );
    state.stage = "awaiting_more_info";
    state.awaiting = "call_notes";
  } else {
    await sendMessage(env, state.chatId, `*Qualification: Not Qualified*\n\n${evidenceText}`, undefined, state.threadId);
    await logActivity(env, {
      entry: `Work item closed — Not Qualified: ${state.entityName}`,
      type: "Activity",
      area: "SM&BD",
      outcome: "Complete",
    });
    state.stage = "closed_not_qualified";
    state.awaiting = undefined;
  }
  return state;
}

export async function handleLeadToProspectApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(
      env,
      state.chatId,
      `Got it — why isn't *${state.entityName}* ready to progress yet? Send what's missing or what to reconsider, and I'll re-evaluate qualification.`,
      undefined,
      state.threadId,
    );
    await logActivity(env, {
      entry: `Lead→Prospect redo requested: ${state.entityName}`,
      type: "Decision",
      area: "SM&BD",
      decisionRationale: "Martin requested a redo of the qualification assessment.",
      outcome: "Blocked",
    });
    state.stage = "qualification_hold";
    state.awaiting = "call_notes";
    return state;
  }

  await updatePage(env, state.entityId!, { Status: select("Prospect") });
  await updatePage(env, state.matterId!, { Status: select("Qualified") });
  await logActivity(env, {
    entry: `Entity progressed to Prospect: ${state.entityName}`,
    type: "Decision",
    area: "SM&BD",
    decisions: "Lead→Prospect approved by Martin.",
    outcome: "Complete",
  });

  await sendMessage(
    env,
    state.chatId,
    `*${state.entityName}* is now a Prospect. What's the proposed intervention (what ENIG would actually do)? Send it as a message — no pricing/budget figures, just the scope.`,
    undefined,
    state.threadId,
  );
  state.stage = "awaiting_intervention";
  state.awaiting = "intervention";
  return state;
}

export async function handleInterventionText(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.proposedIntervention = text;
  await updatePage(env, state.matterId!, {
    Status: select("Commercial Development"),
    Next_action: richText("Awaiting Finance value-based quote"),
  });

  const handoff = await createPage(env, env.HANDOFFS_DATA_SOURCE_ID, {
    Handoff: title(`Quote request — ${state.matterName}`),
    "From Unit": select("SM&BD"),
    "From Hat": richText("Sales Executive"),
    "To Unit": select("Finance"),
    "To Hat": richText("Value-Based Pricing Assessor"),
    Type: select("Work"),
    Status: select("Pending"),
    Reason: richText(`Value-based quote requested for ${state.matterName}.`),
    "Expected Output": richText("Quoted price (USD) and pricing rationale."),
    Matter: relation([state.matterId!]),
    Assumptions: richText("No disclosed budget or willingness-to-pay figure has been provided or should be used."),
    "Verified Facts & Sources": richText(
      `Proposed intervention: ${text}\n\nValue context (enquiry + call notes):\n${[state.enquiryText, state.callNotes].filter(Boolean).join("\n\n")}`.slice(0, 1900),
    ),
  });

  state.handoffId = handoff.id;
  // SM&BD's execution ends here. Finance is a separate Unit and must
  // discover and pick up this Handoff independently (see the scheduled
  // discoverPendingFinanceHandoffs run in index.ts) rather than being
  // invoked in-process from this call. This mapping is how that later,
  // separate invocation finds its way back to this work item.
  await env.STATE_KV.put(`handoff_workitem:${handoff.id}`, state.workId);
  await logActivity(env, {
    entry: `Handoff to Finance created: ${state.matterName}`,
    type: "Activity",
    area: "SM&BD",
    activity: `Handoff ${handoff.id} — quote requested.`,
    nextActions: "Finance to pick up and judge value-based price.",
    outcome: "Active",
  });

  await sendMessage(
    env,
    state.chatId,
    `Got it — routing *${state.matterName}* to Finance for a value-based quote. I'll let you know here once Finance responds.`,
    undefined,
    state.threadId,
  );

  state.stage = "awaiting_quote";
  state.awaiting = undefined;
  return state;
}

export async function handleMoreValueContext(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.proposedIntervention = `${state.proposedIntervention}\n\nAdditional value context: ${text}`;
  // SM&BD's authority here is mechanical only: record the new content and
  // make the Handoff queue-eligible again. This is not a determination that
  // Finance's Hold gate is resolved -- Finance's own judgment in
  // handlePickup (invoked only via independent discovery, never from here)
  // remains the sole authority over sufficiency and the resulting
  // Held/Closed outcome. SM&BD's execution ends here.
  await updatePage(env, state.handoffId!, {
    "Verified Facts & Sources": richText(
      `Proposed intervention + value context:\n${state.proposedIntervention}`.slice(0, 1900),
    ),
    Status: select("Pending"),
  });
  await sendMessage(
    env,
    state.chatId,
    `Got it — added to the Handoff for *${state.entityName}* and queued for Finance to reassess. I'll let you know here once Finance responds.`,
    undefined,
    state.financeThreadId ?? state.threadId,
  );
  return state;
}

/**
 * The SM&BD side of the Finance -> SM&BD execution boundary. Invoked only
 * via runProposalDrafting, itself only invoked by index.ts's scheduled
 * SM&BD-Handoff discovery once a Pending Handoff (the quote Martin
 * approved) addressed to SM&BD is found — never called in-process from
 * Finance's own approval handler.
 */
export async function handleQuoteReceived(env: Env, state: WorkState): Promise<WorkState> {
  const handoff = await getPage(env, state.handoffId!);
  const quote = parseAuthoritativeQuote(plainText(handoff.properties["Verified Facts & Sources"]));
  if (!quote) {
    console.error(`Sales Executive proposal drafting blocked — could not read the authoritative quote from Handoff ${state.handoffId}`);
    await logActivity(env, {
      entry: `Draft Proposal blocked — quote unreadable from Handoff: ${state.entityName}`,
      type: "Blocker",
      area: "SM&BD",
      decisionRationale:
        "Could not read the authoritative Finance quote from the Handoff's own Notion record. Refusing to proceed without it; Handoff left Pending for automatic retry.",
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `Couldn't read the Finance quote for *${state.entityName}* from its Handoff record. Not proceeding without it — will retry automatically on the next discovery cycle.`,
      undefined,
      state.threadId,
    );
    return state;
  }

  const governance = await getSalesExecutiveGovernance(env);
  if (!governance) {
    console.error(`Sales Executive proposal drafting blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Proposal drafting blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "SM&BD",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition and/or Universal Role Contract from Notion. Refusing to draft the Proposal without it; Handoff left Pending for automatic retry.",
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `Couldn't prepare the Draft Proposal for *${state.entityName}* — couldn't retrieve canonical governance from Notion. Will retry automatically on the next discovery cycle.`,
      undefined,
      state.threadId,
    );
    return state;
  }

  // Both checks above must pass BEFORE marking Picked-up, so a transient
  // failure leaves the Handoff Pending for automatic retry rather than
  // stuck — mirrors Finance's own handlePickup ordering.
  state.quote = quote;
  await updatePage(env, state.handoffId!, { Status: select("Picked-up") });

  const draft = await aiText(
    env,
    buildProposalDraftingSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    `Entity: ${state.entityName}\nMatter: ${state.matterName}\nProposed intervention: ${state.proposedIntervention}\nVerified context: ${state.enquiryText}\n${state.callNotes}\nAuthoritative quote: $${state.quote.price} — rationale: ${state.quote.rationale}`,
    { maxTokens: 3000 },
  );

  state.proposalDraft = draft;
  state.proposalRevisionCount = 0;

  await updatePage(env, state.handoffId!, {
    Status: select("Closed"),
    "Work Completed": richText("Draft Proposal prepared and presented to Martin for review."),
  });

  await sendMessage(
    env,
    state.chatId,
    `*Draft Proposal — ${state.entityName}*\n\n${draft}`,
    [
      [
        { text: "✅ Approve & create Proposal", callback_data: `proposal:${state.workId}:approve` },
        { text: "✏️ Request changes", callback_data: `proposal:${state.workId}:revise` },
      ],
    ],
    state.threadId,
  );
  state.stage = "awaiting_proposal_approval";
  state.awaiting = undefined;
  return state;
}

export async function handleProposalApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(env, state.chatId, "What should change in the draft? Send your feedback as a message.", undefined, state.threadId);
    state.stage = "awaiting_proposal_revision";
    state.awaiting = "proposal_feedback";
    return state;
  }

  const page = await createPage(env, env.PROPOSALS_DATA_SOURCE_ID, {
    Proposal: title(`Proposal — ${state.matterName}`),
    Entity: relation([state.entityId!]),
    Matter: relation([state.matterId!]),
    Handoff: relation([state.handoffId!]),
    Status: select("Draft"),
    "Quoted Price": { number: state.quote?.price ?? 0 },
    "Quote Rationale": richText(state.quote?.rationale ?? ""),
  });

  await updatePage(env, state.matterId!, { Status: select("Proposal") });
  await logActivity(env, {
    entry: `Proposal authorized and created (Draft): ${state.matterName}`,
    type: "Decision",
    area: "SM&BD",
    decisions: "Martin authorized the complete Draft Proposal.",
    outcome: "Complete",
  });

  await sendMessage(env, state.chatId, `Proposal created in Draft status: ${page.url}`, undefined, state.threadId);
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

export async function handleProposalFeedback(env: Env, state: WorkState, feedback: string): Promise<WorkState> {
  const governance = await getSalesExecutiveGovernance(env);
  if (!governance) {
    console.error(`Sales Executive proposal revision blocked — governance retrieval failed for work ${state.workId}`);
    await logActivity(env, {
      entry: `Proposal revision blocked — governance retrieval failed: ${state.entityName}`,
      type: "Blocker",
      area: "SM&BD",
      decisionRationale:
        "Could not retrieve canonical Sales Executive Hat Definition and/or Universal Role Contract from Notion. Refusing to revise the Proposal without it.",
      outcome: "Blocked",
    });
    await sendMessage(
      env,
      state.chatId,
      `Couldn't revise the Draft Proposal for *${state.entityName}* — couldn't retrieve canonical governance from Notion. Send your feedback again once resolved and I'll re-apply it.`,
      undefined,
      state.threadId,
    );
    state.awaiting = "proposal_feedback";
    return state;
  }

  const revised = await aiText(
    env,
    buildProposalRevisionSystemPrompt(governance.hatDefinition, governance.universalRoleContract),
    `Current draft:\n${state.proposalDraft}\n\nMartin's feedback:\n${feedback}`,
    { maxTokens: 3000 },
  );
  state.proposalDraft = revised;
  state.proposalRevisionCount = (state.proposalRevisionCount ?? 0) + 1;
  await sendMessage(
    env,
    state.chatId,
    `*Revised Draft Proposal*\n\n${revised}`,
    [
      [
        { text: "✅ Approve & create Proposal", callback_data: `proposal:${state.workId}:approve` },
        { text: "✏️ Request changes", callback_data: `proposal:${state.workId}:revise` },
      ],
    ],
    state.threadId,
  );
  state.stage = "awaiting_proposal_approval";
  state.awaiting = undefined;
  return state;
}

interface EntityMatchResult {
  // Set only when exactly one record matched on a determinate identity
  // signal (email or phone) — per the Entity identification rule's
  // one_determinate_match outcome, this is used directly with no
  // confirmation click. Multiple determinate-signal matches, or any
  // name-only match, are never determinate — they always go to `plausible`
  // for Martin to confirm or reject, per the "never auto-select" rule.
  determinate?: { id: string; name: string };
  plausible: { id: string; name: string }[];
}

async function findEntityMatch(env: Env, name: string, email: string, phone: string): Promise<EntityMatchResult> {
  const determinateMatches: { id: string; name: string }[] = [];
  if (email) {
    const byEmail = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Email",
      email: { equals: email },
    });
    for (const p of byEmail) determinateMatches.push({ id: p.id, name: plainText(p.properties.Name) });
  }
  if (phone) {
    const byPhone = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Phone",
      phone_number: { equals: phone },
    });
    for (const p of byPhone) {
      if (!determinateMatches.some((m) => m.id === p.id)) {
        determinateMatches.push({ id: p.id, name: plainText(p.properties.Name) });
      }
    }
  }

  if (determinateMatches.length === 1) return { determinate: determinateMatches[0], plausible: [] };
  if (determinateMatches.length > 1) return { plausible: determinateMatches.slice(0, 5) };

  // No determinate signal matched — fall back to a fuzzy name search. This
  // is never determinate (a substring match isn't reliable identity
  // evidence), so even a single result here still goes to Martin to
  // confirm rather than being auto-selected.
  if (name) {
    const byName = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Name",
      title: { contains: name },
    });
    return { plausible: byName.map((p) => ({ id: p.id, name: plainText(p.properties.Name) })).slice(0, 5) };
  }
  return { plausible: [] };
}
