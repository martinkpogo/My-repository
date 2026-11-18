import test from "node:test";
import assert from "node:assert";
import { redactIdentityTerms, findLeftoverBannedTerms, IDENTITY_PLACEHOLDERS } from "./identityRedaction";

test("redactIdentityTerms replaces ENIG with the placeholder, case-insensitively", () => {
  assert.strictEqual(redactIdentityTerms("ENIG is a consultancy."), `${IDENTITY_PLACEHOLDERS.consultancy} is a consultancy.`);
  assert.strictEqual(redactIdentityTerms("Welcome to enig."), `Welcome to ${IDENTITY_PLACEHOLDERS.consultancy}.`);
});

test("redactIdentityTerms handles possessive forms correctly by leaving the 's attached", () => {
  assert.strictEqual(redactIdentityTerms("ENIG's marketing plan"), `${IDENTITY_PLACEHOLDERS.consultancy}'s marketing plan`);
  assert.strictEqual(redactIdentityTerms("Martin's call to make"), `${IDENTITY_PLACEHOLDERS.operator}'s call to make`);
});

test("redactIdentityTerms replaces Martin with the placeholder", () => {
  assert.strictEqual(redactIdentityTerms("Martin decides."), `${IDENTITY_PLACEHOLDERS.operator} decides.`);
});

test("redactIdentityTerms replaces multiple occurrences and multiple distinct terms in one pass", () => {
  const input = "Martin runs ENIG. ENIG is Martin's business.";
  const result = redactIdentityTerms(input);
  assert.strictEqual(result, `${IDENTITY_PLACEHOLDERS.operator} runs ${IDENTITY_PLACEHOLDERS.consultancy}. ${IDENTITY_PLACEHOLDERS.consultancy} is ${IDENTITY_PLACEHOLDERS.operator}'s business.`);
});

test("redactIdentityTerms does not corrupt unrelated identifiers sharing the same letters glued by word characters", () => {
  // "_" is a word character, so \bENIG\b does not match inside this token.
  assert.strictEqual(redactIdentityTerms("enig_hq_ops_bot"), "enig_hq_ops_bot");
});

test("findLeftoverBannedTerms returns [] for already-redacted text", () => {
  assert.deepStrictEqual(findLeftoverBannedTerms(`${IDENTITY_PLACEHOLDERS.consultancy} and ${IDENTITY_PLACEHOLDERS.operator} discussed pricing.`), []);
});

test("findLeftoverBannedTerms detects a term redaction missed, case-insensitively", () => {
  assert.deepStrictEqual(findLeftoverBannedTerms("A leftover mention of ENIG here."), ["ENIG"]);
  assert.deepStrictEqual(findLeftoverBannedTerms("martin forgot to redact this."), ["Martin"]);
});

test("findLeftoverBannedTerms reports every distinct banned term present, not just the first", () => {
  const found = findLeftoverBannedTerms("Martin works at ENIG.");
  assert.strictEqual(found.length, 2);
  assert.ok(found.includes("ENIG"));
  assert.ok(found.includes("Martin"));
});

test("findLeftoverBannedTerms is stateless across repeated calls (no regex lastIndex leakage)", () => {
  // A `g`-flagged RegExp is stateful; calling .test() on the same instance
  // twice can silently skip a match if lastIndex isn't reset. This is the
  // exact bug class the fail-closed verification gate must never have.
  assert.deepStrictEqual(findLeftoverBannedTerms("ENIG appears here."), ["ENIG"]);
  assert.deepStrictEqual(findLeftoverBannedTerms("ENIG appears here too."), ["ENIG"]);
});
