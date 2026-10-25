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
 * pin representative decision cases from the approved written CVE rule
 * (Static Reference "Commercial Value Evidence determination" + BD-5).
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
// Reference CVE decision table -- encodes ONLY the approved written rule from
// the Static Reference ("Commercial Value Evidence determination": Satisfied
// when a numerical value at stake or cost of inaction has a non-assumption
// evidence type, an attributable source and a period; otherwise Insufficient
// Evidence -- or Not Satisfied when the evidence contradicts it) and BD-5
// items 2-3. It deliberately makes NO claim about the Runtime evaluator's
// implementation; parity has not been demonstrated (see
// REQUIREMENTS-MAPPING-362.md, Uncovered/limitations).
//
// Class permissibility is taken strictly from canonical sources; nothing is
// inferred and no allowed-class list is invented beyond what they resolve:
//   CF         permitted -- Call Notes contract evidence_rules: "Information
//              directly established by permitted source evidence"; labelling
//              table: independently checked, cited with a locator.
//   CS         permitted -- Call Notes contract evidence_rules: "Information
//              explicitly stated during the call"; client-given numbers are
//              recorded as VE class CS (CV&POM 3 recognises client-estimated
//              value as a legitimate value-at-stake category).
//   VE         permitted -- the canonical value-evidence form carrying figure,
//              unit, period, source, class and uncertainty (Static Reference
//              evidence classes), i.e. exactly the rule's four elements.
//   INF        prohibited -- labelling rules: "A conclusion you drew -- never
//              enough to make a condition Supported"; CV&POM 2: missing
//              numerical evidence "must not be filled by inference".
//   HYP        prohibited -- labelling rules: hypothesis "To test", and
//              "Never ... treat pipeline or hoped-for sales as value at
//              stake"; value must be "stated or evidenced" (Call Notes
//              contract value_evidence rule).
//   UQ         prohibited -- labelling rules: "Something that matters but was
//              not stated" -- by definition it supplies no figure, source or
//              period.
//   assumption prohibited -- Static Reference rule requires a "non-assumption
//              evidence type"; assumption-only evidence cannot satisfy the
//              condition on its own.
//   SO         UNRESOLVED in canonical sources: no fetched canonical text says
//              whether a Sales observation may independently carry value at
//              stake (Call Notes contract calls it "Sales interpretation
//              explicitly attributed as an observation"; the labelling table
//              never assigns figures to SO). Per the task's stop rule this is
//              NOT decided here: it fails closed to Insufficient Evidence
//              pending Architect review -- see the dedicated SO test below.
// ---------------------------------------------------------------------------

type EvidenceClass = 'CF' | 'CS' | 'SO' | 'INF' | 'HYP' | 'UQ' | 'VE';

const CANONICALLY_PERMITTED_CLASSES: readonly EvidenceClass[] = ['CF', 'CS', 'VE'];
const CANONICALLY_PROHIBITED_CLASSES: readonly EvidenceClass[] = ['INF', 'HYP', 'UQ'];

type CveEvidence = {
  /** Numeric value at stake or cost of inaction; absent when unknown. */
  valueAtStake?: number | string;
  /** Period the value applies to. */
  period?: string;
  /** Attributable source reference. */
  source?: string;
  /**
   * Canonical evidence class recorded for the figure, or the literal
   * 'assumption' evidence type named by the Static Reference rule, or absent
   * when the basis was never established.
   */
  evidenceClass?: EvidenceClass | 'assumption';
  /** True only when the available evidence contradicts the condition. */
  contradictsCondition?: boolean;
};

type CveOutcome = 'Satisfied' | 'Not Satisfied' | 'Insufficient Evidence';

function determineCveOutcome(e: CveEvidence): CveOutcome {
  if (e.contradictsCondition === true) return 'Not Satisfied';
  const hasValue =
    e.valueAtStake !== undefined && e.valueAtStake !== null && e.valueAtStake !== '';
  if (!hasValue) return 'Insufficient Evidence';
  const cls = e.evidenceClass;
  if (cls === undefined) return 'Insufficient Evidence'; // basis never established
  if (cls === 'assumption') return 'Insufficient Evidence'; // SR: non-assumption evidence type
  if (CANONICALLY_PROHIBITED_CLASSES.includes(cls)) return 'Insufficient Evidence';
  // Fail closed on anything not affirmatively permitted -- including the
  // canonically UNRESOLVED 'SO' basis (reported for Architect review).
  if (!CANONICALLY_PERMITTED_CLASSES.includes(cls)) return 'Insufficient Evidence';
  if (typeof e.source !== 'string' || e.source.length === 0) return 'Insufficient Evidence';
  if (typeof e.period !== 'string' || e.period.length === 0) return 'Insufficient Evidence';
  return 'Satisfied';
}

const completeFigure = {
  valueAtStake: 180000,
  period: 'per year',
  source: 'Call Notes Note, verified from client-supplied figure',
} as const;

test('CVE representative case: complete CF-classed figure is Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'CF' }),
    'Satisfied',
  );
});

test('CVE representative case: complete CS-classed figure (client-estimated) is Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'CS' }),
    'Satisfied',
  );
});

test('CVE representative case: complete VE-classed value evidence is Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'VE' }),
    'Satisfied',
  );
});

test('CVE representative case: contradictory evidence is Not Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({
      ...completeFigure,
      evidenceClass: 'CS',
      contradictsCondition: true,
    }),
    'Not Satisfied',
  );
});

test('CVE boundary: missing period is Insufficient Evidence, never Not Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ valueAtStake: 180000, source: 'client call', evidenceClass: 'CS' }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: missing numerical value is Insufficient Evidence, never Not Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ period: 'per year', source: 'client call', evidenceClass: 'CS' }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: no attributable source is Insufficient Evidence', () => {
  assert.strictEqual(
    determineCveOutcome({ valueAtStake: 180000, period: 'per year', evidenceClass: 'CS' }),
    'Insufficient Evidence',
  );
});

test('CVE boundary: wholly absent evidence is Insufficient Evidence, not Not Satisfied', () => {
  assert.strictEqual(determineCveOutcome({}), 'Insufficient Evidence');
});

test('CVE boundary: an unestablished evidence basis is Insufficient Evidence', () => {
  assert.strictEqual(
    determineCveOutcome({ valueAtStake: 180000, period: 'per year', source: 'client call' }),
    'Insufficient Evidence',
  );
});

test('CVE negative: assumption-classed evidence can never be Satisfied', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'assumption' }),
    'Insufficient Evidence',
  );
});

test('CVE negative: INF can never be Satisfied ("never enough to make a condition Supported")', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'INF' }),
    'Insufficient Evidence',
  );
});

test('CVE negative: HYP can never be Satisfied (a hypothesis is to test, not stated or evidenced value)', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'HYP' }),
    'Insufficient Evidence',
  );
});

test('CVE negative: UQ can never be Satisfied (nothing was stated, so no figure/source/period exists)', () => {
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'UQ' }),
    'Insufficient Evidence',
  );
});

test('CVE negative (UNRESOLVED -- pending Architect): SO fails closed to Insufficient Evidence', () => {
  // Canonical sources do not say whether a Sales observation may independently
  // carry value at stake. The task's stop rule forbids deciding it here, so
  // the reference table fails closed. If Architect rules that SO is permitted,
  // this expectation and CANONICALLY_PERMITTED_CLASSES change together.
  assert.strictEqual(
    determineCveOutcome({ ...completeFigure, evidenceClass: 'SO' }),
    'Insufficient Evidence',
  );
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

test('skill attributes the CVE rule to the approved written sources and makes no Runtime-parity claim', () => {
  assert.match(skill, /approved rule exactly as written in the Static Reference's Commercial Value Evidence determination and BD-5/);
  assert.match(skill, /Martin attests the determination when he approves the record/);
  assert.doesNotMatch(skill, /mirrors the Runtime/i);
  assert.doesNotMatch(skill, /Runtime deterministic evaluator/);
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
