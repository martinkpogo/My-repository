/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoff, updateHandoff, validateHandoffProperties, HandoffWriteViolationError, SOURCE_BOUNDARY_CHECKS, buildSourceBoundaryMarker, parseSourceBoundaryMarker } from "./handoffWriter";
import { richText, select, title } from "./notion";
import type { Env } from "./types";
import { mintApprovalProof, type AccessContext } from "./access";

function fakeEnv(): Env {
  return {
    AI: {} as any,
    WORK_SESSION: {} as any,
    STATE_KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true, cursor: undefined }) as any } as any,
    NOTION_VERSION: "2025-09-03",
    AI_MODEL_PRIMARY: "test-model",
    AI_MODEL_LIGHT: "test-model-light",
    ENTITY_DATA_SOURCE_ID: "entity-ds",
    MATTERS_DATA_SOURCE_ID: "matters-ds",
    PROPOSALS_DATA_SOURCE_ID: "proposals-ds",
    HANDOFFS_DATA_SOURCE_ID: "handoffs-ds",
    ACTIVITY_LOG_DATA_SOURCE_ID: "activity-log-ds",
    LEADS_DATA_SOURCE_ID: "leads-ds",
    TELEGRAM_BOT_TOKEN: "test-token",
    MARTIN_TELEGRAM_USER_ID: "9999",
    NOTION_TOKEN: "test-notion-token",
  };
}

/**
 * Mocks global fetch to capture the outgoing Notion request body and return a
 * minimal successful page response.
 *
 * A GET of an existing page carries its `parent`, because that is now how
 * src/notion.ts resolves a page's real target: an update is authorized against
 * the data source the page actually lives in, read back from Notion, rather
 * than against anything the caller claims. A page with no parent resolves to
 * no governed source at all, which is exactly what these updates must refuse
 * to do -- so the mock has to be shaped like the real API, not flatter than it.
 */
function mockNotionFetch(t: any) {
  const calls: { method: string; path: string; body: any }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path: String(url), body: init.body ? JSON.parse(init.body as string) : undefined });
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          id: "page-1",
          url: "https://notion.so/page-1",
          parent: { type: "data_source_id", data_source_id: "handoffs-ds" },
          properties: {},
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1", properties: {} }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

const baseIdentity = { entityToken: "E-20", matterToken: "MAT-20" };

/**
 * The Access context a Handoff CREATE is made under: Strategy Analyst's own
 * `diagnose` Action, whose only approval-gated governed effect is precisely the
 * outbound Handoff it creates -- so the create carries the proof Martin's
 * approval of that button produced.
 *
 * These cases are about the identity-write boundary, not about gating, so the
 * gating is satisfied properly here rather than worked around: minting a real
 * proof means every create below is authorized exactly as production is.
 */
function createAccess(env: Env): AccessContext {
  return {
    kind: "work_session",
    workId: "work-1",
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    proof: mintApprovalProof({
      workId: "work-1",
      actionName: "diagnose",
      targetDataSourceId: env.HANDOFFS_DATA_SOURCE_ID,
      // Fixed so a failure is reproducible rather than dependent on a fresh uuid.
      token: "test-approval-token-0001",
    }),
  };
}

/**
 * The Access context a Handoff LIFECYCLE UPDATE is made under.
 *
 * Names the Handoff as the one this Work item was picked up from, which is
 * what distinguishes a Work advancing its own Handoff from a Unit committing a
 * governed effect (see isWorkItemHandoffProgression). The writes below are
 * Status/Work Completed bookkeeping on that inbound Handoff, so they are not
 * approval-gated -- not because they opted out of gating, but because they
 * were never the gated operation.
 */
function lifecycleAccess(handoffId: string): AccessContext {
  return {
    kind: "work_session",
    workId: "work-1",
    unit: "Strategy",
    hat: "Strategy Analyst",
    actionName: "diagnose",
    inboundHandoffId: handoffId,
  };
}

function validProperties(overrides: Record<string, unknown> = {}) {
  return {
    Handoff: title("Value-based quote request — MAT-20"),
    "From Unit": select("Strategy"),
    "To Unit": select("Finance"),
    Status: select("Pending"),
    Reason: richText("Approved intervention ready for pricing."),
    Entity_Token: richText("E-20"),
    Matter_Token: richText("MAT-20"),
    "Verified Facts & Sources": richText("Sanitized business context only."),
    ...overrides,
  };
}

// --- Valid cases ---------------------------------------------------------

test("createHandoff: a token-only Handoff succeeds", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const { page, sourceBoundaryAttestation } = await createHandoff(env, validProperties(), baseIdentity, createAccess(env));
  assert.strictEqual(page.id, "page-1");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.properties.Matter_Token.rich_text[0].text.content, "MAT-20");
  assert.strictEqual(sourceBoundaryAttestation.handoffId, "page-1");
  assert.strictEqual(sourceBoundaryAttestation.checked, true);
  assert.deepStrictEqual(sourceBoundaryAttestation.identityFieldsChecked, []);
});

test("createHandoff: the returned source-boundary attestation records exactly which known-identity fields were present -- never the values themselves", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  const { sourceBoundaryAttestation } = await createHandoff(env, validProperties(), {
    ...baseIdentity,
    entityName: "Some Real Entity Name That Never Appears In Fields",
    email: "someone@example.com",
  }, createAccess(env));
  assert.deepStrictEqual([...sourceBoundaryAttestation.identityFieldsChecked].sort(), ["email", "entityName"]);
});

test("createHandoff: normal sanitized business context succeeds", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(() =>
    createHandoff(
      env,
      validProperties({
        "Verified Facts & Sources": richText(
          "Value at stake: GHS 420,000 over 12 months, evidence type: client_estimated, source: client-stated on call 2026-09-20.",
        ),
      }),
      baseIdentity,
      createAccess(env),
    ),
  );
});

test("updateHandoff: an existing lifecycle update with safe Work Completed succeeds", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(() =>
    updateHandoff(
      env,
      "handoff-1",
      {
        Status: select("Closed"),
        "Work Completed": richText("Quoted price: GHS 420000. Rationale: value-based pricing applied to the approved intervention."),
      },
      lifecycleAccess("handoff-1"),
    ),
  );
});

// --- Invalid cases ---------------------------------------------------------

test("createHandoff: real Entity/company name in Handoff title fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Handoff: title("Commercial diagnosis — Meridian Foods Ghana Ltd") }), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }, createAccess(env)),
    HandoffWriteViolationError,
  );
});

test("createHandoff: real Matter name in Handoff title fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Handoff: title("Draft Proposal — Cold Chain Logistics Redesign") }), { ...baseIdentity, matterName: "Cold Chain Logistics Redesign" }, createAccess(env)),
    HandoffWriteViolationError,
  );
});

test("createHandoff: Entity/company name in Reason fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Reason: richText("Commercial fit approved for Meridian Foods Ghana Ltd.") }), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }, createAccess(env)),
    HandoffWriteViolationError,
  );
});

test("createHandoff: Matter name in Verified Facts & Sources fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      createHandoff(env, validProperties({ "Verified Facts & Sources": richText("Situation concerns the Cold Chain Logistics Redesign matter specifically.") }), {
        ...baseIdentity,
        matterName: "Cold Chain Logistics Redesign",
      },
      createAccess(env),
    ),
    HandoffWriteViolationError,
  );
});

test("createHandoff: known contact name in a protected field fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      createHandoff(env, validProperties({ "Required Next Action": richText("Follow up with Comfort Agyare about the timeline.") }), {
        ...baseIdentity,
        contactName: "Comfort Agyare",
      },
      createAccess(env),
    ),
    HandoffWriteViolationError,
  );
});

test("createHandoff: email address in a protected field fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ "Open Questions": richText("Confirm with comfort@meridianfoods.com before proceeding.") }), baseIdentity, createAccess(env)),
    HandoffWriteViolationError,
  );
});

test("createHandoff: phone number in a protected field fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties({ Assumptions: richText("Contact reachable at +233 24 412 3456 if needed.") }), baseIdentity, createAccess(env)),
    HandoffWriteViolationError,
  );
});

test("createHandoff: missing Entity_Token fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties(), { entityToken: "", matterToken: "MAT-20" }, createAccess(env)), HandoffWriteViolationError);
});

test("createHandoff: missing Matter_Token fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties(), { entityToken: "E-20", matterToken: "" }, createAccess(env)), HandoffWriteViolationError);
});

test("createHandoff: empty (whitespace-only) token fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties(), { entityToken: "   ", matterToken: "MAT-20" }, createAccess(env)), HandoffWriteViolationError);
});

test("updateHandoff: prohibited identity in Work Completed fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      updateHandoff(
        env,
        "handoff-1",
        { Status: select("Closed"), "Work Completed": richText("Delivered to Meridian Foods Ghana Ltd as agreed.") },
        lifecycleAccess("handoff-1"),
        { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" },
      ),
    HandoffWriteViolationError,
  );
});

test("updateHandoff: prohibited identity in Assumptions fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      updateHandoff(env, "handoff-1", { Assumptions: richText("Assumes Meridian Foods Ghana Ltd confirms budget by month end.") }, lifecycleAccess("handoff-1"), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }),
    HandoffWriteViolationError,
  );
});

test("updateHandoff: prohibited identity in Open Questions fails", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      updateHandoff(env, "handoff-1", { "Open Questions": richText("Does Meridian Foods Ghana Ltd want a phased rollout?") }, lifecycleAccess("handoff-1"), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }),
    HandoffWriteViolationError,
  );
});

test("createHandoff: does not call Notion at all when validation fails (validate before write, not create-then-repair)", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(() => createHandoff(env, validProperties({ Reason: richText("For Meridian Foods Ghana Ltd.") }), { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }, createAccess(env)));
  assert.strictEqual(calls.length, 0, "no Notion API call may happen once validation has failed");
});

test("validateHandoffProperties: a short/generic needle (e.g. a 2-letter name) does not cause false-positive rejections", () => {
  assert.doesNotThrow(() =>
    validateHandoffProperties(validProperties(), { ...baseIdentity, entityName: "A1", matterName: "B2" }),
  );
});

test("updateHandoff: a plain Status-only lifecycle update with no identity supplied succeeds", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  await assert.doesNotReject(() => updateHandoff(env, "handoff-1", { Status: select("Picked-up") }, lifecycleAccess("handoff-1")));
});

// --- Sales -> Strategy source-boundary attestation (durable marker) -------

function salesToStrategyProperties(overrides: Record<string, unknown> = {}) {
  return validProperties({
    Handoff: title("Commercial diagnosis — MAT-20"),
    "From Unit": select("Sales"),
    "To Unit": select("Strategy"),
    ...overrides,
  });
}

function propertyText(prop: any): string {
  const parts = prop?.rich_text ?? [];
  return parts.map((p: any) => p.plain_text ?? p.text?.content ?? "").join("");
}

test("createHandoff (Sales -> Strategy): the creation payload carries the durable Passed attestation marker -- result, Handoff binding, all five checks, no real-world identity", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const properties = salesToStrategyProperties({
    Reason: richText("Commercial fit/progression approved for MAT-20. Entry type: inbound_enquiry."),
  });
  const identity = { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd", email: "comfort@meridianfoods.com" };

  const { sourceBoundaryAttestation } = await createHandoff(env, properties, identity, createAccess(env));

  // The marker is part of the Handoff creation event itself -- one atomic create.
  const create = calls.find((c) => c.method === "POST" && c.body?.properties?.Reason);
  assert.ok(create, "the Handoff must be created");
  const reason = propertyText(create.body.properties.Reason);
  const markerMatch = /\[source_boundary_check [^\]]*\]/.exec(reason);
  assert.ok(markerMatch, `the durable attestation marker must be in the Handoff's Reason: ${reason}`);
  const marker = markerMatch[0];

  // Explicit result, bound to this Handoff's operational references.
  assert.match(marker, /result=Passed/);
  assert.ok(marker.includes("entity=E-20"), "marker must bind to the operational Entity reference");
  assert.ok(marker.includes("matter=MAT-20"), "marker must bind to the operational Matter reference");

  // All five named checks, verbatim contract vocabulary.
  for (const check of SOURCE_BOUNDARY_CHECKS) {
    assert.ok(marker.includes(check), `marker must evidence ${check}`);
  }

  // The marker itself contains no identity-bearing content.
  for (const forbidden of ["Meridian Foods Ghana Ltd", "comfort@meridianfoods.com"]) {
    assert.ok(!marker.includes(forbidden), `marker must not contain identity-bearing content: ${forbidden}`);
  }
  assert.ok(!marker.includes("@"), "the marker never carries contact details");

  // Returned attestation: explicit result, the five checks, and this Handoff's id.
  assert.strictEqual(sourceBoundaryAttestation.result, "Passed");
  assert.deepStrictEqual([...sourceBoundaryAttestation.checks].sort(), [...SOURCE_BOUNDARY_CHECKS].sort());
  assert.strictEqual(sourceBoundaryAttestation.handoffId, "page-1");

  // The pre-existing Reason text is preserved (the marker is appended, never substituted).
  assert.match(reason, /^Commercial fit\/progression approved for MAT-20\. Entry type: inbound_enquiry\./);
});

test("createHandoff (Sales -> Strategy): identity-bearing content still refuses the write -- no Handoff is created, so no Pending Sales -> Strategy Handoff can exist", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const properties = salesToStrategyProperties({
    Reason: richText("Commercial fit approved for Meridian Foods Ghana Ltd."),
  });
  await assert.rejects(
    () => createHandoff(env, properties, { ...baseIdentity, entityName: "Meridian Foods Ghana Ltd" }, createAccess(env)),
    HandoffWriteViolationError,
  );
  assert.strictEqual(calls.length, 0, "a failed source-boundary check must never produce a Handoff write");
});

test("parseSourceBoundaryMarker: round-trips the sender's marker -- explicit Passed result bound to the Handoff, all five checks", () => {
  const identity = { entityToken: "E-20", matterToken: "MAT-20" };
  const marker = buildSourceBoundaryMarker(identity, "Passed", ["entityName", "matterName", "email"]);

  const parsed = parseSourceBoundaryMarker(`Reason text before it. ${marker}`, { handoffId: "page-1", entityToken: "E-20", matterToken: "MAT-20" });

  if (!parsed.ok) assert.fail(`expected to consume the marker, got: ${parsed.reason}`);
  assert.strictEqual(parsed.attestation.handoffId, "page-1");
  assert.strictEqual(parsed.attestation.checked, true);
  assert.strictEqual(parsed.attestation.result, "Passed");
  assert.deepStrictEqual([...parsed.attestation.checks].sort(), [...SOURCE_BOUNDARY_CHECKS].sort());
  assert.deepStrictEqual([...parsed.attestation.identityFieldsChecked].sort(), ["email", "entityName", "matterName"]);
});

test("parseSourceBoundaryMarker: missing, Failed, incomplete, malformed, and unbound evidence all fail closed -- absence of identity data is never inferred as Passed", () => {
  const identity = { entityToken: "E-20", matterToken: "MAT-20" };
  const expected = { handoffId: "page-1", entityToken: "E-20", matterToken: "MAT-20" };
  const passedMarker = buildSourceBoundaryMarker(identity, "Passed", ["entityName", "matterName"]);

  // Missing entirely.
  assert.strictEqual(parseSourceBoundaryMarker("Commercial fit/progression approved for MAT-20.", expected).ok, false);
  // Sanitized identity-free text with no marker at all is still not evidence.
  assert.strictEqual(parseSourceBoundaryMarker("Sanitized context containing no identity whatsoever.", expected).ok, false);
  // Explicitly Failed.
  assert.strictEqual(parseSourceBoundaryMarker(buildSourceBoundaryMarker(identity, "Failed", ["entityName", "matterName"]), expected).ok, false);
  // Missing one of the five required checks.
  assert.strictEqual(
    parseSourceBoundaryMarker(
      "[source_boundary_check result=Passed entity=E-20 matter=MAT-20 checks=operational_entity_reference_present,operational_matter_reference_present]",
      expected,
    ).ok,
    false,
  );
  // No explicit result at all (malformed).
  assert.strictEqual(
    parseSourceBoundaryMarker(
      "[source_boundary_check checks=operational_entity_reference_present,operational_matter_reference_present,identity_bearing_content_removed,identity_resolution_registry_data_not_transferred,handoff_context_identity_safe]",
      expected,
    ).ok,
    false,
  );
  // Bound to a different Handoff's operational references.
  assert.strictEqual(parseSourceBoundaryMarker(passedMarker, { ...expected, matterToken: "MAT-99" }).ok, false);
});
