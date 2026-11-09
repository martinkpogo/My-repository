import test from "node:test";
import assert from "node:assert";
import { formatBusinessSnapshot, loadBusinessSnapshot } from "./businessSnapshot";
import type { Env } from "./types";

/**
 * businessSnapshot.ts: the deterministic, token-safe picture of the business
 * ENIG is handed as Context. These tests pin the two properties it exists
 * for: it reports what the live records say (counts, tokens, statuses), and
 * it never carries a title, stated need, Lead name or Organisation into the
 * prompt -- and one unreadable source is named as unreadable, never guessed.
 */

function createMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, val: string) => {
      store.set(key, val);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-ds",
    STATE_KV: createMockKv() as any,
    ...overrides,
  } as Env;
}

function mockNotionFetch(t: any, resultsByDataSource: Record<string, any[] | "fail">) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const match = /\/data_sources\/([^/]+)\/query/.exec(String(url));
    if (match) {
      const results = resultsByDataSource[match[1]] ?? [];
      if (results === "fail") return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

const page = (properties: Record<string, unknown>) => ({ id: Math.random().toString(36), archived: false, in_trash: false, properties });
const select = (name: string) => ({ select: { name } });
const title = (text: string) => ({ title: [{ plain_text: text }] });
const rich = (text: string) => ({ rich_text: [{ plain_text: text }] });
const uid = (prefix: string, number: number) => ({ unique_id: { prefix, number } });

test("businessSnapshot: reports counts, tokens and statuses from the live records", async (t) => {
  mockNotionFetch(t, {
    "matters-ds": [
      page({ Matter_ID: uid("MAT", 12), Matter: title("Delivery complaints"), Status: select("Qualified") }),
      page({ Matter_ID: uid("MAT", 11), Matter: title("Positioning refresh"), Status: select("Open") }),
      page({ Matter_ID: uid("MAT", 10), Matter: title("Brand audit"), Status: select("Open") }),
    ],
    "proposals-ds": [page({ "Proposal ID": uid("PRP", 3), "Matter Token": rich("MAT-12"), "Approval Status": select("Pending Approval"), Status: select("Draft") })],
    "handoffs-ds": [
      page({ "Handoff ID": uid("HND", 4), Handoff: title("Strategy work"), "From Unit": select("Sales"), "To Unit": select("Strategy"), Status: select("Pending") }),
      page({ "Handoff ID": uid("HND", 3), Handoff: title("Old"), "From Unit": select("Sales"), "To Unit": select("Finance"), Status: select("Closed") }),
    ],
    "leads-ds": [page({ "Lead ID": uid("LEAD", 1), Lead: title("Acme bakery"), Organisation: rich("Acme Bakeries"), Status: select("New") })],
  });
  const env = fakeEnv({
    STATE_KV: createMockKv({
      sessions_index: JSON.stringify([
        { workId: "w1", unit: "Marketing", hat: "Content Manager", stage: "awaiting_approval", label: "pending approval", updatedAt: "2026-11-01", hasPendingApproval: true },
        { workId: "w2", unit: "Finance", hat: "Value-Based Pricing Assessor", stage: "complete", label: "MAT-9", updatedAt: "2026-11-01" },
      ]),
    }) as any,
  });

  const text = formatBusinessSnapshot(await loadBusinessSnapshot(env));

  assert.match(text, /Marketing\/Content Manager — pending approval \(Awaiting approval\)/);
  assert.doesNotMatch(text, /w2|MAT-9/, "Work with no pending approval is not listed as waiting on Martin");
  assert.match(text, /Matters: Qualified: 1, Open: 2 \(3 total\)/);
  assert.match(text, /latest: MAT-12 \[Qualified\], MAT-11 \[Open\], MAT-10 \[Open\]/);
  assert.match(text, /PRP-3 for MAT-12 \[Pending Approval · Draft\]/);
  assert.match(text, /HND-4 Sales → Strategy \[Pending\]/);
  assert.doesNotMatch(text, /HND-3/, "closed Handoffs are not listed as open");
  assert.match(text, /Leads: New: 1 \(1 total\)/);
});

test("businessSnapshot: never carries titles, stated needs, Lead names or Organisations", async (t) => {
  mockNotionFetch(t, {
    "matters-ds": [page({ Matter_ID: uid("MAT", 12), Matter: title("Delivery complaints"), Stated_need: rich("Fix the courier problem"), Status: select("Open") })],
    "handoffs-ds": [page({ "Handoff ID": uid("HND", 4), Handoff: title("Secret handoff title"), "From Unit": select("Sales"), "To Unit": select("Strategy"), Status: select("Pending") })],
    "leads-ds": [page({ "Lead ID": uid("LEAD", 1), Lead: title("Acme bakery"), Organisation: rich("Acme Bakeries"), Status: select("New") })],
  });
  const text = formatBusinessSnapshot(await loadBusinessSnapshot(fakeEnv()));
  for (const leaked of ["Delivery complaints", "courier", "Secret handoff title", "Acme", "LEAD-1"]) {
    assert.ok(!text.includes(leaked), `snapshot must not contain "${leaked}"`);
  }
});

test("businessSnapshot: an unreadable source is named as unreadable and the rest still reports", async (t) => {
  mockNotionFetch(t, {
    "matters-ds": "fail",
    "leads-ds": [page({ Status: select("New") })],
  });
  const text = formatBusinessSnapshot(await loadBusinessSnapshot(fakeEnv()));
  assert.match(text, /Matters: \(couldn't read this right now -- say so if asked; do not guess\)/);
  assert.match(text, /Leads: New: 1/);
  assert.match(text, /Proposals: none recorded/);
  assert.match(text, /Handoffs not yet closed:\n {2}none/);
});

test("businessSnapshot: a full sample says it is only the most recent records", () => {
  const latest: string[] = [];
  const text = formatBusinessSnapshot({
    pendingApprovals: { ok: true, value: [] },
    matters: { ok: true, value: { sampled: 50, byStatus: [["Open", 50]], latest } },
    proposals: { ok: true, value: { sampled: 0, byStatus: [], latest } },
    openHandoffs: { ok: true, value: [] },
    leads: { ok: false },
  });
  assert.match(text, /Matters: Open: 50 \(of the 50 most recent matters\)/);
  assert.match(text, /Waiting on Martin's approval:\n {2}nothing/);
});
