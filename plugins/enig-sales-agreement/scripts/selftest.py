#!/usr/bin/env python3
"""selftest.py — package checks for enig-sales-agreement. Read-only.

1. Every copy under skills/*/scripts and skills/*/references matches the root
   copy byte for byte (Claude chat drops plugin-root files, so each skill
   carries its own copies; the root copies are the source of truth).
2. check_client_text.py passes clean text and fails on each internal token.
3. validate_token.py accepts MAT-12 / ENT-3 and rejects E-ENT-3.
Exit 0 = all checks pass, 1 = a check failed.
"""
import filecmp, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = 0


def check(ok, label):
    global fails
    print(("PASS " if ok else "FAIL ") + label)
    fails += 0 if ok else 1


def run(script, *args, stdin=None):
    return subprocess.run([sys.executable, os.path.join(ROOT, "scripts", script), *args], input=stdin, capture_output=True, text=True).returncode


for skill in sorted(os.listdir(os.path.join(ROOT, "skills"))):
    sdir = os.path.join(ROOT, "skills", skill)
    for sub in ("scripts", "references"):
        rootdir = os.path.join(ROOT, sub)
        for fn in sorted(os.listdir(rootdir)):
            if fn == "selftest.py":
                continue
            copy = os.path.join(sdir, sub, fn)
            check(os.path.exists(copy) and filecmp.cmp(os.path.join(rootdir, fn), copy, shallow=False), f"{skill}/{sub}/{fn} matches root copy")

check(run("check_client_text.py", "-", stdin="Dear client, this agreement covers the proposal dated 2026-11-09.") == 0, "clean client text passes")
for tok in ["MAT-12", "ENT-3", "PROP-7", "HO-90", "CSA-1", "PAY-4", "LOG-1164", "RES-012", "CN-7cdf89bd-4da6"]:
    check(run("check_client_text.py", "-", stdin=f"Ref {tok} here") == 1, f"client text with {tok} fails")
check(run("validate_token.py", "matter", "MAT-12") == 0, "MAT-12 valid")
check(run("validate_token.py", "entity", "ENT-3") == 0, "ENT-3 valid")
check(run("validate_token.py", "entity", "E-ENT-3") == 1, "E-ENT-3 rejected")

print(f"\n{'ALL PASS' if fails == 0 else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
