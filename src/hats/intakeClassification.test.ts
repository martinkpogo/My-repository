import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStage1SystemPrompt, buildActionClassificationSystemPrompt } from "./intakeClassification";
import type { ActionDefinition } from "./actionRegistry";

test("buildStage1SystemPrompt: embeds the caller's intro line and Hat summary list verbatim", () => {
  const prompt = buildStage1SystemPrompt(
    "You route incoming Marketing-specialization tasks for ENIG, within the Sales, Marketing & Business Development Unit.",
    "- Marketing Strategist: purpose one\n- Digital Marketer: purpose two",
  );
  assert.ok(prompt.startsWith("You route incoming Marketing-specialization tasks for ENIG"));
  assert.ok(prompt.includes("- Marketing Strategist: purpose one"));
  assert.ok(prompt.includes("- Digital Marketer: purpose two"));
});

test("buildStage1SystemPrompt: response format instructs the same candidates/establishing/reason JSON shape every existing caller relies on", () => {
  const prompt = buildStage1SystemPrompt("intro", "summary");
  assert.ok(prompt.includes('"candidates": ["<exact Hat name 1>", ...]'));
  assert.ok(prompt.includes('"establishing": true | false'));
  assert.ok(prompt.includes('"reason": "<brief rationale>"'));
});

test("buildStage1SystemPrompt: is Unit-agnostic -- no Marketing-specific wording baked into the generic template itself", () => {
  const prompt = buildStage1SystemPrompt("A different Unit's intro line entirely.", "- Diagnostician: diagnoses things");
  assert.ok(!prompt.toLowerCase().includes("marketing"), "the generic template must not hardcode Marketing wording -- only the caller-supplied introLine may mention it");
  assert.ok(prompt.startsWith("A different Unit's intro line entirely."));
});

type ToyAction = "lookup_status" | "update_record";

const TOY_ACTIONS: ActionDefinition<ToyAction>[] = [
  { name: "lookup_status", consequence: "read", description: "Read-only status lookup." },
  { name: "update_record", consequence: "write", description: "Mutates governed state." },
];

test("buildActionClassificationSystemPrompt: embeds the caller's intro line and every action's name/description verbatim", () => {
  const prompt = buildActionClassificationSystemPrompt("You decide which action this request needs, within a Toy Hat.", TOY_ACTIONS);
  assert.ok(prompt.startsWith("You decide which action this request needs, within a Toy Hat."));
  assert.ok(prompt.includes("- lookup_status: Read-only status lookup."));
  assert.ok(prompt.includes("- update_record: Mutates governed state."));
});

test("buildActionClassificationSystemPrompt: response format instructs the exact-name-or-null JSON shape classifyAction relies on", () => {
  const prompt = buildActionClassificationSystemPrompt("intro", TOY_ACTIONS);
  assert.ok(prompt.includes('"action": "<exact action name>" | null'));
  assert.ok(prompt.includes('"reason": "<brief rationale>"'));
});

test("buildActionClassificationSystemPrompt: is Unit-agnostic -- only the caller-supplied introLine/actions determine content", () => {
  const prompt = buildActionClassificationSystemPrompt("A Business Development Hat's intro line.", TOY_ACTIONS);
  assert.ok(!prompt.toLowerCase().includes("marketing"));
  assert.ok(prompt.startsWith("A Business Development Hat's intro line."));
});
