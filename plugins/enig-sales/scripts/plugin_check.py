#!/usr/bin/env python3
"""plugin_check.py — enig-sales health check that runs INSIDE a Claude chat.

Claude chat mounts each plugin skill as its own folder and drops the plugin's
root files (manifest, README, selftest.py), so this check ships in every
skill's scripts/ folder and needs nothing outside it. Read-only.

It reports the plugin version, checks this skill's own scripts and
references, runs the scripts' behaviour checks, and — when the other skill
folders are mounted beside this one — confirms every copy is byte-identical.

Usage (from any skill folder):  python3 <SKILL>/scripts/plugin_check.py
Exit 0 = all checks pass, 1 = a check failed.
"""
import hashlib, os, subprocess, sys, tempfile

PLUGIN = "enig-sales"
VERSION = "3.3.0"
SKILLS = ["sales-enquiry", "sales-correspondence", "sales-call-prep", "sales-call-evidence",
          "sales-fit-assessment", "sales-progression", "sales-proposal-release", "sales-agreement"]
SCRIPTS = ["validate_token.py", "scan_identity_leakage.py", "call_notes_attestation.py", "handoff_attestation.py", "plugin_check.py"]
REFERENCES = ["notion-calls.md", "evidence-examples.md", "checks.md"]

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
fails = 0


def check(ok, label):
    global fails
    print(("PASS " if ok else "FAIL ") + label)
    fails += 0 if ok else 1


def run(script, *args, stdin=None):
    r = subprocess.run([sys.executable, os.path.join(HERE, script), *args], input=stdin, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


print(f"{PLUGIN} {VERSION} — checking from skill folder {os.path.basename(SKILL_DIR)}")

# 1. This skill's own files
for f in SCRIPTS:
    check(os.path.exists(os.path.join(HERE, f)), f"scripts/{f} present")
for f in REFERENCES:
    check(os.path.exists(os.path.join(SKILL_DIR, "references", f)), f"references/{f} present")
check(os.path.exists(os.path.join(SKILL_DIR, "SKILL.md")), "SKILL.md present")

# 2. Script behaviour
check(run("validate_token.py", "matter", "MAT-12")[0] == 0, "validate_token: MAT-12 valid")
check(run("validate_token.py", "entity", "E-ENT-3")[0] == 1, "validate_token: E-ENT-3 rejected")
check(run("scan_identity_leakage.py", "-", "--identity", "Ama Mensah", stdin="Met Ama Mensah today")[0] == 1, "scan: identity string hard-fails")
check(run("scan_identity_leakage.py", "-", "--client-facing", stdin="Dear Ama, see MAT-12")[0] == 1, "scan --client-facing: internal token fails")
rec = ["--record", "CN-7cdf89bd-4da6-4a56-bc2a-e6be7e124734", "--entity", "ENT-27", "--matter", "MAT-30",
       "--call-date", "2026-10-19", "--call-type", "Follow-up", "--version", "1"]
code, marker = run("call_notes_attestation.py", "build", *rec, "--approved-by-martin")
expected = hashlib.sha256('[["Call_Notes_ID","CN-7cdf89bd-4da6-4a56-bc2a-e6be7e124734"],["Entity","ENT-27"],["Matter","MAT-30"],["Call Date","2026-10-19"],["Call Type","Follow-up"],["Version","1"]]'.encode()).hexdigest()
check(code == 0 and marker.endswith(f"fields_hash={expected}]"), "call_notes build: six-field marker with the Runtime's canonical hash")
check(run("call_notes_attestation.py", "build", *rec)[0] == 1, "call_notes build: refuses without --approved-by-martin")
check(run("call_notes_attestation.py", "verify", "--marker", marker, *rec)[0] == 0, "call_notes verify: read-back match passes")
code, src = run("handoff_attestation.py", "sources", "--entity", "ENT-27", "--matter", "MAT-30", "--call-notes", "3fbcb004e58381c4bba9db48331fded3")
check(code == 0 and src.splitlines()[:2] == ["token:entity:ENT-27", "token:matter:MAT-30"], "handoff sources: LOG-1149 token entries")
with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt") as t:
    t.write("Sales→Strategy · ENT-27 / MAT-30. Evidence: see Sources.")
code, out = run("handoff_attestation.py", "source-boundary", "--text-file", t.name, "--entity", "ENT-27", "--matter", "MAT-30")
check(code == 0 and "[source_boundary_check result=Passed entity=ENT-27 matter=MAT-30" in out, "handoff source-boundary: marker built for clean text")

# 3. Copy parity across the mounted skill folders
# Claude may mount a skill as "<skill>" or with the plugin prefix, "enig-sales:<skill>".
parent = os.path.dirname(SKILL_DIR)
def folder_for(skill):
    for name in (skill, f"{PLUGIN}:{skill}"):
        if os.path.isdir(os.path.join(parent, name)):
            return os.path.join(parent, name)
    return None
found = {s: folder_for(s) for s in SKILLS}
mounted = [s for s in SKILLS if found[s]]
if len(mounted) > 1:
    print(f"INFO {len(mounted)} of {len(SKILLS)} skill folders mounted beside this one")
    for sub, names in (("scripts", SCRIPTS), ("references", REFERENCES)):
        for n in names:
            hashes = {s: sha(os.path.join(found[s], sub, n)) for s in mounted if os.path.exists(os.path.join(found[s], sub, n))}
            check(len(hashes) == len(mounted) and len(set(hashes.values())) == 1, f"{sub}/{n} identical in all mounted skills")
    check(len(mounted) == len(SKILLS), "all 8 skills mounted")
else:
    print("INFO other skill folders not visible from here; copy parity not checked")

print(f"\n{PLUGIN} {VERSION}: {'ALL PASS' if fails == 0 else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
