import test from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NO_ACTION_SKILLS, SkillResolutionError } from "../platform/skillRegistry";
import { discoveryCronContext } from "../access";
import { runActionResearch, runProspectResearch, summarizeResearchSynthesis } from "./actionResearch";
import type { ResearchSynthesis } from "./research/types";

test("Research is Skill-gated: an Action that did not declare research_signal cannot run research at all", async () => {
  const env = {} as never;
  await assert.rejects(() => runActionResearch(env, NO_ACTION_SKILLS, { question: "q", context: "" }, discoveryCronContext()), SkillResolutionError);
  await assert.rejects(() => runProspectResearch(env, NO_ACTION_SKILLS, { question: "q", context: "" }, discoveryCronContext()), SkillResolutionError);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

test("Only Lead Generation's discovery reaches the public-prospect research profile; nothing else calls executeProspectResearch or runProspectResearch", () => {
  const allowed = new Set(["runtime/research/executor.ts", "runtime/actionResearch.ts", "units/sales/leadGenerationDiscovery.ts"]);
  for (const file of walk(join(__dirname, ".."))) {
    const rel = file.slice(join(__dirname, "..").length + 1);
    const text = readFileSync(file, "utf8");
    if (/\b(executeProspectResearch|runProspectResearch)\b/.test(text)) {
      assert.ok(allowed.has(rel), `${rel} must not use the public-prospect research profile`);
    }
  }
});

test("summarizeResearchSynthesis keeps sources with findings, always keeps limitations, and is bounded", () => {
  const synthesis: ResearchSynthesis = {
    protocolsUsed: [],
    sources: [{ id: "s1", source: "Example", sourceType: "web", url: "https://example.com/a", passage: "p", claimSupported: "c", validationStatus: "validated" }],
    evidence: [{ id: "e1", statement: "x", sourceIds: ["s1"] }],
    findings: [{ id: "f1", statement: "The firm rebranded in 2025.", evidenceIds: ["e1"] }],
    implications: [],
    limitations: [{ statement: "Only one source found." }],
  };
  const text = summarizeResearchSynthesis(synthesis);
  assert.match(text, /rebranded in 2025.*https:\/\/example\.com\/a/);
  assert.match(text, /Only one source found/);
  assert.ok(summarizeResearchSynthesis(synthesis, 40).length <= 40);
});
