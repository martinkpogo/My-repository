import test from "node:test";
import assert from "node:assert";
import { AI_TASK_LIVE_LABELS } from "./liveLabels";
import { SEMANTIC_TASK_REGISTRY } from "../dataBoundary/registry";

test("live labels (Martin, 2026-11-13): every registered AI task says in plain words what it is doing", () => {
  for (const id of Object.keys(SEMANTIC_TASK_REGISTRY)) {
    const label = AI_TASK_LIVE_LABELS[id as keyof typeof AI_TASK_LIVE_LABELS];
    assert.ok(label, `${id} has a plain label`);
    assert.ok(!/^Thinking/.test(label!) && label!.length <= 70, id);
  }
  assert.strictEqual(AI_TASK_LIVE_LABELS["marketing.hat_action_decision"], "Writing the draft, or deciding to pass it on or ask you");
  assert.strictEqual(AI_TASK_LIVE_LABELS["research.synthesis"], "Summarising what the sources say");
  assert.strictEqual(AI_TASK_LIVE_LABELS["runtime.research_need"], "Checking whether to look online");
});
