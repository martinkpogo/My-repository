import test from "node:test";
import assert from "node:assert";
import {
  beginOperatorResearch,
  completeOperatorResearch,
  FALLBACK_BRIEF_QUESTIONS,
  handleOperatorResearchButton,
  handleOperatorResearchReply,
  identityProblem,
  OPERATOR_RESEARCH_AWAITING,
  parseResearchCommand,
  validTypos,
  BRIEF_QUESTION_INSTRUCTIONS,
  proposeHatResearch,
  shouldOfferHatBrief,
  completeHatResearch,
  failHatResearch,
  type BriefQuestionAnswer,
  type OperatorResearchDeps,
} from "./operatorResearch";
import {
  AccessDeniedError,
  EXTERNAL_EGRESS_TARGET,
  NON_GOVERNED_PAGE_TARGET,
  evaluateAccess,
  operatorResearchContext,
  systemContext,
  workSessionReadContext,
} from "../access";
import type { ResearchSynthesis } from "./research/types";

// Martin-started research (Build Decision, 15 Nov 2026): /research and
// /deep_research, owned by no Unit or Hat, run under operator_research.

const RESEARCH_DS = "research-ds";
const env = {
  RESEARCH_DATA_SOURCE_ID: RESEARCH_DS,
  ENTITY_DATA_SOURCE_ID: "entities-ds",
  MATTERS_DATA_SOURCE_ID: "matters-ds",
  PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
  HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
  LEADS_DATA_SOURCE_ID: "leads-ds",
  ACTIVITY_LOG_DATA_SOURCE_ID: "log-ds",
  CALL_NOTES_DATA_SOURCE_ID: "callnotes-ds",
  PAYMENTS_DATA_SOURCE_ID: "payments-ds",
} as any;

function harness(answers: Array<BriefQuestionAnswer | null> = []) {
  const sent: Array<{ text: string; buttons?: unknown }> = [];
  const saved: ResearchSynthesis[] = [];
  const deps: OperatorResearchDeps = {
    send: async (_e, _s, text, buttons) => void sent.push({ text, buttons }),
    nextQuestion: async () => (answers.length ? answers.shift()! : null),
    saveToNotion: async (_e, _s, synthesis) => {
      saved.push(synthesis);
      return "https://notion.example/research-1";
    },
  };
  const state = { workId: "w-1", chatId: 1, threadId: 604, stage: "new", createdAt: "", updatedAt: "" } as any;
  return { deps, sent, saved, state };
}

function callbacks(sent: { buttons?: unknown }): string[] {
  return ((sent.buttons as Array<Array<{ callback_data: string }>>) ?? []).flat().map((b) => b.callback_data);
}

const SYNTHESIS: ResearchSynthesis = {
  sources: [{ id: "s1", source: "news.example", sourceType: "secondary", url: "https://news.example/a", passage: "p", claimSupported: "c", validationStatus: "validated" }],
  evidence: [{ id: "e1", statement: "SMEs report sameness", sourceIds: ["s1"] }],
  findings: [{ id: "f1", statement: "Differentiation is a reported problem", evidenceIds: ["e1"] }],
  implications: [],
  limitations: [],
  protocolsUsed: [],
} as any;

test("parseResearchCommand: /research and /deep_research, with or without a topic; nothing else", () => {
  assert.deepStrictEqual(parseResearchCommand("/research"), { mode: "light_search", topic: "" });
  assert.deepStrictEqual(parseResearchCommand("/deep_research why SMEs struggle"), { mode: "deep_research", topic: "why SMEs struggle" });
  assert.strictEqual(parseResearchCommand("/researcher"), null);
  assert.strictEqual(parseResearchCommand("research this"), null);
});

test("identityProblem refuses record tokens, contact details, links and ENIG/Martin -- and passes a general topic", () => {
  assert.ok(identityProblem("pricing for MAT-20"));
  assert.ok(identityProblem("email ama@example.com"));
  assert.ok(identityProblem("see https://example.com"));
  assert.ok(identityProblem("how ENIG compares"));
  assert.strictEqual(identityProblem("Why do Accra SMEs struggle to stand out?"), null);
});

test("light flow: topic -> two questions one at a time -> brief -> Start schedules the job with the answers as its brief, never as evidence", async () => {
  const h = harness([{ question: "What is it for?" }, { question: "Which sector?" }]);
  let state = await beginOperatorResearch(env, h.state, "light_search", "", h.deps);
  assert.strictEqual(state.awaiting, OPERATOR_RESEARCH_AWAITING);
  assert.match(h.sent[0].text, /What do you want to research/);
  state = await handleOperatorResearchReply(env, state, "Why Accra SMEs struggle to stand out", h.deps);
  assert.match(h.sent[1].text, /Question 1 of up to 2:\nWhat is it for\?/);
  assert.deepStrictEqual(callbacks(h.sent[1]), ["oresearch:w-1:skip", "oresearch:w-1:enough"]);
  state = await handleOperatorResearchReply(env, state, "A LinkedIn post", h.deps);
  assert.match(h.sent[2].text, /Which sector\?/);
  state = await handleOperatorResearchReply(env, state, "Retail", h.deps);
  assert.match(h.sent[3].text, /brief/);
  assert.match(h.sent[3].text, /What is it for\? A LinkedIn post/);
  assert.deepStrictEqual(callbacks(h.sent[3]), ["oresearch:w-1:start", "oresearch:w-1:edit"]);
  const { state: started, schedule } = await handleOperatorResearchButton(env, state, "start", h.deps);
  assert.strictEqual(started.stage, "researching");
  assert.strictEqual(started.awaiting, undefined);
  assert.strictEqual(schedule?.question, "Why Accra SMEs struggle to stand out");
  assert.strictEqual(schedule?.mode, "light_search");
  assert.match(schedule?.brief ?? "", /A LinkedIn post[\s\S]*Retail/);
  assert.strictEqual(schedule?.context, undefined, "the brief is never supplied as evidence");
});

test("the topic can be given with the command, and the AI's absence falls back to the fixed questions", async () => {
  const h = harness([]);
  await beginOperatorResearch(env, h.state, "deep_research", "SME positioning in Ghana", h.deps);
  assert.match(h.sent[0].text, new RegExp(`Question 1 of up to 5:\\n${FALLBACK_BRIEF_QUESTIONS[0].replace(/[?()-]/g, "\\$&")}`));
});

test("Skip records nothing, 'That's enough' goes straight to the brief, Edit -> Start over starts over", async () => {
  const h = harness([]);
  let state = await beginOperatorResearch(env, h.state, "deep_research", "SME positioning", h.deps);
  ({ state } = await handleOperatorResearchButton(env, state, "skip", h.deps));
  assert.match(h.sent.at(-1)!.text, /Question 2 of up to 5/);
  ({ state } = await handleOperatorResearchButton(env, state, "enough", h.deps));
  assert.match(h.sent.at(-1)!.text, /brief/);
  assert.doesNotMatch(h.sent.at(-1)!.text, /What is this research for/, "a skipped question is not in the brief");
  ({ state } = await handleOperatorResearchButton(env, state, "edit", h.deps));
  assert.match(h.sent.at(-1)!.text, /What would you like to change/);
  assert.strictEqual(state.operatorResearch?.topic, "SME positioning", "Edit alone keeps the brief");
  ({ state } = await handleOperatorResearchButton(env, state, "restart", h.deps));
  assert.strictEqual(state.operatorResearch?.phase, "topic");
  assert.strictEqual(state.operatorResearch?.answers.length, 0);
  assert.strictEqual(state.awaiting, OPERATOR_RESEARCH_AWAITING);
});

async function briefWithTwoAnswers(h: ReturnType<typeof harness>) {
  let state = await beginOperatorResearch(env, h.state, "light_search", "Why Acrca SMEs struggle", h.deps);
  state = await handleOperatorResearchReply(env, state, "A LinkdIn post", h.deps);
  state = await handleOperatorResearchReply(env, state, "Retail", h.deps);
  return state;
}

test("Edit asks what to change: one button per brief line (skipped questions excluded), plus Start over", async () => {
  const h = harness([{ question: "What is it for?" }, { question: "Which sector?" }]);
  let state = await beginOperatorResearch(env, h.state, "deep_research", "SME positioning", h.deps);
  state = await handleOperatorResearchReply(env, state, "A post", h.deps);
  ({ state } = await handleOperatorResearchButton(env, state, "skip", h.deps));
  ({ state } = await handleOperatorResearchButton(env, state, "enough", h.deps));
  ({ state } = await handleOperatorResearchButton(env, state, "edit", h.deps));
  const prompt = h.sent.at(-1)!;
  assert.match(prompt.text, /Topic: SME positioning\nAnswer 1: What is it for\? A post/);
  assert.doesNotMatch(prompt.text, /Which sector/, "a skipped question is not offered");
  assert.deepStrictEqual(callbacks(prompt), ["oresearch:w-1:edit_topic", "oresearch:w-1:edit_0", "oresearch:w-1:restart"]);
  assert.strictEqual(state.operatorResearch?.answers.length, 2, "nothing was discarded");
});

test("correcting the topic or one answer keeps everything else and shows the updated brief", async () => {
  const h = harness([{ question: "What is it for?" }, { question: "Which sector?" }]);
  let state = await briefWithTwoAnswers(h);
  ({ state } = await handleOperatorResearchButton(env, state, "edit", h.deps));
  ({ state } = await handleOperatorResearchButton(env, state, "edit_topic", h.deps));
  assert.match(h.sent.at(-1)!.text, /Send the corrected topic\.\n\nNow: Why Acrca SMEs struggle/);
  assert.strictEqual(state.operatorResearch?.phase, "editing");
  state = await handleOperatorResearchReply(env, state, "Why Accra SMEs struggle", h.deps);
  assert.match(h.sent.at(-1)!.text, /brief\n\nTopic: Why Accra SMEs struggle\n- What is it for\? A LinkdIn post\n- Which sector\? Retail/);
  assert.deepStrictEqual(callbacks(h.sent.at(-1)!), ["oresearch:w-1:start", "oresearch:w-1:edit"]);

  ({ state } = await handleOperatorResearchButton(env, state, "edit", h.deps));
  ({ state } = await handleOperatorResearchButton(env, state, "edit_0", h.deps));
  assert.match(h.sent.at(-1)!.text, /corrected answer to:\nWhat is it for\?\n\nNow: A LinkdIn post/);
  state = await handleOperatorResearchReply(env, state, "A LinkedIn post", h.deps);
  assert.deepStrictEqual(state.operatorResearch?.answers, [
    { question: "What is it for?", answer: "A LinkedIn post" },
    { question: "Which sector?", answer: "Retail" },
  ]);
  const { schedule } = await handleOperatorResearchButton(env, state, "start", h.deps);
  assert.strictEqual(schedule?.question, "Why Accra SMEs struggle");
  assert.match(schedule?.brief ?? "", /A LinkedIn post[\s\S]*Retail/);
});

test("a correction gets the same identity checks as the original and a refused one keeps the old line", async () => {
  const h = harness([{ question: "What is it for?" }, { question: "Which sector?" }]);
  let state = await briefWithTwoAnswers(h);
  ({ state } = await handleOperatorResearchButton(env, state, "edit_1", h.deps));
  state = await handleOperatorResearchReply(env, state, "see https://example.com", h.deps);
  assert.match(h.sent.at(-1)!.text, /Please rephrase that -- it contains/);
  assert.strictEqual(state.operatorResearch?.phase, "editing");
  assert.strictEqual(state.operatorResearch?.answers[1].answer, "Retail");

  const seen: string[] = [];
  h.deps.nextQuestion = async (_e, r) => {
    seen.push(r.answers.at(-1)?.answer ?? "");
    return { names_party: true };
  };
  ({ state } = await handleOperatorResearchButton(env, state, "edit_0", h.deps));
  state = await handleOperatorResearchReply(env, state, "The one Kofi runs", h.deps);
  assert.deepStrictEqual(seen, ["The one Kofi runs"], "the AI judges the edited answer as the latest one");
  assert.match(h.sent.at(-1)!.text, /seems to name a specific person or organisation/);
  assert.strictEqual(state.operatorResearch?.answers[0].answer, "A LinkdIn post", "the old answer stays");

  h.deps.nextQuestion = async () => null;
  ({ state } = await handleOperatorResearchButton(env, state, "edit_topic", h.deps));
  state = await handleOperatorResearchReply(env, state, "ab", h.deps);
  assert.match(h.sent.at(-1)!.text, /too short/);
  assert.strictEqual(state.operatorResearch?.topic, "Why Acrca SMEs struggle");
});

test("edit buttons outside the brief, or for a line that does not exist, change nothing", async () => {
  const h = harness([{ question: "What is it for?" }, { question: "Which sector?" }]);
  let state = await briefWithTwoAnswers(h);
  ({ state } = await handleOperatorResearchButton(env, state, "edit_7", h.deps));
  assert.match(h.sent.at(-1)!.text, /no longer current/);
  assert.strictEqual(state.operatorResearch?.phase, "brief");
  ({ state } = await handleOperatorResearchButton(env, state, "start", h.deps));
  for (const value of ["edit", "edit_topic", "restart"]) {
    const { schedule } = await handleOperatorResearchButton(env, state, value, h.deps);
    assert.strictEqual(schedule, null);
    assert.match(h.sent.at(-1)!.text, /no longer current/);
    assert.strictEqual(state.operatorResearch?.phase, "researching");
  }
});

test("a topic or answer naming a party is never rewritten: Martin is asked to rephrase", async () => {
  const h = harness([]);
  let state = await beginOperatorResearch(env, h.state, "light_search", "", h.deps);
  state = await handleOperatorResearchReply(env, state, "what MAT-20 needs", h.deps);
  assert.match(h.sent.at(-1)!.text, /rephrase the topic/);
  assert.strictEqual(state.operatorResearch?.topic, undefined);

  const flagged = harness([{ names_party: true }]);
  let s2 = await beginOperatorResearch(env, flagged.state, "light_search", "", flagged.deps);
  s2 = await handleOperatorResearchReply(env, s2, "What Acme Ltd's customers think", flagged.deps);
  assert.match(flagged.sent.at(-1)!.text, /seems to name a specific person or organisation/);
  assert.strictEqual(s2.operatorResearch?.phase, "topic");

  const answer = harness([{ question: "Which market?" }, { names_party: true }]);
  let s3 = await beginOperatorResearch(env, answer.state, "light_search", "SME positioning", answer.deps);
  s3 = await handleOperatorResearchReply(env, s3, "The one Kofi runs", answer.deps);
  assert.match(answer.sent.at(-1)!.text, /That answer seems to name/);
  assert.strictEqual(s3.operatorResearch?.answers.length, 0, "the answer was dropped");
  assert.strictEqual(s3.operatorResearch?.current, "Which market?", "the same question is asked again");
});

test("completion: findings card with the Research page link, Go deeper on a light result, and Go deeper reuses the same brief", async () => {
  const h = harness([{ question: "What is it for?" }]);
  let state = await beginOperatorResearch(env, h.state, "light_search", "SME positioning", h.deps);
  state = await handleOperatorResearchReply(env, state, "A post", h.deps);
  ({ state } = await handleOperatorResearchButton(env, state, "enough", h.deps));
  const first = await handleOperatorResearchButton(env, state, "start", h.deps);
  state = await completeOperatorResearch(env, first.state, SYNTHESIS, h.deps);
  assert.strictEqual(state.stage, "complete");
  assert.strictEqual(h.saved.length, 1);
  const card = h.sent.at(-1)!;
  assert.match(card.text, /Differentiation is a reported problem \(https:\/\/news\.example\/a\)/);
  assert.match(card.text, /Saved to the Research database: https:\/\/notion\.example\/research-1/);
  assert.deepStrictEqual(callbacks(card), ["oresearch:w-1:deeper"]);
  const deeper = await handleOperatorResearchButton(env, state, "deeper", h.deps);
  assert.strictEqual(deeper.schedule?.mode, "deep_research");
  assert.strictEqual(deeper.schedule?.question, first.schedule?.question);
  assert.strictEqual(deeper.schedule?.brief, first.schedule?.brief, "no question is asked again");
  const done = await completeOperatorResearch(env, deeper.state, SYNTHESIS, h.deps);
  assert.deepStrictEqual(callbacks(h.sent.at(-1)!), [], "a deep result has no Go deeper");
  assert.strictEqual(done.operatorResearch?.mode, "deep_research");
});

test("a stale button changes nothing", async () => {
  const h = harness([]);
  const state = await beginOperatorResearch(env, h.state, "light_search", "", h.deps);
  const { schedule } = await handleOperatorResearchButton(env, state, "start", h.deps);
  assert.strictEqual(schedule, null);
  assert.match(h.sent.at(-1)!.text, /no longer current/);
});

test("the question-writing instructions aim at what Martin wants to find out, not at the subject's own details", () => {
  const p = BRIEF_QUESTION_INSTRUCTIONS;
  assert.match(p, /topic is often a description of a kind of business/);
  assert.match(p, /not about the subject's own clients or operations/);
  assert.match(p, /first question asks what they want to find out/);
  assert.match(p, /Never ask a question that only narrows the wording of the previous answer/);
  for (const field of ['"names_party"', '"enough"', '"question"', '"typos"']) assert.ok(p.includes(field), field);
});

// ---------------------------------------------------------------------------
// Typo suggestions on the brief
// ---------------------------------------------------------------------------

test("the brief shows the AI's typo suggestions; Fix typos corrects Martin's words only and the job uses the corrected brief", async () => {
  const h = harness([
    { question: "What is it for?" },
    { question: "Which sector?" },
    { typos: [{ wrong: "Acrca", right: "Accra" }, { wrong: "LinkdIn", right: "LinkedIn" }] },
  ]);
  let state = await beginOperatorResearch(env, h.state, "light_search", "Why Acrca SMEs struggle in Acrca", h.deps);
  state = await handleOperatorResearchReply(env, state, "A LinkdIn post", h.deps);
  state = await handleOperatorResearchReply(env, state, "Retail", h.deps);
  const brief = h.sent.at(-1)!;
  assert.match(brief.text, /Possible typos: "Acrca" → "Accra", "LinkdIn" → "LinkedIn"/);
  assert.deepStrictEqual(callbacks(brief), ["oresearch:w-1:fixtypos", "oresearch:w-1:start", "oresearch:w-1:edit"]);
  assert.strictEqual(state.operatorResearch?.topic, "Why Acrca SMEs struggle in Acrca", "nothing is changed until Martin taps Fix typos");

  ({ state } = await handleOperatorResearchButton(env, state, "fixtypos", h.deps));
  assert.strictEqual(state.operatorResearch?.topic, "Why Accra SMEs struggle in Accra");
  assert.strictEqual(state.operatorResearch?.answers[0].answer, "A LinkedIn post");
  assert.strictEqual(state.operatorResearch?.answers[0].question, "What is it for?", "questions are never touched");
  const fixed = h.sent.at(-1)!;
  assert.doesNotMatch(fixed.text, /Possible typos/);
  assert.deepStrictEqual(callbacks(fixed), ["oresearch:w-1:start", "oresearch:w-1:edit"]);
  const { schedule } = await handleOperatorResearchButton(env, state, "start", h.deps);
  assert.strictEqual(schedule?.question, "Why Accra SMEs struggle in Accra");
  assert.match(schedule?.brief ?? "", /A LinkedIn post/);
});

test("Start as is keeps Martin's words exactly, and Fix typos is stale once nothing is suggested", async () => {
  const h = harness([{ question: "What is it for?" }, { enough: true, typos: [{ wrong: "postt", right: "post" }] }]);
  let state = await beginOperatorResearch(env, h.state, "deep_research", "SME positioning", h.deps);
  state = await handleOperatorResearchReply(env, state, "A postt", h.deps);
  assert.match(h.sent.at(-1)!.text, /"postt" → "post"/, "the reply that ends the questions carries the suggestions -- no second AI call");
  const { schedule } = await handleOperatorResearchButton(env, state, "start", h.deps);
  assert.match(schedule?.brief ?? "", /A postt/);
  ({ state } = await handleOperatorResearchButton(env, state, "fixtypos", h.deps));
  assert.match(h.sent.at(-1)!.text, /no longer current/);

  const plain = harness([]);
  let s2 = await beginOperatorResearch(env, plain.state, "light_search", "SME positioning", plain.deps);
  ({ state: s2 } = await handleOperatorResearchButton(env, s2, "enough", plain.deps));
  assert.deepStrictEqual(callbacks(plain.sent.at(-1)!), ["oresearch:w-1:start", "oresearch:w-1:edit"], "no AI reply: the brief as before");
  ({ state: s2 } = await handleOperatorResearchButton(env, s2, "fixtypos", plain.deps));
  assert.match(plain.sent.at(-1)!.text, /no longer current/);
});

test("validTypos keeps only small whole-word spelling fixes to Martin's own words that stay identity-clean", () => {
  const research = {
    mode: "light_search" as const,
    phase: "brief" as const,
    topic: "Retial pricing in Acrca",
    answers: [
      { question: "Which markt?", answer: "Ghana" },
      { question: "Skipped?", answer: null },
    ],
  };
  assert.deepStrictEqual(validTypos(research, [{ wrong: "Retial", right: "Retail" }]), [{ wrong: "Retial", right: "Retail" }]);
  assert.deepStrictEqual(validTypos(research, "Retial -> Retail"), [], "malformed: dropped");
  assert.deepStrictEqual(validTypos(research, [{ wrong: "markt", right: "market" }]), [], "only in a question");
  assert.deepStrictEqual(validTypos(research, [{ wrong: "Ret", right: "Rat" }]), [], "part of a word");
  assert.deepStrictEqual(validTypos(research, [{ wrong: "Ghana", right: "Ghana" }]), [], "no change");
  assert.deepStrictEqual(validTypos(research, [{ wrong: "Ghana", right: "x".repeat(41) }]), [], "too long");
  assert.deepStrictEqual(validTypos(research, [{ wrong: "Ghana", right: "ama@example.com" }]), [], "the corrected text must pass the identity check");
  assert.deepStrictEqual(validTypos(research, [{ wrong: "Acrca", right: "ENIG" }]), [], "never introduces ENIG or Martin");
  assert.strictEqual(
    validTypos({ ...research, topic: "aa bb cc dd" }, ["aa", "bb", "cc", "dd"].map((w) => ({ wrong: w, right: w + "x" }))).length,
    3,
    "at most three",
  );
});

test("a brief reached at the question limit is checked by the AI too: a named party drops the last answer", async () => {
  const h = harness([{ question: "What is it for?" }, { question: "Which sector?" }, { names_party: true }]);
  let state = await beginOperatorResearch(env, h.state, "light_search", "SME positioning", h.deps);
  state = await handleOperatorResearchReply(env, state, "A post", h.deps);
  state = await handleOperatorResearchReply(env, state, "The one Kofi runs", h.deps);
  assert.match(h.sent.at(-1)!.text, /That answer seems to name/);
  assert.strictEqual(state.operatorResearch?.phase, "questions");
  assert.strictEqual(state.operatorResearch?.current, "Which sector?");
  assert.strictEqual(state.operatorResearch?.answers.length, 1);
});

// ---------------------------------------------------------------------------
// A Hat's deep-research brief on its own Work (Martin, 16 Nov 2026)
// ---------------------------------------------------------------------------

const PROPOSAL = {
  neededFor: "Designing the free-consultation campaign to build a mailing list",
  topic: "Which free offers get SMEs to join a consultancy's mailing list?",
  lines: [
    { question: "Who is it for?", answer: "SMEs considering branding help" },
    { question: "Anything to leave out?", answer: "Ask ama@example.com" },
  ],
  lightQuestion: "What free offers do SMEs sign up for?",
};

function hatWork() {
  const h = harness([]);
  h.state.unit = "Marketing";
  h.state.hat = "Campaign & Marketing Communications Manager";
  h.state.stage = "awaiting_research";
  return h;
}

test("a Hat's brief: same card as /research, says who prepared it and what for, nothing researched, the Hat's stage kept", async () => {
  const h = hatWork();
  const state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  const card = h.sent.at(-1)!;
  assert.match(card.text, /Deep research brief, prepared by Campaign & Marketing Communications Manager\nNeeded for: Designing the free-consultation campaign/);
  assert.match(card.text, /Nothing is researched until you tap Start/);
  assert.match(card.text, /Topic: Which free offers get SMEs to join a consultancy's mailing list\?\n- Who is it for\? SMEs considering branding help/);
  assert.doesNotMatch(card.text, /ama@example.com/, "a line failing the identity check is left out");
  assert.deepStrictEqual(callbacks(card), ["oresearch:w-1:start", "oresearch:w-1:edit", "oresearch:w-1:skipresearch"]);
  assert.strictEqual(state.stage, "awaiting_research", "the Hat still holds its draft");
  assert.strictEqual(state.awaiting, OPERATOR_RESEARCH_AWAITING, "typed corrections reach the brief");
  assert.strictEqual(state.operatorResearch?.origin, "hat");
});

test("Start on a Hat's brief schedules deep research with the brief as framing, and keeps the Hat's stage", async () => {
  const h = hatWork();
  let state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  const { state: started, schedule } = await handleOperatorResearchButton(env, state, "start", h.deps);
  assert.strictEqual(schedule?.mode, "deep_research");
  assert.strictEqual(schedule?.question, PROPOSAL.topic);
  assert.match(schedule?.brief ?? "", /Who is it for\? SMEs considering branding help/);
  assert.strictEqual(schedule?.context, undefined);
  assert.strictEqual(started.stage, "awaiting_research");
  assert.strictEqual(started.awaiting, undefined);
  assert.match(h.sent.at(-1)!.text, /Campaign & Marketing Communications Manager continues the work with them/);
});

test("Edit works on a Hat's brief exactly as on /research, and Start over keeps it the Hat's brief", async () => {
  const h = hatWork();
  let state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  ({ state } = await handleOperatorResearchButton(env, state, "edit", h.deps));
  ({ state } = await handleOperatorResearchButton(env, state, "edit_0", h.deps));
  state = await handleOperatorResearchReply(env, state, "SMEs in Ghana considering branding help", h.deps);
  assert.match(h.sent.at(-1)!.text, /prepared by[\s\S]*SMEs in Ghana considering branding help/);
  ({ state } = await handleOperatorResearchButton(env, state, "restart", h.deps));
  assert.strictEqual(state.operatorResearch?.origin, "hat");
  assert.strictEqual(state.operatorResearch?.lightQuestion, PROPOSAL.lightQuestion);
  assert.strictEqual(state.stage, "awaiting_research");
});

test("Skip deep research continues the Hat without it; Skip never applies to Martin's own research or while researching", async () => {
  const h = hatWork();
  let state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  const skipped = await handleOperatorResearchButton(env, state, "skipresearch", h.deps);
  assert.strictEqual(skipped.continueHat, true);
  assert.strictEqual(skipped.schedule, null);
  assert.strictEqual(skipped.state.operatorResearch?.phase, "done");
  assert.strictEqual(skipped.state.awaiting, undefined);

  const running = hatWork();
  let s2 = await proposeHatResearch(env, running.state, PROPOSAL, running.deps);
  ({ state: s2 } = await handleOperatorResearchButton(env, s2, "start", running.deps));
  const late = await handleOperatorResearchButton(env, s2, "skipresearch", running.deps);
  assert.strictEqual(late.continueHat, undefined, "not while the research runs");

  const mine = harness([]);
  const s3 = await beginOperatorResearch(env, mine.state, "light_search", "SME positioning", mine.deps);
  const own = await handleOperatorResearchButton(env, s3, "skipresearch", mine.deps);
  assert.strictEqual(own.continueHat, undefined, "Martin's own research has no Skip");
});

test("a brief opened on a Work already waiting on Martin gives that wait back when it is done; no Hat: no 'prepared by'", async () => {
  const h = hatWork();
  h.state.awaiting = "proposal_feedback";
  let state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  assert.strictEqual(state.awaiting, OPERATOR_RESEARCH_AWAITING, "typed corrections reach the brief while it is open");
  ({ state } = await handleOperatorResearchButton(env, state, "start", h.deps));
  assert.strictEqual(state.awaiting, "proposal_feedback");

  const skip = hatWork();
  skip.state.awaiting = "proposal_feedback";
  let s2 = await proposeHatResearch(env, skip.state, PROPOSAL, skip.deps);
  ({ state: s2 } = await handleOperatorResearchButton(env, s2, "skipresearch", skip.deps));
  assert.strictEqual(s2.awaiting, "proposal_feedback");

  const plain = harness([]);
  await proposeHatResearch(env, plain.state, PROPOSAL, plain.deps);
  assert.match(plain.sent.at(-1)!.text, /^📋 Deep research brief\nNeeded for:/);
});

test("a Hat's topic that fails the identity check falls back to the light question; if that fails too, nothing is proposed", async () => {
  const h = hatWork();
  const state = await proposeHatResearch(env, h.state, { ...PROPOSAL, topic: "What does ENIG's market want?" }, h.deps);
  assert.strictEqual(state.operatorResearch?.topic, PROPOSAL.lightQuestion);

  const none = hatWork();
  const s2 = await proposeHatResearch(env, none.state, { ...PROPOSAL, topic: "ENIG offers", lightQuestion: "How ENIG compares" }, none.deps);
  assert.strictEqual(s2.operatorResearch?.phase, "done");
  assert.match(none.sent.at(-1)!.text, /could not be made identity-free, so it was not proposed/);
  assert.deepStrictEqual(callbacks(none.sent.at(-1)!), ["oresearch:w-1:skipresearch"]);
});

test("a brief is offered only when the Hat held its draft, can continue, and none was opened on this Work before", () => {
  const held = { stage: "awaiting_research" } as any;
  assert.strictEqual(shouldOfferHatBrief(held, true, true), true);
  assert.strictEqual(shouldOfferHatBrief(held, false, true), false, "a Hat that cannot continue after research");
  assert.strictEqual(shouldOfferHatBrief(held, true, false), false, "no proposal");
  assert.strictEqual(shouldOfferHatBrief({ stage: "awaiting_output_approval" } as any, true, true), false, "the Hat did not hold its draft");
  assert.strictEqual(shouldOfferHatBrief({ stage: "awaiting_research", operatorResearch: { phase: "done" } } as any, true, true), false, "at most one per Work");
});

test("a Hat's deep research completes: findings and the Research page, then the Hat continues automatically", async () => {
  const h = hatWork();
  let state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  ({ state } = await handleOperatorResearchButton(env, state, "start", h.deps));
  const continues = await completeHatResearch(env, state, SYNTHESIS, true, h.deps);
  assert.strictEqual(continues, true);
  assert.strictEqual(state.operatorResearch?.phase, "done");
  assert.strictEqual(h.saved.length, 1, "saved to the Research database");
  const card = h.sent.at(-1)!;
  assert.match(card.text, /Deep research complete: Which free offers/);
  assert.match(card.text, /Saved to the Research database: https:\/\/notion.example\/research-1/);
  assert.match(card.text, /Campaign & Marketing Communications Manager is continuing the work with it now/);

  const moved = hatWork();
  let s2 = await proposeHatResearch(env, moved.state, PROPOSAL, moved.deps);
  ({ state: s2 } = await handleOperatorResearchButton(env, s2, "start", moved.deps));
  s2.stage = "awaiting_output_approval";
  assert.strictEqual(await completeHatResearch(env, s2, SYNTHESIS, true, moved.deps), false, "a Work no longer holding its draft is not continued");
  assert.match(moved.sent.at(-1)!.text, /Redo the draft/);
});

test("a Hat's deep research that fails says so plainly and offers to continue without it", async () => {
  const h = hatWork();
  let state = await proposeHatResearch(env, h.state, PROPOSAL, h.deps);
  ({ state } = await handleOperatorResearchButton(env, state, "start", h.deps));
  state = await failHatResearch(env, state, "no usable sources", true, h.deps);
  assert.match(h.sent.at(-1)!.text, /Deep research could not be completed: no usable sources/);
  assert.deepStrictEqual(callbacks(h.sent.at(-1)!), ["oresearch:w-1:skipresearch"]);
  const { continueHat } = await handleOperatorResearchButton(env, state, "skipresearch", h.deps);
  assert.strictEqual(continueHat, true);
});

// ---------------------------------------------------------------------------
// Access: the operator_research context's fixed reach
// ---------------------------------------------------------------------------

test("operator_research may read standalone pages, read/write the Research database, and read the public web -- nothing else", () => {
  const ctx = operatorResearchContext("w-1");
  assert.doesNotThrow(() => evaluateAccess(env, { operation: "read", dataSourceId: NON_GOVERNED_PAGE_TARGET }, ctx));
  assert.doesNotThrow(() => evaluateAccess(env, { operation: "create", dataSourceId: RESEARCH_DS }, ctx));
  assert.doesNotThrow(() => evaluateAccess(env, { operation: "update", dataSourceId: RESEARCH_DS }, ctx));
  assert.doesNotThrow(() => evaluateAccess(env, { operation: "read", dataSourceId: EXTERNAL_EGRESS_TARGET }, ctx));
  for (const ds of ["entities-ds", "matters-ds", "proposals-ds", "handoffs-ds", "leads-ds", "log-ds", "callnotes-ds", "payments-ds"]) {
    for (const operation of ["read", "create", "update"] as const) {
      assert.throws(() => evaluateAccess(env, { operation, dataSourceId: ds }, ctx), AccessDeniedError, `${operation} ${ds}`);
    }
  }
  assert.throws(() => evaluateAccess(env, { operation: "create", dataSourceId: EXTERNAL_EGRESS_TARGET }, ctx), AccessDeniedError);
  assert.throws(() => evaluateAccess(env, { operation: "create", dataSourceId: NON_GOVERNED_PAGE_TARGET }, ctx), AccessDeniedError);
});

test("operator_research carries no Action or proof, and no other context can reach the Research database", () => {
  assert.throws(() => evaluateAccess(env, { operation: "create", dataSourceId: RESEARCH_DS }, { ...operatorResearchContext("w-1"), actionName: "diagnose" }), AccessDeniedError);
  assert.throws(() => evaluateAccess(env, { operation: "create", dataSourceId: RESEARCH_DS }, systemContext("w-1")), AccessDeniedError);
  assert.throws(() => evaluateAccess(env, { operation: "read", dataSourceId: RESEARCH_DS }, workSessionReadContext("w-1")), AccessDeniedError);
  assert.throws(() => evaluateAccess({ ...env, RESEARCH_DATA_SOURCE_ID: undefined }, { operation: "create", dataSourceId: "" }, operatorResearchContext("w-1")), AccessDeniedError);
});
