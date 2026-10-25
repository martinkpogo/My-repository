import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * Contract tests for the sales-call-evidence skill (Issue #362).
 *
 * These tests read the actual SKILL.md and verify that its written contract
 * carries the canonical requirements from the Isolated Sales Operating
 * Specification (Project Instruction §§4/7/8), the Static Reference (Evidence
 * classes, Qualification conditions, Call Notes, Handoffs) and BD-5, and they
 * pin representative decision cases from the approved CVE evaluator rule.
 *
 * They are instruction-level checks of written skill content plus a reference
 * decision table — they are NOT technical enforcement of the skill at runtime.
 */

const skill = readFileSync(
  new URL('../../../plugins/enig-sales/skills/sales-call-evidence/SKILL.md', import.meta.url),
  'utf8',
);
const packageScript = readFileSync(
  new URL('../../../plugins/enig-sales/scripts/package_plugin.py', import.meta.url),
  'utf8',
);
const archiveScript = readFileSync(
  new URL('../../../plugins/enig-sales/scripts/validate_archive.py', import.meta.url),
  'utf8',
);
const validatorScript = readFileSync(
  new URL('../../../plugins/enig-sales/scripts/validate_plugin.py', import.meta.url),
  'utf8',
);

// ---------------------------------------------------------------------------
// Reference CVE decision table — encodes the approved evaluator rule
// (Static Reference: "Satisfied when a numerical value at stake or cost of
// inaction has a non-assumption evidence type, an attributable source and a
// period; otherwise Insufficient Evidence (or Not Satisfied when the evidence
// contradicts it)"; BD-5 items 2–3).
// ---------------------------------------------------------------------------

type CveEvidence = {
  /** Numeric value at stake or cost of inaction; absent when unknown. */
  valueAtStake?: number | string;
  /** Period the value applies to. */
  period?: string;
  /** Evidence type: canonical class other than an assumption, or 'assumption'. */
  evidenceType?: 'CF' | 'CS' | 'SO' | 'INF' | 'HYP' | 'UQ' | 'VE' | 'assumption';
  /** Attributable source reference. */
  source?: string;
  /** True only when the available evidence contradicts the condition. */
  contradictsCondition?: boolean;
};

type CveOutcome = 'Satisfied' | 'Not Satisfied' | 'Insufficient Evidence';

function determineCveOutcome(e: CveEvidence): CveOutcome {
  if (e.contradictsCondition === true) return 'Not Satisfied';
  const hasValue =
    e.valueAtStake !== undefined && e.valueAtStake !== null && e.valueAtStake !== '';
  const hasPeriod = typeof e.period === 'string' && e.period.length > 0;
  const hasSource = typeof e.source === 'string' && e.source.length > 0;
  const nonAssumptionEvidence = e.evidenceType !== undefined && e.evidenceType !== 'assumption';
  if (hasValue && nonAssumptionEvidence && hasSource && hasPeriod) return 'Satisfied';
  return 'Insufficient Evidence';
}

test('CVE representative case: complete evidence is Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({
      valueAtStake: 180000,
      period: 'per year',
      evidenceType: 'CF',
      source: 'Call Notes Note, verified from client-supplied figure',
    }),
    'Satisfied',
  );
});

test('CVE representative case: contradictory evidence is Not Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({
      valueAtStake: 180000,
      period: 'per year',
      evidenceType: 'CF',
      source: 'client call',
      contradictsCondition: true,
    }),
    'Not Satisfied',
  );
});

test('CVE boundary: missing period is Insufficient Evidence, never Not Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ valueAtStake: 180000, evidenceType: 'CF', source: 'client call' }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: missing numerical value is Insufficient Evidence, never Not Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ period: 'per year', evidenceType: 'CF', source: 'client call' }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: assumption-only evidence can never be Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({
      valueAtStake: 180000,
      period: 'per year',
      evidenceType: 'assumption',
      source: 'sales guess',
    }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: no attributable source is Insufficient Evidence', () => {
  assert.strictEqual(
    determineCveOutcome({ valueAtStake: 180000, period: 'per year', evidenceType: 'CF' }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: wholly absent evidence is Insufficient Evidence, not Not Satisfied', () => {
  assert.strictEqual(determineCveOutcome({}), 'Insufficient Evidence');
});

// ---------------------------------------------------------------------------
// Skill document contract — verifies the actual requirements written in
// SKILL.md, so a regression in the skill text fails these tests.
// ---------------------------------------------------------------------------

test('skill frontmatter carries the skill name and a description with the no-writes marker', () => {
  const match = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'frontmatter block missing');
  const frontmatter = match[1];
  assert.match(frontmatter, /^name: sales-call-evidence$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.match(frontmatter, /No governed writes or external actions\./);
});

test('skill uses exactly the canonical evidence classes (CF, CS, SO, INF, HYP, UQ, VE)', () => {
  for (const cls of ['CF', 'CS', 'SO', 'INF', 'HYP', 'UQ', 'VE']) {
    assert.ok(
      new RegExp(`\\b${cls}\\b`).test(skill),
      `canonical evidence class ${cls} missing from skill`,
    );
  }
  assert.match(skill, /Canonical evidence classes only/);
  // The pre-canonical invented classification set must not return.
  assert.doesNotMatch(skill, /Verified fact \| Client-reported/);
});

test('skill requires source attribution and traceability for verified facts', () => {
  assert.match(skill, /identifiable source/);
  assert.match(skill, /traceable source reference/);
  assert.match(skill, /never promoted to `CF`/);
});

test('skill states the four-element Satisfied rule from the canonical CVE determination', () => {
  const satisfied = skill.split('**`Not Satisfied`**')[0];
  assert.match(satisfied, /numerical value at stake or cost of inaction/);
  assert.match(satisfied, /non-assumption evidence type/);
  assert.match(satisfied, /attributable source/);
  assert.match(satisfied, /period/);
});

test('skill restricts Not Satisfied to contradiction and Insufficient Evidence to absence', () => {
  assert.match(skill, /\*\*`Not Satisfied`\*\*.*contradict/s);
  assert.match(skill, /Missing or incomplete evidence is never `Not Satisfied`/);
  assert.match(skill, /Insufficient Evidence.*missing, unsupported, or inconclusive/s);
  assert.match(skill, /correct outcome whenever required elements are absent/);
  assert.match(skill, /List each specific gap and what evidence would resolve it/);
});

test('skill forbids CVE outcomes from bypassing qualification conditions or progression approval', () => {
  assert.match(skill, /must not bypass the other qualification conditions or Martin's progression approval/);
});

test('skill pins the determination to the evaluator rule and Martin attestation', () => {
  assert.match(skill, /mirrors the Runtime deterministic evaluator/);
  assert.match(skill, /Martin attests the determination when he approves the record/);
});

test('skill requires Martin explicit approval for Call Notes record creation', () => {
  assert.match(skill, /one canonical Call Notes record per completed call/is);
  assert.match(skill, /Martin's explicit approval of that exact creation/);
});

test('skill requires the CVE block to be written into the Note before approval', () => {
  assert.match(skill, /=== COMMERCIAL VALUE EVIDENCE ===/);
  assert.match(skill, /END COMMERCIAL VALUE EVIDENCE ===/);
  assert.match(skill, /determination`, `evidenceText`, `evidence/);
  assert.match(skill, /written into `Note` \*\*before\*\* the record is approved/);
});

test('skill preserves the six-field approval hash covering metadata, not Note content', () => {
  assert.match(skill, /six-field `record_approval` approval-hash contract/);
  assert.match(skill, /does \*\*not\*\* hash `Note` content/);
  assert.match(skill, /Legacy eight-field markers are rejected/);
});

test('skill requires governed new Version and re-approval for any approved Note change', () => {
  assert.match(skill, /requires a governed new `Version` and re-approval/);
  assert.match(skill, /adding the CVE block later/);
  assert.match(skill, /Version\` 1, Status `Ready`/);
});

test('skill treats the approved Call Notes Note as canonical and read by Strategy and Finance', () => {
  assert.match(skill, /approved Call Notes record's `Note` is the only substantive evidence content/);
  assert.match(skill, /Strategy and Finance read the `Note` property, never the page body/);
});

test('skill retains the Handoff CVE copy as temporary compatibility with all three removal conditions', () => {
  assert.match(skill, /Temporary compatibility copy/);
  assert.match(skill, /not an independent source of truth/);
  assert.match(skill, /never authoritative over the Call Notes `Note`/);
  assert.match(skill, /both\*\* consumers have migrated/);
  assert.match(skill, /integration tests verify the canonical `Note` flow/);
  assert.match(skill, /Martin approves removal/);
});

test('skill states Finance authority over pricing sufficiency', () => {
  assert.match(skill, /Finance retains authority to determine whether evidence is sufficient for pricing/);
});

test('skill enforces identity safety with token-only references outside the Registry', () => {
  assert.match(skill, /refer to clients only by token/);
  assert.match(skill, /identity-safe/);
});

test('skill declares no governed writes, no external actions, and instruction-level (unenforced) safeguards', () => {
  assert.match(skill, /No governed writes and no external actions/);
  assert.match(skill, /instruction-level safeguards, not technical enforcement/);
  assert.match(skill, /cannot be reliably enforced within Claude\.ai chat, state that limitation explicitly/);
});

// ---------------------------------------------------------------------------
// Packaging/validator structural contract — the new skill must be part of the
// package allowlist and the structural validator (regression guard for the
// packaging finding on this issue).
// ---------------------------------------------------------------------------

test('packaging and validation scripts include sales-call-evidence in their allowlist', () => {
  for (const [name, script] of [
    ['package_plugin.py', packageScript],
    ['validate_archive.py', archiveScript],
  ] as const) {
    assert.ok(
      script.includes('skills/sales-call-evidence/SKILL.md'),
      `${name} does not allow skills/sales-call-evidence/SKILL.md`,
    );
  }
  assert.ok(
    validatorScript.includes('"sales-call-prep", "sales-call-evidence"'),
    'validate_plugin.py does not require the sales-call-evidence SKILL.md',
  );
});

test('packaging excludes the requirements-mapping documents from the plugin archive', () => {
  assert.match(packageScript, /rel\.startswith\("REQUIREMENTS-MAPPING"\)/);
});
