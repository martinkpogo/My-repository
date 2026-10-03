import test from "node:test";
import assert from "node:assert";
import { businessDevelopmentManifest } from "../units/businessDevelopment/businessDevelopmentManifest";
import { evaluateCandidates } from "../units/sales/leadGenerationDiscovery";
import { getSkillContent } from "./skillRegistry";
import type { WebSearchResult } from "../runtime/research/webSearch";
import type { Env } from "../types";

/**
 * The cross-Hat reuse proof for the `research_signal` Skill (Skills
 * architecture assessment + OS-analogy review, Build order Step 2). Per
 * the OS analogy's own five-part test (docs/enig-operating-model.md,
 * "Build order"), this is not satisfied by either Hat working in
 * isolation -- it requires both in the same proof, asserting:
 *
 * 1. Both Hats build a prompt containing the identical Skill content
 *    (`getSkillContent("research_signal")`'s own real methodology text) --
 *    proven by matching a distinctive substring of that content in both
 *    assembled prompts.
 * 2. Each Hat's own Persona/authority framing is distinct and present
 *    only in its own prompt -- research_signal never carries or leaks
 *    Hat-specific authority into the shared methodology.
 * 3. Each Hat resolves independently per call -- BD's discover_opportunity
 *    is a "read" action with no approval; Sales's evaluateCandidates
 *    feeds an eventual Lead-creation action gated on Martin's approval.
 *    Neither Hat's invocation carries state from the other.
 *
 * getSkillContent is now a synchronous, repo-native lookup (no Notion
 * round trip) -- migrated 2026-09-28 from the retired fetchSkill/
 * SkillDefinition arrangement (see skillRegistry.ts's own doc comment).
 * Sales's evaluateCandidates still separately fetches its own Hat
 * Definition/Universal Role Contract via getLeadDiscoveryGovernance
 * (a real, live-fetched governance concern, unrelated to Skill content),
 * so Notion is still mocked for that one call, distinct from the
 * Skill-reuse proof itself.
 */

const RESEARCH_SIGNAL_DISTINCTIVE_LINE = "Never fabricate a specific fact";
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

/** Mocks Sales's own Hat Definition/Universal Role Contract governance fetch -- unrelated to Skill content, which is no longer fetched over the network at all. */
function mockNotionFetch(t: any) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const urlStr = String(url);
    if (urlStr.includes("/blocks/")) {
      return new Response(
        JSON.stringify({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: SALES_HAT_DEFINITION_MARKER }] } }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("research_signal: getSkillContent returns the same content regardless of caller -- the actual shared-content precondition for cross-Hat reuse", () => {
  const first = getSkillContent("research_signal");
  const second = getSkillContent("research_signal");
  assert.strictEqual(first, second);
  assert.match(first, new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
});

test("research_signal: BD's discover_opportunity and Sales's evaluateCandidates both assemble a prompt containing the identical Skill content, under distinct Personas, with no shared state between the two calls", async (t) => {
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

  // 1. Both prompts contain the identical Skill content.
  assert.strictEqual(bdCapturedSystems.length, 1);
  assert.strictEqual(salesCapturedSystems.length, 1);
  assert.match(bdCapturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));
  assert.match(salesCapturedSystems[0], new RegExp(RESEARCH_SIGNAL_DISTINCTIVE_LINE));

  // 2. Each Hat's own Persona/authority framing is distinct and does not leak into the other's prompt.
  assert.match(bdCapturedSystems[0], new RegExp(BD_PERSONA_MARKER));
  assert.doesNotMatch(salesCapturedSystems[0], new RegExp(BD_PERSONA_MARKER));
  assert.match(salesCapturedSystems[0], new RegExp(SALES_HAT_DEFINITION_MARKER));
  assert.doesNotMatch(bdCapturedSystems[0], new RegExp(SALES_HAT_DEFINITION_MARKER));

  // 3. Independent resolution -- neither call's captured prompt carries any trace of the other's evidence/context.
  assert.doesNotMatch(bdCapturedSystems[0], /Nova Inc/);
  assert.doesNotMatch(salesCapturedSystems[0], /candidate opportunity/);
});
