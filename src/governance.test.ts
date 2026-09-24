import test from "node:test";
import assert from "node:assert";
import { stripObjectNameField, getGovernance, GOVERNANCE_CONTENT_START, GOVERNANCE_CONTENT_END } from "./governance";

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
  };
}

/** Mocks a single Notion code block containing `blockText` as the page's only content. */
function mockGovernancePageFetch(t: any, blockText: string): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        results: [{ type: "code", code: { rich_text: [{ plain_text: blockText }], language: "yaml" } }],
        has_more: false,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

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

test("getGovernance: wraps returned content in GOVERNANCE_CONTENT_START/END so outboundGate.ts can exempt it", async (t) => {
  mockGovernancePageFetch(t, "hat:\n  name: Sales Executive\n  unit: Sales");
  const env = { STATE_KV: fakeKv() } as any;

  const result = await getGovernance(env, "test-page-id", "Test Hat Definition");

  assert.ok(result);
  assert.ok(result!.startsWith(GOVERNANCE_CONTENT_START), "content must be wrapped, not returned bare");
  assert.ok(result!.trim().endsWith(GOVERNANCE_CONTENT_END));
  assert.ok(result!.includes("unit: Sales"), "the surrounding content itself must survive intact");
  // Defense in depth: stripObjectNameField still runs too, even though
  // the wrapper alone would already exempt this from the gate.
  assert.ok(!result!.includes("name: Sales Executive"));
});

test("getGovernance: the same wrapping applies on a cache-hit read, not only a fresh fetch", async () => {
  const kv = fakeKv();
  await kv.put("governance:test-page-id", "business_object:\n  name: Entity\n  status: canonical");
  const env = { STATE_KV: kv } as any;

  const result = await getGovernance(env, "test-page-id", "Test Business Object");

  assert.ok(result!.startsWith(GOVERNANCE_CONTENT_START));
  assert.ok(result!.trim().endsWith(GOVERNANCE_CONTENT_END));
  assert.ok(!result!.includes("name: Entity"));
});
