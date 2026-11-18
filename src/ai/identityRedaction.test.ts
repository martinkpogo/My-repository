import test from "node:test";
import assert from "node:assert";
import { redactIdentityTerms, restoreIdentityPlaceholders, findLeftoverBannedTerms, IDENTITY_PLACEHOLDERS } from "./identityRedaction";

test("redactIdentityTerms replaces ENIG with the consultancy placeholder, case-insensitively", () => {
  assert.strictEqual(redactIdentityTerms("ENIG is a consultancy."), "[ENIG_CONSULTANCY] is a consultancy.");
  assert.strictEqual(redactIdentityTerms("Welcome to enig."), "Welcome to [ENIG_CONSULTANCY].");
});

test("redactIdentityTerms handles possessive forms correctly by leaving the 's attached", () => {
  assert.strictEqual(redactIdentityTerms("ENIG's marketing plan"), "[ENIG_CONSULTANCY]'s marketing plan");
  assert.strictEqual(redactIdentityTerms("Martin's call to make"), "[ENIG_OPERATOR]'s call to make");
});

test("redactIdentityTerms replaces Martin with the operator placeholder", () => {
  assert.strictEqual(redactIdentityTerms("Martin decides."), "[ENIG_OPERATOR] decides.");
});

test("redactIdentityTerms replaces multiple occurrences and multiple distinct terms in one pass", () => {
  const input = "Martin runs ENIG. ENIG is Martin's business.";
  const result = redactIdentityTerms(input);
  assert.strictEqual(
    result,
    "[ENIG_OPERATOR] runs [ENIG_CONSULTANCY]. [ENIG_CONSULTANCY] is [ENIG_OPERATOR]'s business.",
  );
});

test("redactIdentityTerms does not corrupt unrelated identifiers sharing the same letters glued by word characters", () => {
  // "_" is a word character, so \bENIG\b does not match inside this token.
  assert.strictEqual(redactIdentityTerms("enig_hq_ops_bot"), "enig_hq_ops_bot");
});

test("redactIdentityTerms is idempotent over its own placeholders -- protecting twice never corrupts them", () => {
  const once = redactIdentityTerms("Martin should review ENIG's direction.");
  assert.strictEqual(redactIdentityTerms(once), once);
  assert.ok(once.includes(IDENTITY_PLACEHOLDERS.consultancy));
  assert.ok(once.includes(IDENTITY_PLACEHOLDERS.operator));
});

test("findLeftoverBannedTerms returns [] for already-protected text", () => {
  assert.deepStrictEqual(
    findLeftoverBannedTerms("[ENIG_CONSULTANCY] and [ENIG_OPERATOR] discussed pricing."),
    [],
  );
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

test("restoreIdentityPlaceholders restores both names for final internal output", () => {
  assert.strictEqual(
    restoreIdentityPlaceholders("[ENIG_OPERATOR] should review [ENIG_CONSULTANCY]'s proposed direction."),
    "Martin should review ENIG's proposed direction.",
  );
});

test("restoreIdentityPlaceholders handles multiple occurrences and repeated calls (idempotent)", () => {
  const restored = restoreIdentityPlaceholders("[ENIG_OPERATOR] runs [ENIG_CONSULTANCY]; [ENIG_CONSULTANCY] is his.");
  assert.strictEqual(restored, "Martin runs ENIG; ENIG is his.");
  assert.strictEqual(restoreIdentityPlaceholders(restored), restored);
});

test("restoreIdentityPlaceholders leaves text with no placeholders byte-identical", () => {
  const text = "Martin should review ENIG's direction.";
  assert.strictEqual(restoreIdentityPlaceholders(text), text);
  assert.strictEqual(restoreIdentityPlaceholders(""), "");
});

test("restoreIdentityPlaceholders is case-insensitive over the token, so a lowercased placeholder still restores", () => {
  assert.strictEqual(restoreIdentityPlaceholders("[enig_operator] and [Enig_Consultancy]"), "Martin and ENIG");
});

test("restoreIdentityPlaceholders leaves unknown placeholders untouched -- never guessed at", () => {
  const text = "[ENIG_SOMETHING_ELSE] and [ENIG_OPERATOR]";
  assert.strictEqual(restoreIdentityPlaceholders(text), "[ENIG_SOMETHING_ELSE] and Martin");
});

test("restoreIdentityPlaceholders leaves malformed or partial placeholders untouched -- no partial rewrite", () => {
  assert.strictEqual(restoreIdentityPlaceholders("[ENIG_OPERATOR"), "[ENIG_OPERATOR");
  assert.strictEqual(restoreIdentityPlaceholders("ENIG_OPERATOR]"), "ENIG_OPERATOR]");
  assert.strictEqual(restoreIdentityPlaceholders("[ENIG-OPERATOR]"), "[ENIG-OPERATOR]");
});

test("restoreIdentityPlaceholders rewrites only the well-formed token, leaving stray surrounding punctuation alone", () => {
  assert.strictEqual(restoreIdentityPlaceholders("[ENIG_OPERATOR]]"), "Martin]");
});

test("restoreIdentityPlaceholders handles partially restored text by restoring only the surviving token", () => {
  assert.strictEqual(
    restoreIdentityPlaceholders("Martin should review [ENIG_CONSULTANCY]'s proposed direction."),
    "Martin should review ENIG's proposed direction.",
  );
});

test("restoreIdentityPlaceholders does not touch words that merely contain the names", () => {
  assert.strictEqual(
    restoreIdentityPlaceholders("Martina and ENIGMATIC are unrelated words."),
    "Martina and ENIGMATIC are unrelated words.",
  );
});

test("protect -> restore round-trips the real names exactly", () => {
  const original = "Martin should review ENIG's proposed direction.";
  assert.strictEqual(restoreIdentityPlaceholders(redactIdentityTerms(original)), original);
});

test("restored content is protected again before it can be sent out (the executor's own function)", () => {
  const restored = restoreIdentityPlaceholders("[ENIG_OPERATOR] should review [ENIG_CONSULTANCY]'s direction.");
  const reprotected = redactIdentityTerms(restored);
  assert.ok(!reprotected.includes("Martin"));
  assert.ok(!reprotected.includes("ENIG's"));
  assert.deepStrictEqual(findLeftoverBannedTerms(reprotected), []);
});
