import type { Env, WorkState, QualificationResult } from "../types";
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
} from "../notion";
import { aiJson, aiText } from "../ai";
import { logActivity } from "../log";
import { sendMessage } from "../telegram";
import * as finance from "./financeValueBasedPricing";

const QUALIFICATION_CONDITIONS = [
  {
    key: "within_specialization",
    text: "The situation/problem described by the lead falls within ENIG's defined specialization scope (positioning, perception, how the business communicates).",
  },
  {
    key: "allows_diagnosis_first",
    text: "The lead is willing to let ENIG understand and diagnose the underlying situation before committing to a prescribed solution.",
  },
  {
    key: "open_to_ballpark_amount_and_time",
    text: "The lead is open to the indicative level of investment and time communicated during the sales conversation.",
  },
  {
    key: "ready_to_commit_required_resources",
    text: "The lead is prepared to commit the necessary budget, time, internal attention, access, participation, or other resources.",
  },
] as const;

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

  const candidates = await findEntityCandidates(env, name, email);
  state.candidateEntities = candidates.map((c) => ({ id: c.id, name: c.name }));

  const buttons = [
    ...candidates.map((c) => [{ text: `Use: ${c.name}`, callback_data: `entity:${state.workId}:${c.id}` }]),
    [{ text: `➕ Create new Entity${name ? `: ${name}` : ""}`, callback_data: `entity:${state.workId}:new` }],
  ];

  (state as any)._entityDraft = { name: name || "New contact", email, phone: extracted?.phone || "", type: extracted?.organisation ? "Organisation" : "Individual" };

  await sendMessage(
    env,
    state.chatId,
    `*New enquiry — Sales Executive*\n\n${text}\n\nIs this an existing Entity, or should I create a new one?`,
    buttons,
  );
  state.stage = "awaiting_entity_pick";
  state.awaiting = "entity_pick";
  return state;
}

export async function handleEntityChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    const draft = (state as any)._entityDraft ?? { name: "New contact", email: "", phone: "", type: "Individual" };
    const page = await createPage(env, env.ENTITY_DATA_SOURCE_ID, {
      Name: title(draft.name),
      "Entity Type": select(draft.type),
      Status: select("Lead"),
      ...(draft.email ? { Email: { email: draft.email } } : {}),
      ...(draft.phone ? { Phone: { phone_number: draft.phone } } : {}),
    });
    state.entityId = page.id;
    state.entityName = draft.name;
    await logActivity(env, {
      entry: `Entity created: ${draft.name}`,
      type: "Decision",
      area: "SM&BD",
      decisions: `Created new Entity for work ${state.workId}`,
      decisionRationale: "No existing Entity record matched the incoming enquiry.",
      outcome: "Complete",
    });
  } else {
    const page = await getPage(env, choice);
    state.entityId = page.id;
    state.entityName = plainText(page.properties.Name);
  }
  return proceedToMatterIdentification(env, state);
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
  );
  state.stage = "awaiting_matter_pick";
  state.awaiting = "matter_pick";
  return state;
}

export async function handleMatterChoice(env: Env, state: WorkState, choice: string): Promise<WorkState> {
  if (choice === "new") {
    const summary = await aiJson<{ name: string; stated_need: string }>(env, {
      system:
        "From the enquiry text, produce a short Matter title (max 8 words) and a one-sentence Stated_need. Return JSON {name, stated_need}.",
      user: state.enquiryText ?? "",
      light: true,
    });
    const name = summary?.name || `Enquiry — ${state.entityName}`;
    const page = await createPage(env, env.MATTERS_DATA_SOURCE_ID, {
      Matter: title(name),
      Entity: relation([state.entityId!]),
      Status: select("Open"),
      Stated_need: richText(summary?.stated_need ?? state.enquiryText ?? ""),
      Next_action: richText("Arrange sales call with Martin"),
      Evidence_source: richText(`Telegram enquiry, ${new Date().toISOString()}`),
    });
    state.matterId = page.id;
    state.matterName = name;
    await logActivity(env, {
      entry: `Matter created: ${name}`,
      type: "Decision",
      area: "SM&BD",
      decisions: `New distinct unit of commercial work identified for ${state.entityName}.`,
      outcome: "Complete",
    });
  } else {
    const page = await getPage(env, choice);
    state.matterId = page.id;
    state.matterName = plainText(page.properties.Matter);
  }

  await ensureEntityIsAtLeastLead(env, state);
  return prepareSalesCall(env, state);
}

async function ensureEntityIsAtLeastLead(env: Env, state: WorkState): Promise<void> {
  const page = await getPage(env, state.entityId!);
  const status = plainText(page.properties.Status);
  if (!status) {
    await updatePage(env, state.entityId!, { Status: select("Lead") });
  }
}

async function prepareSalesCall(env: Env, state: WorkState): Promise<WorkState> {
  const brief = await aiText(
    env,
    "You are the Sales Executive Hat at ENIG, a diagnose-first positioning/communications consultancy. Prepare Martin for a sales call: what we know, what's still unknown, and questions to ask to test the four qualification conditions (in scope for ENIG, open to diagnosis-first, open to ballpark investment/time, ready to commit resources). Keep it under 200 words, plain text, no markdown headers.",
    `Entity: ${state.entityName}\nMatter: ${state.matterName}\nEnquiry: ${state.enquiryText}`,
  );

  await sendMessage(
    env,
    state.chatId,
    `*Sales call prep — ${state.entityName}*\n\n${brief}\n\nWhen the call is done, send me the call notes / insights as a message and I'll process qualification.`,
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

  const qualification = await aiJson<QualificationResult>(env, {
    system: `You are the Sales Executive Hat. Evaluate each of the four canonical qualification conditions strictly from the evidence given. Never infer missing evidence. Conditions:\n${QUALIFICATION_CONDITIONS.map((c, i) => `${i + 1}. ${c.key}: ${c.text}`).join("\n")}\nReturn JSON: {"conditions":[{"condition":"within_specialization","evidence":"...","assessment":"Satisfied|Not Satisfied|Insufficient Evidence"}, ...all four...], "overall":"Qualified|Not Qualified|More Information Required"}. overall is Qualified only if ALL four are Satisfied.`,
    user: `Enquiry: ${state.enquiryText}\n\nCall notes: ${state.callNotes}`,
  });

  if (!qualification || !Array.isArray(qualification.conditions) || qualification.conditions.length !== 4) {
    await sendMessage(
      env,
      state.chatId,
      "I couldn't determine qualification from the evidence given — the assessment was inconclusive. Please send additional call notes or clarification.",
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

  const evidenceText = qualification.conditions
    .map((c) => `• *${c.condition}*: ${c.assessment}\n   ${c.evidence}`)
    .join("\n\n");

  if (qualification.overall === "Qualified") {
    await sendMessage(
      env,
      state.chatId,
      `*Qualification: Qualified* — all four conditions satisfied.\n\n${evidenceText}\n\nApprove Lead → Prospect for *${state.entityName}*?`,
      [
        [
          { text: "✅ Approve Lead→Prospect", callback_data: `qualify:${state.workId}:approve` },
          { text: "❌ Not yet", callback_data: `qualify:${state.workId}:reject` },
        ],
      ],
    );
    state.stage = "awaiting_qualification_approval";
    state.awaiting = undefined;
  } else if (qualification.overall === "More Information Required") {
    await sendMessage(
      env,
      state.chatId,
      `*Qualification: More Information Required*\n\n${evidenceText}\n\nSend the missing information and I'll re-evaluate.`,
    );
    state.stage = "awaiting_more_info";
    state.awaiting = "call_notes";
  } else {
    await sendMessage(env, state.chatId, `*Qualification: Not Qualified*\n\n${evidenceText}`);
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
    await sendMessage(env, state.chatId, "Understood — Lead→Prospect not approved. Send more context if there's anything further to evaluate.");
    await logActivity(env, {
      entry: `Lead→Prospect not approved: ${state.entityName}`,
      type: "Decision",
      area: "SM&BD",
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
  await logActivity(env, {
    entry: `Handoff to Finance created: ${state.matterName}`,
    type: "Activity",
    area: "SM&BD",
    activity: `Handoff ${handoff.id} — quote requested.`,
    nextActions: "Finance to pick up and judge value-based price.",
    outcome: "Active",
  });

  state.stage = "awaiting_quote";
  state.awaiting = undefined;
  return finance.handlePickup(env, state);
}

export async function handleMoreValueContext(env: Env, state: WorkState, text: string): Promise<WorkState> {
  state.proposedIntervention = `${state.proposedIntervention}\n\nAdditional value context: ${text}`;
  await updatePage(env, state.handoffId!, {
    "Verified Facts & Sources": richText(
      `Proposed intervention + value context:\n${state.proposedIntervention}`.slice(0, 1900),
    ),
  });
  return finance.handlePickup(env, state);
}

export async function handleQuoteReceived(env: Env, state: WorkState): Promise<WorkState> {
  const draft = await aiText(
    env,
    `You are the Sales Executive Hat at ENIG drafting a client-facing Draft Proposal. Follow this exact structure, in order, with these section headers:
Identification | Situation Summary | Objective | Proposed Intervention / Scope | Basis for the Investment | Investment | Timeline / Delivery Schedule | What ENIG Needs from the Client | Next Steps.
Use the authoritative Finance quote and rationale exactly as given for Investment — never alter, convert, or reinterpret the price. Do not disclose internal Finance reasoning not intended for the client; translate it into client-facing value language instead. Do not expose internal budget discussion. Keep it concise and professional. Do not invent a timeline if none is known.`,
    `Entity: ${state.entityName}\nMatter: ${state.matterName}\nProposed intervention: ${state.proposedIntervention}\nVerified context: ${state.enquiryText}\n${state.callNotes}\nAuthoritative quote: $${state.quote?.price} — rationale: ${state.quote?.rationale}`,
  );

  state.proposalDraft = draft;
  state.proposalRevisionCount = 0;
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
  );
  state.stage = "awaiting_proposal_approval";
  state.awaiting = undefined;
  return state;
}

export async function handleProposalApproval(env: Env, state: WorkState, approved: boolean): Promise<WorkState> {
  if (!approved) {
    await sendMessage(env, state.chatId, "What should change in the draft? Send your feedback as a message.");
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

  await sendMessage(env, state.chatId, `Proposal created in Draft status: ${page.url}`);
  state.stage = "complete";
  state.awaiting = undefined;
  return state;
}

export async function handleProposalFeedback(env: Env, state: WorkState, feedback: string): Promise<WorkState> {
  const revised = await aiText(
    env,
    "You are the Sales Executive Hat revising a client-facing Draft Proposal based on Martin's feedback. Keep the same section structure. Never alter the authoritative quoted price unless Martin's feedback explicitly instructs a price change (it does not have authority to invent a new price on its own — if feedback implies a price change, keep the existing price and flag the conflict in a note prefixed 'NOTE TO MARTIN:').",
    `Current draft:\n${state.proposalDraft}\n\nMartin's feedback:\n${feedback}`,
  );
  state.proposalDraft = revised;
  state.proposalRevisionCount = (state.proposalRevisionCount ?? 0) + 1;
  await sendMessage(env, state.chatId, `*Revised Draft Proposal*\n\n${revised}`, [
    [
      { text: "✅ Approve & create Proposal", callback_data: `proposal:${state.workId}:approve` },
      { text: "✏️ Request changes", callback_data: `proposal:${state.workId}:revise` },
    ],
  ]);
  state.stage = "awaiting_proposal_approval";
  state.awaiting = undefined;
  return state;
}

async function findEntityCandidates(env: Env, name: string, email: string): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = [];
  if (email) {
    const byEmail = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Email",
      email: { equals: email },
    });
    for (const p of byEmail) results.push({ id: p.id, name: plainText(p.properties.Name) });
  }
  if (results.length === 0 && name) {
    const byName = await queryDataSource(env, env.ENTITY_DATA_SOURCE_ID, {
      property: "Name",
      title: { contains: name },
    });
    for (const p of byName) results.push({ id: p.id, name: plainText(p.properties.Name) });
  }
  return results.slice(0, 5);
}
