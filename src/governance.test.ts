import test from "node:test";
import assert from "node:assert";
import { stripObjectNameField } from "./governance";

test("stripObjectNameField: removes a multi-word Hat name field (the exact false positive found live on sales.call_qualification_handoff)", () => {
  const content = "hat:\n  name: Sales Executive\n  unit: Sales\n  specialization: Sales Progression";
  const result = stripObjectNameField(content);
  assert.ok(!result.includes("name:"), "the name: line must be fully removed");
  assert.ok(result.includes("hat:"));
  assert.ok(result.includes("unit: Sales"));
});

test("stripObjectNameField: removes a single-word Business Object name field (Entity)", () => {
  const content = "business_object:\n  name: Entity\n  status: canonical";
  const result = stripObjectNameField(content);
  assert.ok(!result.includes("name: Entity"));
  assert.ok(result.includes("status: canonical"));
});

test("stripObjectNameField: does not strip a differently-named key that merely contains 'name' as a substring", () => {
  const content = "  Entity_name: should survive\n  contact_name: should also survive";
  const result = stripObjectNameField(content);
  assert.ok(result.includes("Entity_name: should survive"));
  assert.ok(result.includes("contact_name: should also survive"));
});

test("stripObjectNameField: does not strip 'name' appearing mid-sentence in prose, only a line starting with the name: field", () => {
  const content = "The Hat Definition's own name and specialization are described below.\nname: Value-Based Pricing Assessor";
  const result = stripObjectNameField(content);
  assert.ok(result.includes("The Hat Definition's own name and specialization are described below."));
  assert.ok(!result.includes("name: Value-Based Pricing Assessor"));
});

test("stripObjectNameField: collapses the resulting blank-line run instead of leaving a gap", () => {
  const content = "line one\n\nname: Sales Executive\n\nline two";
  const result = stripObjectNameField(content);
  assert.ok(!/\n{3,}/.test(result), "no run of 3+ newlines should remain");
  assert.ok(result.includes("line one"));
  assert.ok(result.includes("line two"));
});

test("stripObjectNameField: is a no-op on content with no name: field", () => {
  const content = "status: canonical\nscope: applies to every Hat";
  assert.strictEqual(stripObjectNameField(content), content);
});
