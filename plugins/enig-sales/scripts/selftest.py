#!/usr/bin/env python3
"""selftest.py — package checks for enig-sales. Read-only. Run before every release.

1. Structure: manifest, README, CONNECTORS, the eight skills, shared references.
2. Copy parity: every skills/*/scripts and skills/*/references file matches the
   root copy byte for byte (Claude chat drops plugin-root files, so each skill
   carries its own copies; the root copies are the source of truth).
3. Skills name only scripts and references that exist, and never the prohibited
   `notion-query-data-sources` as a tool to load.
4. Script behaviour: validate_token, scan_identity_leakage (governed and
   --client-facing), call_notes_attestation (build/verify/refusals),
   handoff_attestation (source-boundary, cve, sources, verify).

Byte-for-byte agreement with the ENIG Runtime's own readers is checked in the
Runtime repository (src/isolatedSalesPluginConformance.test.ts).
Exit 0 = all checks pass, 1 = a check failed.
"""
import filecmp
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS = ["sales-enquiry", "sales-correspondence", "sales-call-prep", "sales-call-evidence",
          "sales-fit-assessment", "sales-progression", "sales-proposal-release", "sales-agreement"]
SCRIPTS = ["validate_token.py", "scan_identity_leakage.py", "call_notes_attestation.py", "handoff_attestation.py", "plugin_check.py"]
REFERENCES = ["notion-calls.md", "evidence-examples.md", "checks.md"]
fails = 0


def check(ok, label):
    global fails
    print(("PASS " if ok else "FAIL ") + label)
    fails += 0 if ok else 1


def run(script, *args, stdin=None):
    r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", script), *args], input=stdin, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def tmp(content):
    f = tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding="utf-8")
    f.write(content)
    f.close()
    return f.name


# 1. Structure
manifest = json.load(open(os.path.join(ROOT, ".claude-plugin", "plugin.json")))
check(manifest.get("name") == "enig-sales" and re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", "")), "manifest name and version")
check(isinstance(manifest.get("description"), str) and 0 < len(manifest["description"]) <= 500, f"manifest description at most 500 characters ({len(manifest.get('description', ''))})")
for f in ["README.md", "CONNECTORS.md", ".mcp.json"]:
    check(os.path.exists(os.path.join(ROOT, f)), f"{f} present")
check(json.load(open(os.path.join(ROOT, ".mcp.json"))) == {"mcpServers": {}}, ".mcp.json holds no servers or credentials")
for s in SKILLS:
    check(os.path.exists(os.path.join(ROOT, "skills", s, "SKILL.md")), f"{s}/SKILL.md present")
check(sorted(os.listdir(os.path.join(ROOT, "skills"))) == sorted(SKILLS), "exactly the eight skills")

# 2. Copy parity
for s in SKILLS:
    for sub, names in (("scripts", SCRIPTS), ("references", REFERENCES)):
        for n in names:
            root_copy = os.path.join(ROOT, sub, n)
            copy = os.path.join(ROOT, "skills", s, sub, n)
            check(os.path.exists(copy) and filecmp.cmp(root_copy, copy, shallow=False), f"{s}/{sub}/{n} matches root")

# 3. Skills reference only what exists
for s in SKILLS:
    text = open(os.path.join(ROOT, "skills", s, "SKILL.md"), encoding="utf-8").read()
    named = set(re.findall(r"([a-z_]+\.py)", text))
    check(named <= set(SCRIPTS), f"{s} names only shipped scripts ({', '.join(sorted(named - set(SCRIPTS))) or 'ok'})")
    refs = set(re.findall(r"references/([a-z-]+\.md)", text)) | set(re.findall(r"`([a-z-]+-[a-z]+\.md)`", text)) & set(REFERENCES)
    check(refs <= set(REFERENCES), f"{s} names only shipped references")
    check("select:" not in text or "notion-query-data-sources" not in text.split("select:")[1].split("`")[0], f"{s} never loads notion-query-data-sources")
    check(text.startswith("---\nname: " + s + "\n"), f"{s} frontmatter name matches folder")
    m = re.search(r'^description: (.*)$', text, re.M)
    desc = json.loads(m.group(1)) if m and m.group(1).startswith('"') else (m.group(1) if m else "")
    check(0 < len(desc) <= 500, f"{s} description at most 500 characters ({len(desc)})")

# 3b. The in-chat check reports the manifest's version
pc = open(os.path.join(ROOT, "scripts", "plugin_check.py"), encoding="utf-8").read()
check(f'VERSION = "{manifest["version"]}"' in pc, "plugin_check.py VERSION matches the manifest")

# 4. Script behaviour
check(run("validate_token.py", "matter", "MAT-12")[0] == 0, "validate_token: MAT-12 valid")
check(run("validate_token.py", "entity", "E-ENT-3")[0] == 1, "validate_token: E-ENT-3 rejected")
check(run("scan_identity_leakage.py", "-", "--identity", "Ama Mensah", stdin="Met Ama Mensah today")[0] == 1, "scan: identity string hard-fails")
check(run("scan_identity_leakage.py", "-", stdin="(CS, Managing Director) Two accounts left.")[0] == 0, "scan: role-only text passes")
check(run("scan_identity_leakage.py", "-", "--client-facing", stdin="Dear Ama, see MAT-12")[0] == 1, "scan --client-facing: internal token fails")
check(run("scan_identity_leakage.py", "-", "--client-facing", stdin="Dear Ama, thank you")[0] == 0, "scan --client-facing: client name passes")

rec = ["--record", "CN-7cdf89bd-4da6-4a56-bc2a-e6be7e124734", "--entity", "ENT-27", "--matter", "MAT-30", "--call-date", "2026-10-19", "--call-type", "Follow-up", "--version", "1"]
code, marker = run("call_notes_attestation.py", "build", *rec, "--approved-by-martin")
# Known-good vector: the Runtime's buildRecordApprovalMarker for this record.
check(code == 0 and marker.endswith("fields_hash=" + __import__("hashlib").sha256(
    '[["Call_Notes_ID","CN-7cdf89bd-4da6-4a56-bc2a-e6be7e124734"],["Entity","ENT-27"],["Matter","MAT-30"],["Call Date","2026-10-19"],["Call Type","Follow-up"],["Version","1"]]'.encode()).hexdigest() + "]"),
    "call_notes build: six-field marker with the canonical hash")
check(run("call_notes_attestation.py", "build", *rec)[0] == 1, "call_notes build: refuses without --approved-by-martin")
check(run("call_notes_attestation.py", "verify", "--marker", marker, *rec)[0] == 0, "call_notes verify: read-back match passes")
bad = [v if v != "Follow-up" else "Sales" for v in rec]
check(run("call_notes_attestation.py", "verify", "--marker", marker, *bad)[0] == 1, "call_notes verify: changed Call Type fails")
check(run("call_notes_attestation.py", "new-id")[1].startswith("CN-"), "call_notes new-id: CN-<uuid>")

code, out = run("handoff_attestation.py", "source-boundary", "--text-file", tmp("Sales→Strategy · ENT-27 / MAT-30. Evidence: see Sources."), "--entity", "ENT-27", "--matter", "MAT-30", "--contact-name", "Ama Mensah")
check(code == 0 and "[source_boundary_check result=Passed entity=ENT-27 matter=MAT-30 checks=" in out and "fields=contactName]" in out, "handoff source-boundary: clean text gets the marker")
check(run("handoff_attestation.py", "source-boundary", "--text-file", tmp("Ama Mensah asked for RES-004."), "--entity", "ENT-27", "--matter", "MAT-30", "--contact-name", "Ama Mensah")[0] == 1, "handoff source-boundary: identity or Registry data blocks the marker")
cve = tmp(json.dumps({"determination": "Insufficient Evidence", "evidenceText": "No numerical value stated.", "evidence": None}))
code, block = run("handoff_attestation.py", "cve", "--json-file", cve)
check(code == 0 and block.splitlines()[0] == "=== COMMERCIAL VALUE EVIDENCE ===", "handoff cve: block built")
check(run("handoff_attestation.py", "cve", "--json-file", tmp('{"determination": "Maybe", "evidenceText": "x"}'))[0] == 1, "handoff cve: unknown determination refused")
code, src = run("handoff_attestation.py", "sources", "--entity", "ENT-27", "--matter", "MAT-30", "--call-notes", "https://app.notion.com/p/3fbcb004e58381c4bba9db48331fded3")
check(code == 0 and src == "token:entity:ENT-27\ntoken:matter:MAT-30\nhttps://www.notion.so/3fbcb004e58381c4bba9db48331fded3", "handoff sources: token entries + one notion.so link")
mk = out.splitlines()[-1]
verify = ["verify", "--entity", "ENT-27", "--matter", "MAT-30", "--reason-file", tmp("Approved. " + mk), "--sources-file", tmp(src), "--call-notes", "3fbcb004e58381c4bba9db48331fded3"]
check(run("handoff_attestation.py", *verify, "--vfs-file", tmp("Evidence: see Sources.\n" + block))[0] == 0, "handoff verify: full read-back passes")
check(run("handoff_attestation.py", *verify, "--vfs-file", tmp("Evidence: see Sources."))[0] == 1, "handoff verify: missing CVE compatibility copy fails")

print(f"\n{'ALL PASS' if fails == 0 else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
