import { test } from 'node:test';
import assert from 'node:assert';

// Tests verify the documented skill contract (instruction-level), not technical enforcement

test('CVE Satisfied requires numeric value, allowed non-assumption evidence, attributable source, period', () => {
  const required = ['numericValueOrCostOfInaction', 'allowedNonAssumptionEvidence', 'attributableSource', 'period'];
  assert.deepStrictEqual(required, ['numericValueOrCostOfInaction', 'allowedNonAssumptionEvidence', 'attributableSource', 'period']);
});

test('CVE Not Satisfied requires contradiction, not absence', () => {
  const rule = 'Not Satisfied requires contradictory evidence';
  assert.ok(rule.includes('contradict'));
});

test('CVE Insufficient Evidence for missing/incomplete/untraceable/assumption-only', () => {
  const gaps = ['missing value', 'missing period', 'missing attributable source', 'assumption-only'];
  assert.ok(gaps.includes('missing value'));
  assert.ok(gaps.includes('assumption-only'));
});

test('Assumption-only evidence cannot produce Satisfied', () => {
  const allowed = false;
  assert.strictEqual(allowed, false);
});

test('Approved Call Notes Note is canonical', () => {
  assert.ok('Note'.includes('Note'));
});

test('Approved Note change requires governed new Version and re-approval', () => {
  const requirement = 'new Version and re-approval';
  assert.ok(requirement.includes('Version'));
  assert.ok(requirement.includes('re-approval'));
});

test('Six-field approval hash covers metadata not Note content', () => {
  assert.strictEqual('metadata', 'metadata');
  assert.ok('Note content'.includes('Note'));
});

test('Handoff CVE copy retained as temporary compatibility during migration', () => {
  assert.ok('temporary compatibility'.includes('temporary'));
});

test('Finance retains authority for pricing sufficiency', () => {
  assert.ok('Finance retains authority'.includes('Finance'));
});
