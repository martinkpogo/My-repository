import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ADVISORY_ASSESSMENT_TIMEOUT_MS,
  ADVISORY_RESPONSE_FORMAT,
  assessmentDelivery,
  buildAdvisoryPromptParts,
  formatAdvisoryMessage,
  parseAdvisoryAssessment,
  runAdvisoryAssessment,
  summarizeAssessment,
} from "./advisoryAssessment";
import type { ResultReviewAssessment, WorkState } from "../types";

/**
 * The independent Checker's ADVISORY second opinion (Martin's decision,
 * 2026-11-14): sent after the draft, separately, with a recommended next
 * action; never blocks, delays or invalidates Approve, Redo or closure.
 */

const AUTHORITY_PAGE = "result_verification_authority:\n  machinery_worker_id: MW-checker\n  granted_by: martin\n  granted_capabilities: [verify_work_result]\n";
const GOOD = {
  assessment: "The problem is specific and tied to ENIG's positioning work; two of three sources are about SMEs generally.",
  concerns: ["Two sources are not about Ghana."],
  relevant_to_enig: "yes",
  relevant_to_client_situation: "not_applicable",
  recommended_next_action: "approve",
  next_action_note: "Look for a Ghana source when strategy starts.",
};
const INPUT = { output: "The problem -- inconsistent messaging.", request: "Find a problem businesses have.", criteria: ["Within the Hat's ownership.", "Claims trace to sources."], unit: "Marketing", hat: "Marketing Strategist" };

test("rubric: the prompt carries the content criteria, ENIG-relevance, client-situation relevance, a recommended next action, the exact reply shape -- and says it is advisory", () => {
  const parts = buildAdvisoryPromptParts(INPUT, "MW-checker");
  assert.match(parts.persona, /SECOND OPINION[\s\S]*advisory only: he decides, and nothing waits on you/);
  assert.match(parts.skillContent, /RELEVANT TO WHAT ENIG DOES/);
  assert.match(parts.skillContent, /RELEVANT TO THE CLIENT'S SITUATION[\s\S]*not_applicable[\s\S]*Never invent a situation/);
  assert.match(parts.skillContent, /approve[\s\S]*redo[\s\S]*ask/);
  assert.match(parts.skillContent, /cannot know whether a claim is true in the world/);
  assert.ok(parts.context.includes("1. Within the Hat's ownership.") && parts.context.includes("2. Claims trace to sources."));
  assert.ok(parts.context.includes("REQUEST: Find a problem businesses have."));
  assert.ok(parts.context.includes(ADVISORY_RESPONSE_FORMAT));
  assert.ok(parts.situation.includes(INPUT.output));
});

test("parse: only the exact shape is an assessment; anything else is none", () => {
  const ok = parseAdvisoryAssessment(GOOD);
  assert.equal(ok?.recommended, "approve");
  assert.deepEqual(ok?.concerns, ["Two sources are not about Ghana."]);
  for (const bad of [null, "text", {}, { ...GOOD, relevant_to_enig: "maybe" }, { ...GOOD, recommended_next_action: "block" }, { ...GOOD, assessment: "  " }, { ...GOOD, relevant_to_client_situation: undefined }]) {
    assert.equal(parseAdvisoryAssessment(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseAdvisoryAssessment({ ...GOOD, concerns: undefined })?.concerns.length, 0, "concerns are optional");
});

test("message: separate, plain, advisory, with the recommended next action; 'after' says nothing changes", () => {
  const a = { ...(parseAdvisoryAssessment(GOOD) as object), checkerId: "MW", outputHash: "h", assessedAt: "t" } as ResultReviewAssessment;
  const before = formatAdvisoryMessage(a, "before");
  assert.match(before, /^🔎 Checker's second opinion \(advisory -- you decide\)/);
  assert.match(before, /Relevant to what ENIG does: yes/);
  assert.match(before, /Relevant to the client's situation: not applicable/);
  assert.match(before, /Concerns:\n- Two sources are not about Ghana\./);
  assert.match(before, /Recommended next action: Approve -- Look for a Ghana source/);
  assert.ok(!/already approved/.test(before));
  assert.match(formatAdvisoryMessage(a, "after"), /arrived after you had already approved; nothing changes/);
  assert.match(summarizeAssessment(a), /recommends approve; relevant to ENIG: yes/);
  assert.equal(summarizeAssessment(undefined), "");
});

test("run: authority read live, reply validated, bound to the exact draft by SHA-256", async () => {
  const { hashContent } = await import("../contentHash");
  const seen: string[] = [];
  const result = await runAdvisoryAssessment(INPUT, { fetchAuthorityPage: async () => AUTHORITY_PAGE, ask: async (_i, checker) => (seen.push(checker), GOOD) });
  assert.deepEqual(seen, ["MW-checker"]);
  assert.equal(result?.checkerId, "MW-checker");
  assert.equal(result?.outputHash, await hashContent(INPUT.output));
});

test("run: no assessment -- silently -- when the Checker's authority is missing, the call fails, times out, or the reply is not the shape", async (t) => {
  t.mock.method(console, "error", () => {});
  const ok = { fetchAuthorityPage: async () => AUTHORITY_PAGE, ask: async () => GOOD };
  assert.equal(await runAdvisoryAssessment(INPUT, { ...ok, fetchAuthorityPage: async () => "nothing here" }), null, "no authority block");
  assert.equal(await runAdvisoryAssessment(INPUT, { ...ok, fetchAuthorityPage: async () => { throw new Error("notion down"); } }), null, "unreadable authority");
  assert.equal(await runAdvisoryAssessment(INPUT, { ...ok, ask: async () => { throw new Error("all providers failed"); } }), null, "call fails");
  assert.equal(await runAdvisoryAssessment(INPUT, { ...ok, ask: async () => ({ nonsense: true }) }), null, "bad shape");
  assert.equal(await runAdvisoryAssessment(INPUT, { ...ok, ask: () => new Promise(() => {}) }, 20), null, "never answers: abandoned at the timeout");
  assert.equal(ADVISORY_ASSESSMENT_TIMEOUT_MS, 25_000);
});

const AWAITING = "awaiting_marketing_draft_approval";
const draftOf = (s: WorkState) => s.marketing?.draft;
const work = (o: Partial<WorkState>): WorkState => ({ workId: "w", stage: AWAITING, marketing: { draft: "D1" }, ...o }) as WorkState;

test("delivery: before (still awaiting this draft), after (he approved meanwhile), skip (redone, replaced, cancelled) -- never interfering with a decision he made", () => {
  assert.equal(assessmentDelivery(work({}), "D1", draftOf, AWAITING), "before");
  assert.equal(assessmentDelivery(work({ stage: "complete", marketing: {}, resultReview: { approval: { approver: "martin" } } as any }), "D1", draftOf, AWAITING), "after");
  assert.equal(assessmentDelivery(work({ marketing: { draft: "D2" } }), "D1", draftOf, AWAITING), "skip", "a new draft replaced it");
  assert.equal(assessmentDelivery(work({ stage: "awaiting_marketing_feedback" }), "D1", draftOf, AWAITING), "skip", "he tapped Redo");
  assert.equal(assessmentDelivery(work({ stage: "cancelled" }), "D1", draftOf, AWAITING), "skip");
  assert.equal(assessmentDelivery(work({ stage: "complete", marketing: {} }), "D1", draftOf, AWAITING), "skip", "closed without his approval recorded: nothing to say");
});

test("wiring: Marketing declares content criteria only; the Work assesses after the saved cycle, holding no state, and never blocks", async () => {
  const { marketingManifest } = await import("../units/marketing/marketingManifest");
  const action = marketingManifest.hats["Marketing Strategist"].actions.find((a) => a.name === "handle_request")!;
  const decl = action.advisoryAssessment!;
  assert.ok(decl, "Marketing handle_request declares the advisory assessment");
  assert.equal(decl.awaitingStage, "awaiting_marketing_draft_approval");
  assert.equal(decl.criteria.length, 2);
  assert.ok(!decl.criteria.some((c) => /approval/i.test(c)), "the approval criterion is never assessed: his approval does not exist yet");
  assert.equal(decl.output({ marketing: { draft: "X" } } as any), "X");
  assert.equal(decl.request!({ marketing: { taskText: "Y" } } as any), "Y");

  const src = fs.readFileSync(new URL("../session.ts", import.meta.url), "utf8");
  const exec = src.slice(src.indexOf("private async execute"), src.indexOf("private async maybeSendAdvisoryAssessment"));
  assert.match(exec, /const saved = await withLiveStatus\([\s\S]*await this\.maybeSendAdvisoryAssessment\(saved\);\s*return saved;/, "assessed AFTER the saved cycle");
  const fn = src.slice(src.indexOf("private async maybeSendAdvisoryAssessment"), src.indexOf("private async reportResultReviewBlocked"));
  assert.match(fn, /catch \(err\)[\s\S]*nothing is blocked/, "never throws");
  assert.match(fn, /const fresh = migrateSavedWork\(await this\.ctx\.storage\.get<WorkState>\("state"\)\);[\s\S]{0,400}await this\.ctx\.storage\.put\("state", fresh\);/, "re-read and write share no await");
  const between = fn.slice(fn.indexOf("const fresh = migrateSavedWork"), fn.indexOf("await this.ctx.storage.put"));
  assert.equal((between.match(/await /g) ?? []).length, 1, "the only await between the re-read and the write is the read itself");
});
