import test from "node:test";
import assert from "node:assert";
import { businessDevelopmentManifest } from "../units/businessDevelopment/businessDevelopmentManifest";
import { evaluateCandidates } from "../units/sales/leadGenerationDiscovery";
import type { WebSearchResult } from "../units/research/webSearch";
import type { Env } from "../types";

/**
 * The cross-Hat reuse proof for the `research-signal` Skill (Skills
 * architecture assessment + OS-analogy review, Build order Step 2). Per
 * the OS analogy's own five-part test (docs/enig-operating-model.md,
 * "Build order"), this is not satisfied by either Hat working in
 * isolation -- it requires both in the same proof, asserting:
 *
 * 1. Both Hats fetch the identical Skill content (same Notion page,
 *    same methodology) -- proven by the shared marker below appearing
 *    in both assembled prompts.
 * 2. Each Hat's own Persona/authority framing is distinct and present
 *    only in its own prompt -- research-signal never carries or leaks
 *    Hat-specific authority into the shared methodology.
 * 3. Each Hat resolves independently per call -- BD's discover_opportunity
 *    is a "read" action with no approval; Sales's evaluateCandidates
 *    feeds an eventual Lead-creation action gated on Martin's approval.
 *    Neither Hat's invocation carries state from the other.
 *
 * Fresh per-call Data Source/authority resolution itself (no caching
 * across Hats) is primitives.ts's own concern and already covered by
 * primitives.test.ts; this test's job is specifically the Skill-reuse
 * proof, not re-proving the primitive layer underneath it.
 */

const RESEARCH_SIGNAL_MARKER = "STUB_RESEARCH_SIGNAL_METHODOLOGY_MARKER";
const BD_PERSONA_MARKER = "You identify potential Business Development opportunities";
const SALES_HAT_DEFINITION_MARKER = "STUB_LGS_HAT_DEFINITION_MARKER";

function createMockKv() {
  const store = new Map<string, string>();
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

function fakeEnv(): Env {
  return {
    NOTION_TOKEN: "test-token",
    NOTION_VERSION: "2025-09-03",
    STATE_KV: createMockKv() as any,
  } as unknown as Env;
}

/** Returns whichever governance/skill marker corresponds to the requested Notion page, distinguishing Sales's Hat Definition/Universal Role Contract fetches from research-signal's own methodology fetch by page id. */
function mockNotionFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const urlStr = String(url);
    if (urlStr.includes("/blocks/")) {
      const marker = urlStr.includes("3e9cb004") ? RESEARCH_SIGNAL_MARKER : SALES_HAT_DEFINITION_MARKER;
      return new Response(JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: marker }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("research-signal: BD's discover_opportunity and Sales's evaluateCandidates both fetch the identical Skill content, under distinct Personas, with no shared state between the two calls", async (t) => {
  mockNotionFetch(t);

  const bdEnv = fakeEnv();
  const bdCapturedSystems: string[] = [];
  bdEnv.AI = {
    run: async (_model: any, opts: any) => {
      bdCapturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ signal: "A candidate opportunity", whyItMayMatter: "Plausible fit", evidenceNeeded: ["more detail"] }) };
    },
  } as any;

  const opportunityDevelopmentHat = businessDevelopmentManifest.hats["Business Development Manager"];
  await opportunityDevelopmentHat.readHandler(bdEnv, "discover_opportunity", "There's a signal worth looking at");

  const salesEnv = fakeEnv();
  const salesCapturedSystems: string[] = [];
  salesEnv.AI = {
    run: async (_model: any, opts: any) => {
      salesCapturedSystems.push(opts.messages[0].content);
      return { response: JSON.stringify({ candidates: [{ pass: true, organisation: "Nova Inc", evidence: "Expanded markets, unchanged messaging", decisionMakerOrRole: "", category: "positioning", reason: "Meets criteria" }] }) };
    },
  } as any;

  const results: WebSearchResult[] = [{ title: "Nova Inc positioning shift", url: "https://example.com/nova", snippet: "Nova expanded into a new market." }];
  await evaluateCandidates(salesEnv, results);

  // 1. Both fetched the identical Skill content.
  assert.strictEqual(bdCapturedSystems.length, 1);
  assert.strictEqual(salesCapturedSystems.length, 1);
  assert.match(bdCapturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));
  assert.match(salesCapturedSystems[0], new RegExp(RESEARCH_SIGNAL_MARKER));

  // 2. Each Hat's own Persona/authority framing is distinct and does not leak into the other's prompt.
  assert.match(bdCapturedSystems[0], new RegExp(BD_PERSONA_MARKER));
  assert.doesNotMatch(salesCapturedSystems[0], new RegExp(BD_PERSONA_MARKER));
  assert.match(salesCapturedSystems[0], new RegExp(SALES_HAT_DEFINITION_MARKER));
  assert.doesNotMatch(bdCapturedSystems[0], new RegExp(SALES_HAT_DEFINITION_MARKER));

  // 3. Independent resolution -- neither call's captured prompt carries any trace of the other's evidence/context.
  assert.doesNotMatch(bdCapturedSystems[0], /Nova Inc/);
  assert.doesNotMatch(salesCapturedSystems[0], /candidate opportunity/);
});
