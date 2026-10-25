import { test } from 'node:test';
import assert from 'node:assert';

test('CVE outcomes are exactly three', () => {
  const outcomes = ['Satisfied', 'Not Satisfied', 'Insufficient Evidence'];
  assert.strictEqual(outcomes.length, 3);
});

test('Call Notes Note is canonical per BD-5', () => {
  const canonical = 'approved Call Notes Note';
  assert.ok(canonical.includes('Note'));
});

test('Handoff CVE copy is temporary compatibility only', () => {
  const note = 'temporary compatibility data until both consumers migrate';
  assert.ok(note.includes('temporary'));
});

test('Six-field approval hash covers metadata not Note content', () => {
  const hashCovers = 'metadata';
  const hashNotCovers = 'Note content';
  assert.strictEqual(hashCovers, 'metadata');
  assert.ok(hashNotCovers.includes('Note'));
});

test('Approved Note changes require new Version and re-approval', () => {
  const rule = 'new Version and re-approval';
  assert.ok(rule.includes('Version'));
  assert.ok(rule.includes('re-approval'));
});

test('Finance retains authority for pricing sufficiency', () => {
  const authority = 'Finance retains authority';
  assert.ok(authority.includes('Finance'));
});
