import test from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecordApprovalMarker, parseRecordApprovalMarker, type CallNotesApprovalRecord } from "./records/callNotes/callNotesMarker";
import { buildSourceBoundaryMarker, parseSourceBoundaryMarker } from "./handoffWriter";
import { parseCommercialValueEvidenceBlock, serializeCommercialValueEvidenceBlock } from "./handoffContracts/commercialValueEvidence";
import { extractHandoffSources } from "./handoffSources";

/**
 * The Isolated Sales plugin (plugins/enig-sales) writes, OUTSIDE this Worker,
 * the three things the Runtime later verifies byte-for-byte: the Call Notes
 * `record_approval` marker, the Handoff `source_boundary_check` marker, the
 * Commercial Value Evidence block, and the post-LOG-1149 `Sources` entries.
 *
 * These tests run the plugin's own Python scripts and feed their output to the
 * Runtime's own readers -- so a drift on either side turns PR Validation red
 * instead of surfacing as a refused Handoff in production. Each test also
 * checks the reverse direction where a Runtime builder exists.
 */

const SCRIPTS = join(__dirname, "..", "plugins", "enig-sales", "scripts");

function py(script: string, args: string[], input?: string): { code: number; out: string } {
  try {
    const out = execFileSync("python3", [join(SCRIPTS, script), ...args], { input, encoding: "utf8" });
    return { code: 0, out: out.trim() };
  } catch (err: any) {
    return { code: err.status ?? -1, out: String(err.stdout ?? "").trim() };
  }
}

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "enig-sales-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

const RECORD: CallNotesApprovalRecord = {
  callNotesId: "CN-7cdf89bd-4da6-4a56-bc2a-e6be7e124734",
  entity: "ENT-27",
  matter: "MAT-30",
  callDate: "2026-10-19",
  callType: "Follow-up",
  version: 1,
};

function recordArgs(r: CallNotesApprovalRecord): string[] {
  return ["--record", r.callNotesId, "--entity", r.entity, "--matter", r.matter, "--call-date", r.callDate, "--call-type", r.callType, "--version", String(r.version)];
}

test("Call Notes: the plugin's marker is byte-identical to the Runtime's and passes the Runtime reader", async () => {
  const built = py("call_notes_attestation.py", ["build", ...recordArgs(RECORD), "--approved-by-martin"]);
  assert.strictEqual(built.code, 0, built.out);
  assert.strictEqual(built.out, await buildRecordApprovalMarker(RECORD, "Approved"));
  const parsed = await parseRecordApprovalMarker(built.out, RECORD);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
});

test("Call Notes: the plugin refuses to build without Martin's approval flag", () => {
  assert.strictEqual(py("call_notes_attestation.py", ["build", ...recordArgs(RECORD)]).code, 1);
});

test("Call Notes: the plugin's verify agrees with the Runtime reader on a good and a tampered record", async () => {
  const marker = await buildRecordApprovalMarker(RECORD, "Approved");
  assert.strictEqual(py("call_notes_attestation.py", ["verify", "--marker", marker, ...recordArgs(RECORD)]).code, 0);
  const tampered = { ...RECORD, callDate: "2026-10-20" };
  assert.strictEqual(py("call_notes_attestation.py", ["verify", "--marker", marker, ...recordArgs(tampered)]).code, 1);
  assert.strictEqual((await parseRecordApprovalMarker(marker, tampered)).ok, false);
});

test("Call Notes: the plugin refuses a Notion page id in place of the ENT-n token", () => {
  const args = recordArgs({ ...RECORD, entity: "3cecb004e58381a9b95ee6ab79a3e5f3" });
  assert.strictEqual(py("call_notes_attestation.py", ["build", ...args, "--approved-by-martin"]).code, 1);
});

test("Handoff: the plugin's source_boundary_check marker matches the Runtime's and passes the Runtime reader", () => {
  const text = tmpFile("handoff.txt", "Sales→Strategy · ENT-27 / MAT-30\nMartin approved progression on 2026-11-09; diagnosis and intervention design are required\nEvidence: see Sources (CN-7cdf89bd).");
  const built = py("handoff_attestation.py", ["source-boundary", "--text-file", text, "--entity", "ENT-27", "--matter", "MAT-30", "--contact-name", "Ama Mensah", "--email", "ama@example.com"]);
  assert.strictEqual(built.code, 0, built.out);
  const marker = built.out.split("\n").filter((l) => l.startsWith("[source_boundary_check"))[0];
  assert.strictEqual(marker, buildSourceBoundaryMarker({ entityToken: "ENT-27", matterToken: "MAT-30" }, "Passed", ["contactName", "email"]));
  const parsed = parseSourceBoundaryMarker(`Martin approved progression. ${marker}`, { handoffId: "HO-1", entityToken: "ENT-27", matterToken: "MAT-30" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
});

test("Handoff: the plugin builds no marker when identity is still in the text", () => {
  const text = tmpFile("handoff.txt", "Ama Mensah (ama@example.com) wants a rebrand.");
  const built = py("handoff_attestation.py", ["source-boundary", "--text-file", text, "--entity", "ENT-27", "--matter", "MAT-30", "--contact-name", "Ama Mensah"]);
  assert.strictEqual(built.code, 1);
  assert.doesNotMatch(built.out, /\[source_boundary_check/);
});

test("Commercial Value Evidence: the plugin's block is byte-identical to the Runtime's and parses", () => {
  const record = {
    determination: "Satisfied" as const,
    evidenceText: "Client (Managing Director) stated two lost accounts were roughly 30% of revenue over the last year.",
    evidence: {
      financialConsequence: "Revenue lost with two retail accounts",
      valueAtStake: { value: 30, currency: "GHS", period: "last 12 months", evidenceType: "client_estimated" as const, source: "Call Notes CN-7cdf89bd", limitations: "roughly; base not stated" },
      uncertainty: "absolute figures not stated",
    },
  };
  const built = py("handoff_attestation.py", ["cve", "--json-file", tmpFile("cve.json", JSON.stringify(record))]);
  assert.strictEqual(built.code, 0, built.out);
  assert.strictEqual(built.out, serializeCommercialValueEvidenceBlock(record as any));
  const parsed = parseCommercialValueEvidenceBlock(`Evidence: see Sources.\n${built.out}`);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
});

test("Commercial Value Evidence: the plugin refuses what the Runtime would refuse", () => {
  const bad = { determination: "Probably", evidenceText: "", evidence: { valueAtStake: { value: "lots" } } };
  assert.strictEqual(py("handoff_attestation.py", ["cve", "--json-file", tmpFile("bad.json", JSON.stringify(bad))]).code, 1);
  assert.strictEqual(parseCommercialValueEvidenceBlock(`=== COMMERCIAL VALUE EVIDENCE ===\n${JSON.stringify(bad)}\n=== END COMMERCIAL VALUE EVIDENCE ===`).ok, false);
});

test("Sources: the plugin's entries are what the Runtime extracts (LOG-1149 token entries + one Call Notes link)", () => {
  const built = py("handoff_attestation.py", ["sources", "--entity", "ENT-27", "--matter", "MAT-30", "--call-notes", "https://app.notion.com/p/3fbcb004e58381c4bba9db48331fded3"]);
  assert.strictEqual(built.code, 0, built.out);
  assert.strictEqual(built.out, "token:entity:ENT-27\ntoken:matter:MAT-30\nhttps://www.notion.so/3fbcb004e58381c4bba9db48331fded3");
  const extracted = extractHandoffSources({ Sources: { rich_text: [{ plain_text: built.out, text: { content: built.out } }] } } as any);
  assert.ok(extracted.ok && extracted.mode === "sources", JSON.stringify(extracted));
  if (extracted.ok && extracted.mode === "sources") {
    assert.deepStrictEqual(extracted.tokens, { entityToken: "ENT-27", matterToken: "MAT-30" });
    assert.ok(extracted.refs.some((r) => r.kind === "notion" && r.pageId.replace(/-/g, "") === "3fbcb004e58381c4bba9db48331fded3"));
  }
});

test("Handoff verify: the plugin passes a correct read-back and fails a Handoff without the compatibility block", () => {
  const marker = buildSourceBoundaryMarker({ entityToken: "ENT-27", matterToken: "MAT-30" }, "Passed", ["contactName"]);
  const block = serializeCommercialValueEvidenceBlock({ determination: "Insufficient Evidence", evidenceText: "No numerical value stated.", evidence: null });
  const sources = "token:entity:ENT-27\ntoken:matter:MAT-30\nhttps://www.notion.so/3fbcb004e58381c4bba9db48331fded3";
  const args = ["verify", "--entity", "ENT-27", "--matter", "MAT-30", "--reason-file", tmpFile("r.txt", `Approved. ${marker}`), "--sources-file", tmpFile("s.txt", sources), "--call-notes", "3fbcb004e58381c4bba9db48331fded3"];
  assert.strictEqual(py("handoff_attestation.py", [...args, "--vfs-file", tmpFile("v.txt", `Evidence: see Sources.\n${block}`)]).code, 0);
  assert.strictEqual(py("handoff_attestation.py", [...args, "--vfs-file", tmpFile("v2.txt", "Evidence: see Sources.")]).code, 1);
});
