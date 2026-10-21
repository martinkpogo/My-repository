/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoff, updateHandoff, validateHandoffProperties, HandoffWriteViolationError, SOURCE_BOUNDARY_CHECKS, buildSourceBoundaryMarker, parseSourceBoundaryMarker } from "./handoffWriter";
import { richText, select, title } from "./notion";
import { extractHandoffSources, resolveHandoffSources, HANDOFF_SOURCE_ROUTE_CONTRACTS } from "./handoffSources";
import type { HandoffSourceRouteContract } from "./handoffSources";
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
    CALL_NOTES_DATA_SOURCE_ID: "call-notes-ds",
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
    // No Entity_Token/Matter_Token: those Handoff properties no longer
    // exist, and no fixture writes what production reads nowhere. Identity
    // travels where the route contract now puts it -- as the opaque token
    // entries inside Sources. Every commercial route requires them, so a
    // payload with no Sources at all is refused by the write gate; a test
    // exercising that shape deletes the property explicitly.
    Sources: sourcesProperty([]),
    "Verified Facts & Sources": richText("Sanitized business context only."),
    ...overrides,
  };
}

// --- Valid cases ---------------------------------------------------------

test("createHandoff: a token-only Handoff succeeds -- the pair travels in Sources, never as a Handoff property", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const { page, sourceBoundaryAttestation } = await createHandoff(
    env,
    validProperties({ Sources: sourcesProperty([]) }),
    baseIdentity,
    createAccess(env),
  );
  assert.strictEqual(page.id, "page-1");
  assert.strictEqual(calls.length, 1);
  const written = calls[0].body.properties;
  assert.strictEqual(
    written.Sources.rich_text.map((item: any) => item.text.content).join("\n"),
    "token:entity:E-20\ntoken:matter:MAT-20",
    "the opaque pair is the whole payload, as link-less rich text",
  );
  assert.strictEqual(Object.prototype.hasOwnProperty.call(written, "Entity_Token"), false, "no token property is written");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(written, "Matter_Token"), false);
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

test("createHandoff: a caller Entity token that CONTRADICTS the token Sources declares is refused -- the payload is the record, so nothing overrides it", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties(), { entityToken: "E-99", matterToken: "MAT-20" }, createAccess(env)),
    (err: unknown) => err instanceof HandoffWriteViolationError && /contradictory bindings/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
});

test("createHandoff: a caller Matter token that CONTRADICTS the token Sources declares is refused -- the payload is the record, so nothing overrides it", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () => createHandoff(env, validProperties(), { entityToken: "E-20", matterToken: "MAT-99" }, createAccess(env)),
    (err: unknown) => err instanceof HandoffWriteViolationError && /contradictory bindings/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
});

test("createHandoff: a whitespace-only caller token is treated as absent -- identity travels in Sources, never in the caller's arguments", async (t) => {
  mockNotionFetch(t);
  const env = fakeEnv();
  // The record's identity is the pair Sources declares; a blank argument is
  // no identity of its own and therefore never contradicts it.
  await assert.doesNotReject(() => createHandoff(env, validProperties(), { entityToken: "   ", matterToken: "MAT-20" }, createAccess(env)));
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

test("buildSourceBoundaryMarker: canonical sources with NO identity tokens bind the marker to those sources and carry only the content checks -- a receiver that resolved different sources refuses it", () => {
  const marker = buildSourceBoundaryMarker(
    { entityToken: "", matterToken: "" },
    "Passed",
    [],
    { sourceIds: [CN_SOURCES_PAGE_ID, ENTITY_SOURCES_PAGE_ID] },
  );
  assert.ok(!/entity=/.test(marker), "no identity binding is invented for a write that carried none");
  assert.ok(!/matter=/.test(marker), "no identity binding is invented for a write that carried none");
  assert.ok(
    marker.includes(`refs=${[CN_SOURCES_PAGE_ID, ENTITY_SOURCES_PAGE_ID].sort().join(",")}`),
    "the marker binds to the exact canonical references",
  );
  const parsed = parseSourceBoundaryMarker(`Reason text before it. ${marker}`, {
    handoffId: "page-1",
    sourceIds: [ENTITY_SOURCES_PAGE_ID, CN_SOURCES_PAGE_ID],
  });
  if (!parsed.ok) assert.fail(`the receiver's refs-form parse must accept this marker: ${parsed.reason}`);
  assert.deepStrictEqual([...parsed.attestation.checks].sort(), [...CONTENT_CHECKS_ONLY].sort());
  assert.strictEqual(
    parseSourceBoundaryMarker(marker, { handoffId: "page-1", sourceIds: [CN_SOURCES_PAGE_ID] }).ok,
    false,
    "a marker bound to other references than this receiver validated is unbound evidence",
  );
  assert.strictEqual(
    parseSourceBoundaryMarker(marker, { handoffId: "page-1", entityToken: "E-20", matterToken: "MAT-20" }).ok,
    false,
    "a refs-form marker is never accepted by a receiver that presents tokens instead of the same references",
  );
});

// --- The Sources property (Phase 2: writable, fail-closed validation) ------
//
// The live Handoffs database carries Sources as rich text (the schema change
// the Architect approved with Phase 2). The governed writer is the only
// write path: a payload whose Sources references parse into exact direct
// references, on a route whose contract permits each reference's type, is
// written; everything else is refused BEFORE any Notion call. The full
// binding validation (exact page fetch, real parent database, tokens,
// lifecycle, approval attestation, Google registration binding) stays
// read-side in resolveHandoffSources, fail-closed at pickup.

const SOURCES_URL = `https://www.notion.so/Call-Notes-CN-007-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
/** A Sources payload: the opaque token pair the route requires, plus its artifacts. */
const SOURCES_PROPERTY = {
  rich_text: [
    { type: "text", text: { content: "token:entity:E-20", link: null } },
    { type: "text", text: { content: "token:matter:MAT-20", link: null } },
    { type: "text", text: { content: SOURCES_URL, link: { url: SOURCES_URL } } },
  ],
};

test("createHandoff (Sales -> Strategy): a valid Sources payload is written -- the sent payload carries the Sources property with its link", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const { page } = await createHandoff(env, salesToStrategyProperties({ Sources: SOURCES_PROPERTY }), baseIdentity, createAccess(env));
  assert.strictEqual(page.id, "page-1");
  assert.strictEqual(calls.length, 1);
  const written = calls[0].body.properties.Sources?.rich_text?.find((item: any) => item.text?.link?.url);
  assert.strictEqual(written?.text?.link?.url, SOURCES_URL, "the Sources reference travels verbatim with its link");
  assert.strictEqual(
    calls[0].body.properties.Sources.rich_text.map((item: any) => item.text.content).slice(0, 2).join(","),
    "token:entity:E-20,token:matter:MAT-20",
    "the opaque pair travels with it",
  );
});

test("updateHandoff: a lifecycle update may carry Sources -- but only with its contracted route recorded on the payload", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  await updateHandoff(env, "page-1", salesToStrategyProperties({ Sources: SOURCES_PROPERTY }), lifecycleAccess("page-1"));
  assert.ok(calls.length >= 1);
  const update = calls.find((c) => c.method === "PATCH");
  assert.strictEqual(
    update?.body?.properties?.Sources?.rich_text?.find((item: any) => item.text?.link?.url)?.text?.link?.url,
    SOURCES_URL,
  );
});

test("createHandoff: Sources on an uncontracted route is refused outright -- zero Notion calls", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  // A Finance -> Strategy payload: a real route, but one with no Handoff
  // source route contract -- which routes carry sources is an explicit
  // contract decision, never guessed. (Finance -> Sales WAS this case until
  // its identity requirement was added; an uncontracted route is exercised
  // on one that still has no contract.)
  await assert.rejects(
    () =>
      createHandoff(
        env,
        validProperties({ "From Unit": select("Finance"), "To Unit": select("Strategy"), Sources: SOURCES_PROPERTY }),
        baseIdentity,
        createAccess(env),
      ),
    (err: unknown) => err instanceof HandoffWriteViolationError && /has no Handoff source route contract/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
});

test("createHandoff (Strategy -> Finance): the contracted Sources payload is written -- canonical Entity/Matter references plus the upstream Call Notes reference, tokens retained", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  // The exact shape Strategy's producer writes (buildStrategyFinanceHandoffSources):
  // bare-id canonical links, never title slugs, alongside the legacy tokens.
  const entityUrl = "https://www.notion.so/eeee6666-dddd-7777-cccc-8888bbbb4444";
  const matterUrl = "https://www.notion.so/ffff5555-eeee-6666-dddd-7777cccc8888";
  const callNotesUrl = "https://www.notion.so/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const { page, sourceBoundaryAttestation } = await createHandoff(
    env,
    validProperties({ Sources: sourcesProperty([entityUrl, matterUrl, callNotesUrl]) }),
    baseIdentity,
    createAccess(env),
  );
  assert.strictEqual(page.id, "page-1");
  const create = calls.find((c) => c.method === "POST" && c.body?.properties?.Sources);
  assert.ok(create, "the Handoff must be created with its Sources payload");
  const entries = create.body.properties.Sources.rich_text.map((item: any) => item.text.content);
  assert.deepStrictEqual(entries, ["token:entity:E-20", "token:matter:MAT-20", entityUrl, matterUrl, callNotesUrl],
    "the opaque pair rides first, and every canonical reference travels verbatim with its link");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(create.body.properties, "Entity_Token"), false, "the retired property is written nowhere");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(create.body.properties, "Matter_Token"), false);
  // Tokens were supplied, so this write honestly attests all five checks.
  assert.deepStrictEqual([...sourceBoundaryAttestation.checks].sort(), [...SOURCE_BOUNDARY_CHECKS].sort());
});

test("createHandoff: a Google reference on a route whose contract does not permit its type is refused outright -- zero Notion calls", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const googleDocUrl = "https://docs.google.com/document/d/abc123DEF456ghi789jkl012mno345pq/edit";
  await assert.rejects(
    () =>
      createHandoff(
        env,
        salesToStrategyProperties({
          Sources: { rich_text: [{ type: "text", text: { content: googleDocUrl, link: { url: googleDocUrl } } }] },
        }),
        baseIdentity,
        createAccess(env),
      ),
    (err: unknown) => err instanceof HandoffWriteViolationError && /does not permit/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "the pickup would refuse it anyway -- refused here instead of creating a doomed record");
});

test("createHandoff: malformed Sources references are refused outright -- zero Notion calls, each with its exact reason", async (t) => {
  const cases: Array<{ name: string; urls: string[]; expected: RegExp }> = [
    { name: "not a URL at all", urls: ["just some words"], expected: /neither an exact Notion page link .*nor a recognized direct Google/ },
    { name: "a database link, not a page link", urls: ["https://www.notion.so/Acme-Case-Notes-12345678-abcd-ef01-2345-6789abcdef01?v=deadbeef"], expected: /database-view parameter/ },
    { name: "a drive.google.com share link", urls: ["https://drive.google.com/file/d/abc123DEF456ghi789jkl012mno345pq/view"], expected: /neither an exact Notion page link .*nor a recognized direct Google/ },
    { name: "the same page referenced twice", urls: [SOURCES_URL, SOURCES_URL.replace("Call-Notes-", "Other-")], expected: /more than once/ },
    { name: "the same Google file referenced through two URL shapes", urls: ["https://docs.google.com/document/d/abc123DEF456ghi789jkl012mno345pq/edit", "https://docs.google.com/document/d/abc123DEF456ghi789jkl012mno345pq/preview"], expected: /references Google file .* more than once/ },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const calls = mockNotionFetch(t);
      const env = fakeEnv();
      const property = { rich_text: c.urls.map((url) => ({ type: "text", text: { content: url, link: { url } } })) };
      await assert.rejects(
        () => createHandoff(env, salesToStrategyProperties({ Sources: property }), baseIdentity, createAccess(env)),
        (err: unknown) => err instanceof HandoffWriteViolationError && c.expected.test((err as Error).message),
        c.name,
      );
      assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
    });
  }
  await t.test("present but empty", async (t) => {
    const calls = mockNotionFetch(t);
    const env = fakeEnv();
    await assert.rejects(
      () => createHandoff(env, salesToStrategyProperties({ Sources: { rich_text: [] } }), baseIdentity, createAccess(env)),
      (err: unknown) => err instanceof HandoffWriteViolationError && /carries no entry/.test((err as Error).message),
    );
    assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
  });
});

test("createHandoff: real identity inside a Sources URL is refused -- the URL text is protected like every other Handoff field", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const urlWithIdentity = `https://www.notion.so/Call-Notes-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?email=comfort@meridianfoods.com`;
  await assert.rejects(
    () =>
      createHandoff(
        env,
        salesToStrategyProperties({
          Sources: {
            rich_text: [
              { type: "text", text: { content: "token:entity:E-20", link: null } },
              { type: "text", text: { content: "token:matter:MAT-20", link: null } },
              { type: "text", text: { content: urlWithIdentity, link: { url: urlWithIdentity } } },
            ],
          },
        }),
        { ...baseIdentity, email: "comfort@meridianfoods.com" },
        createAccess(env),
      ),
    (err: unknown) => err instanceof HandoffWriteViolationError && /email/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "a failed identity check must never produce a Handoff write");
});

test("createHandoff: the compatibility seam is exact -- a DECLARED-GENERIC route with no Sources property still writes, and the sent payload carries no Sources key", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  // The only shape that may omit `Sources` is a route whose contract says
  // its identity is not an Entity/Matter binding at all. For that route the
  // payload stays byte-identical to what the writer always sent.
  const contracts: Readonly<Record<string, HandoffSourceRouteContract>> = {
    "BD->Strategy": { requiresEntityToken: false, requiresMatterToken: false, required: [], optional: ["call_notes"], prohibited: ["handoffs", "entities", "matters"] },
  };
  const properties = validProperties({
    "From Unit": select("BD"),
    "To Unit": select("Strategy"),
    Handoff: title("Weekly operations digest"),
    Reason: richText("No Entity or Matter is this route's currency."),
  });
  delete (properties as Record<string, unknown>).Sources;

  const { page } = await createHandoff(env, properties, {}, createAccess(env), contracts);
  assert.strictEqual(page.id, "page-1");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(calls[0].body.properties, "Sources"),
    false,
    "a declared-generic route's payloads (no Sources property) are byte-identical to what the writer always sent",
  );
});

test("createHandoff: omitting Sources cannot bypass an identity-required route's contract -- the caller's own tokens are not a transport the record carries", async (t) => {
  // THE regression this gate exists for: a caller supplies both tokens as
  // ARGUMENTS while writing no Sources at all. Before the fix this passed the
  // write gate and produced a Handoff every consumer then refused -- the
  // retired token properties are written nowhere, so those arguments never
  // reached the record.
  //
  // Derived from the REAL contract table rather than a hardcoded list, so a
  // route added later is refused-for-the-same-reason here automatically.
  const identityRequiredRoutes = Object.entries(HANDOFF_SOURCE_ROUTE_CONTRACTS).filter(
    ([, contract]) => contract.requiresEntityToken || contract.requiresMatterToken,
  );
  assert.ok(identityRequiredRoutes.length > 0, "the production table must declare at least one identity-required route");
  for (const [routeKey, contract] of identityRequiredRoutes) {
    const [from, to] = routeKey.split("->");
    await t.test(routeKey, async (t) => {
      const calls = mockNotionFetch(t);
      const env = fakeEnv();
      const properties = validProperties({
        "From Unit": select(from),
        "To Unit": select(to),
        Handoff: title(`Commercial work — ${routeKey}`),
      });
      delete (properties as Record<string, unknown>).Sources;

      await assert.rejects(
        () => createHandoff(env, properties, baseIdentity, createAccess(env)),
        (err: unknown) => {
          if (!(err instanceof HandoffWriteViolationError)) return false;
          const reason = (err as Error).message;
          // Checked as substrings: the refusal must name the exact route and
          // the exact requirement, with no regex escaping of either.
          return (
            reason.includes(`carries no "Sources" property, and route "${routeKey}" requires its opaque Entity/Matter tokens there`)
          );
        },
        `${routeKey} (requiresEntityToken=${contract.requiresEntityToken}, requiresMatterToken=${contract.requiresMatterToken})`,
      );
      assert.strictEqual(calls.length, 0, `${routeKey}: refused before ANY Notion call`);
    });
  }
});

// --- Source-based identity at the write boundary --------------------------
//
// A Handoff whose operational identity is its canonical `Sources`, not the
// token properties: the write carries no Entity_Token/Matter_Token, the
// marker binds to the exact references the payload declares, and only the
// checks this write actually established are attested. A declared-generic
// route carries no Entity/Matter identity at all, and none is invented.

const ENTITY_SOURCES_URL = `https://www.notion.so/Acme-Entity-eeee6666-dddd-7777-cccc-8888bbbb4444`;
const MATTER_SOURCES_URL = `https://www.notion.so/Acme-Matter-ffff5555-eeee-6666-dddd-7777cccc8888`;
const CN_SOURCES_URL = `https://www.notion.so/Call-Notes-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
const ENTITY_SOURCES_PAGE_ID = "eeee6666-dddd-7777-cccc-8888bbbb4444";
const MATTER_SOURCES_PAGE_ID = "ffff5555-eeee-6666-dddd-7777cccc8888";
const CN_SOURCES_PAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONTENT_CHECKS_ONLY = SOURCE_BOUNDARY_CHECKS.filter(
  (c) => c !== "operational_entity_reference_present" && c !== "operational_matter_reference_present",
);

/**
 * A `Sources` payload: the opaque token pair the commercial routes require,
 * followed by its artifacts. Pass `{ tokens: false }` only for a route whose
 * contract requires neither token.
 */
function sourcesProperty(urls: string[], opts: { tokens?: boolean } = {}) {
  const entries = opts.tokens === false ? urls : ["token:entity:E-20", "token:matter:MAT-20", ...urls];
  return {
    rich_text: entries.map((entry) =>
      entry.startsWith("token:")
        ? { type: "text", text: { content: entry, link: null } }
        : { type: "text", text: { content: entry, link: { url: entry } } },
    ),
  };
}

/**
 * A Sales -> Strategy payload with NO token properties AND no `Sources`
 * property: nothing in it names an operational Entity/Matter reference of
 * any kind, which is the shape every identity-required route must refuse.
 */
function tokenlessSalesToStrategyProperties(overrides: Record<string, unknown> = {}): Record<string, any> {
  const props: Record<string, any> = salesToStrategyProperties();
  delete props.Entity_Token;
  delete props.Matter_Token;
  delete props.Sources;
  // Overrides are re-applied AFTER the deletions, so a test that hands this
  // helper a Sources payload gets it back; one that passes nothing gets the
  // bare payload the refusal tests need.
  return { ...props, ...overrides };
}

test("createHandoff (Sales -> Strategy): a Sources-carrying Handoff writes no token properties -- the marker binds to the opaque pair its own payload declares, and nothing else", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const properties = tokenlessSalesToStrategyProperties({
    Reason: richText("Commercial fit/progression approved. Entry type: inbound_enquiry."),
    Sources: sourcesProperty([ENTITY_SOURCES_URL, MATTER_SOURCES_URL, CN_SOURCES_URL]),
  });

  // The caller supplies no tokens of its own: the pair comes entirely from
  // the payload, which is what the record will carry.
  const { sourceBoundaryAttestation } = await createHandoff(env, properties, {}, createAccess(env));

  const create = calls.find((c) => c.method === "POST" && c.body?.properties?.Reason);
  assert.ok(create, "the Handoff must be created");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(create.body.properties, "Entity_Token"),
    false,
    "no token property is invented -- Sources is the only carrier",
  );
  assert.strictEqual(Object.prototype.hasOwnProperty.call(create.body.properties, "Matter_Token"), false);
  assert.strictEqual(
    create.body.properties.Sources.rich_text.map((item: any) => item.text.content).slice(0, 2).join(","),
    "token:entity:E-20,token:matter:MAT-20",
    "the opaque pair the marker binds to is what the payload actually declares",
  );

  // The marker is bound to that declared pair -- the reference this write
  // really carries -- and to nothing it did not establish.
  const reason = propertyText(create.body.properties.Reason);
  const marker = /\[source_boundary_check [^\]]*\]/.exec(reason)?.[0] ?? "";
  assert.ok(marker, `the durable attestation marker must be in the Handoff's Reason: ${reason}`);
  assert.match(marker, /result=Passed/);
  assert.ok(marker.includes("entity=E-20"), "marker must bind to the operational Entity reference");
  assert.ok(marker.includes("matter=MAT-20"), "marker must bind to the operational Matter reference");
  for (const check of SOURCE_BOUNDARY_CHECKS) {
    assert.ok(marker.includes(check), `marker must evidence ${check}`);
  }
  assert.deepStrictEqual([...sourceBoundaryAttestation.checks].sort(), [...SOURCE_BOUNDARY_CHECKS].sort());

  // The receiver's side of the same channel: it accepts the marker only
  // when its OWN resolution produced those same references.
  const parsed = parseSourceBoundaryMarker(reason, {
    handoffId: "page-1",
    entityToken: "E-20",
    matterToken: "MAT-20",
  });
  if (!parsed.ok) assert.fail(`the receiver's identity-form parse must accept this marker: ${parsed.reason}`);
  assert.strictEqual(
    parseSourceBoundaryMarker(reason, { handoffId: "page-1", entityToken: "E-20", matterToken: "MAT-99" }).ok,
    false,
    "a marker bound to other references than this receiver resolved is unbound evidence",
  );
  assert.strictEqual(
    parseSourceBoundaryMarker(reason, {
      handoffId: "page-1",
      sourceIds: [ENTITY_SOURCES_PAGE_ID, MATTER_SOURCES_PAGE_ID, CN_SOURCES_PAGE_ID],
    }).ok,
    false,
    "an identity-form marker is never accepted by a receiver presenting refs instead of the same identity",
  );
});

test("createHandoff: a payload with NEITHER tokens nor Sources on a route that needs an Entity/Matter is refused -- zero Notion calls", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  // With no `Sources` and no caller tokens there is nothing at all to bind
  // to; the route contract refuses it first, and the operational-reference
  // gate would refuse it again if it somehow got past that.
  await assert.rejects(
    () => createHandoff(env, tokenlessSalesToStrategyProperties(), {}, createAccess(env)),
    (err: unknown) =>
      err instanceof HandoffWriteViolationError &&
      /carries no "Sources" property, and route .* requires its opaque Entity\/Matter tokens there/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
});

test("createHandoff: a route declared generic writes a Handoff with neither identity tokens nor Sources -- nothing invented, and no Sales -> Strategy marker", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  const contracts: Readonly<Record<string, HandoffSourceRouteContract>> = {
    "BD->Strategy": { requiresEntityToken: false, requiresMatterToken: false, required: [], optional: ["call_notes"], prohibited: ["handoffs", "entities", "matters"] },
  };
  const properties = validProperties({
    "From Unit": select("BD"),
    "To Unit": select("Strategy"),
    Handoff: title("Weekly operations digest"),
    Reason: richText("No Entity or Matter is this route's currency."),
  });
  delete (properties as Record<string, unknown>).Entity_Token;
  delete (properties as Record<string, unknown>).Matter_Token;
  // The generic contract requires NEITHER token, so the payload carries
  // neither: no `Sources`, and nothing for one.
  delete (properties as Record<string, unknown>).Sources;

  const { sourceBoundaryAttestation } = await createHandoff(env, properties, {}, createAccess(env), contracts);

  const create = calls.find((c) => c.method === "POST" && c.body?.properties?.Reason);
  assert.ok(create, "the Handoff must be created");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(create.body.properties, "Entity_Token"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(create.body.properties, "Matter_Token"), false);
  const reason = propertyText(create.body.properties.Reason);
  assert.ok(
    !/\[source_boundary_check/.test(reason),
    "the source-boundary marker is a Sales -> Strategy contract, and this route is not it",
  );
  // The returned attestation is honest: the content checks this write DID
  // establish, and nothing it did not (this is not a Sales -> Strategy write).
  assert.deepStrictEqual([...sourceBoundaryAttestation.checks].sort(), [...CONTENT_CHECKS_ONLY].sort());
});

test("createHandoff: an identity-bearing URL in an ordinary Handoff field is refused -- URL text is protected content, not an escape hatch", async (t) => {
  const cases: Array<{ name: string; reason: string; expected: RegExp }> = [
    {
      name: "an email address inside a CRM link",
      reason: "Lead detail at https://crm.example.com/leads/detail?email=comfort@meridianfoods.com",
      expected: /email/,
    },
    {
      name: "a phone number inside a call-recording link",
      reason: "Call recording at https://calls.example.com/rec/+233 24 412 3456",
      expected: /phone/,
    },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const calls = mockNotionFetch(t);
      const env = fakeEnv();
      await assert.rejects(
        () =>
          createHandoff(
            env,
            salesToStrategyProperties({ Reason: richText(c.reason) }),
            { ...baseIdentity, email: "comfort@meridianfoods.com", phone: "+233 24 412 3456" },
            createAccess(env),
          ),
        (err: unknown) => err instanceof HandoffWriteViolationError && c.expected.test((err as Error).message),
        c.name,
      );
      assert.strictEqual(calls.length, 0, "a failed identity check must never produce a Handoff write");
    });
  }
});

// ---------------------------------------------------------------------------
// Regression: omitting `Sources` must not bypass a route contract's
// identity-binding rules. The write gate and the read-side resolution gate
// consult the SAME contract table, so every shape refused here is refused at
// pickup identically -- which is the whole reason it is refused BEFORE the
// write rather than after it.
// ---------------------------------------------------------------------------

/** A `Sources` payload from raw entry strings -- token entries stay link-less, URLs get their link. */
function rawSourcesProperty(entries: string[]) {
  return {
    rich_text: entries.map((entry) =>
      entry.startsWith("token:")
        ? { type: "text", text: { content: entry, link: null } }
        : { type: "text", text: { content: entry, link: { url: entry } } },
    ),
  };
}

test("createHandoff: a PARTIAL token pair in Sources is refused -- a half binding is never completed from anywhere else", async (t) => {
  const cases: Array<{ name: string; entries: string[]; expected: RegExp }> = [
    { name: "the Entity token is missing", entries: ["token:matter:MAT-20"], expected: /carries no opaque Entity token/ },
    { name: "the Matter token is missing", entries: ["token:entity:E-20"], expected: /carries no opaque Matter token/ },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const calls = mockNotionFetch(t);
      const env = fakeEnv();
      await assert.rejects(
        () => createHandoff(env, validProperties({ Sources: rawSourcesProperty(c.entries) }), {}, createAccess(env)),
        (err: unknown) => err instanceof HandoffWriteViolationError && c.expected.test((err as Error).message),
        c.name,
      );
      assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
    });
  }
});

test("createHandoff: a syntactically malformed token in Sources is refused outright -- the grammar is the whole token contract", async (t) => {
  const cases: Array<{ name: string; entry: string; expected: RegExp }> = [
    { name: "free text instead of PREFIX-NUMBER", entry: "token:entity:not-a-real-token", expected: /not a syntactically valid opaque entity token/ },
    // The blank token that the retired caller-argument test used to guard:
    // it is refused here, in the transport itself, where identity actually travels.
    // (The entry is trimmed at its boundaries first, so the blank case surfaces
    // as a token entry with no token at all rather than a malformed grammar.)
    { name: "a blank token value", entry: "token:entity:   ", expected: /is not an opaque token entry/ },
    { name: "a token with an identity-bearing suffix", entry: "token:matter:MAT-20-meridianfoods.com", expected: /not a syntactically valid opaque matter token/ },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const calls = mockNotionFetch(t);
      const env = fakeEnv();
      await assert.rejects(
        () =>
          createHandoff(
            env,
            validProperties({ Sources: rawSourcesProperty([c.entry, c.entry.startsWith("token:entity") ? "token:matter:MAT-20" : "token:entity:E-20"]) }),
            {},
            createAccess(env),
          ),
        (err: unknown) => err instanceof HandoffWriteViolationError && c.expected.test((err as Error).message),
        c.name,
      );
      assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
    });
  }
});

test("createHandoff: canonical Entity/Matter LINKS alone cannot satisfy a required identity binding -- a link cross-checks a token, it never replaces one", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  await assert.rejects(
    () =>
      createHandoff(
        env,
        validProperties({ Sources: sourcesProperty([ENTITY_SOURCES_URL, MATTER_SOURCES_URL], { tokens: false }) }),
        {},
        createAccess(env),
      ),
    (err: unknown) => err instanceof HandoffWriteViolationError && /carries no opaque Entity token/.test((err as Error).message),
  );
  assert.strictEqual(calls.length, 0, "refused before ANY Notion call");
});

test("updateHandoff: a lifecycle update that does not rewrite Sources still succeeds -- immutable source data is never resubmitted", async (t) => {
  const calls = mockNotionFetch(t);
  const env = fakeEnv();
  // Exactly the shape every lifecycle transition sends: one field, no route,
  // no Sources. The receiver already validated the Handoff's sources on the
  // way in; an unrelated update must not be forced to restate them.
  await updateHandoff(env, "page-1", { Status: select("Picked-up") }, lifecycleAccess("page-1"));
  const update = calls.find((c) => c.method === "PATCH");
  assert.ok(update, "the lifecycle write must go through");
  assert.deepStrictEqual(Object.keys(update.body.properties), ["Status"], "the patch carries the field it is changing and nothing else");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(update.body.properties, "Sources"), false);
});

test("write gate and read gate agree: the writer's Sources payload is what the receiver accepts, and what it refuses it refuses identically", async () => {
  const env = fakeEnv();

  // 1. The writer's valid payload extracts as the exact identity the route
  //    contract requires -- through the REAL extraction, not a re-implementation.
  const written = validProperties();
  const extraction = extractHandoffSources(written);
  assert.ok(extraction.ok, extraction.ok ? "" : extraction.reason);
  assert.strictEqual(extraction.mode, "sources");
  assert.deepStrictEqual(extraction.tokens, { entityToken: "E-20", matterToken: "MAT-20" });

  // 2. The payload the writer now refuses is the payload the receiver refuses,
  //    for the same route-contract reason, with no fetch to fill the gap.
  const noSources = tokenlessSalesToStrategyProperties();
  const receiver = await resolveHandoffSources(env, {
    properties: noSources as any,
    tokens: { entityToken: "E-20", matterToken: "MAT-20" },
    route: { fromUnit: "Sales", toUnit: "Strategy" },
    access: lifecycleAccess("page-1"),
  });
  assert.equal(receiver.ok, false, "the receiver must refuse a Handoff with no Sources on an identity-required route");
  if (!receiver.ok) {
    assert.match(receiver.reason, /requires an Entity\/Matter binding/);
  }

  // ...and the writer refuses that exact payload too.
  await assert.rejects(
    () => createHandoff(env, tokenlessSalesToStrategyProperties(), baseIdentity, createAccess(env)),
    (err: unknown) =>
      err instanceof HandoffWriteViolationError &&
      /carries no "Sources" property, and route "Sales->Strategy" requires its opaque Entity\/Matter tokens there/.test((err as Error).message),
  );
});
