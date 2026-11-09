#!/usr/bin/env python3
"""
handoff_attestation.py — the Sales → Strategy Handoff's machine-checked parts,
exactly as the ENIG Runtime reads them:

  * the `source_boundary_check` marker in `Reason`   (src/handoffWriter.ts)
  * the Commercial Value Evidence block             (src/handoffContracts/commercialValueEvidence.ts)
  * the `Sources` entries                           (src/handoffSources.ts, after LOG-1149)

Read-only: computes and checks text. Never calls Notion. A PASS is never proof
of Martin's approval.

Commands
  source-boundary --text-file draft.txt --entity ENT-n --matter MAT-n
                  [--entity-name …] [--contact-name …] [--email …] [--phone …]
                  [--identity "string" …]
      Runs the five source-boundary checks over every Handoff text field EXCEPT
      Sources (put them all in draft.txt) and, only if all pass, prints the
      identity-form marker:
        [source_boundary_check result=Passed entity=ENT-n matter=MAT-n checks=<5> fields=<names>]
      `fields=` records which known-identity FIELDS were compared — names only,
      never values. Never builds a Failed marker.

  cve --json-file evidence.json
      Validates a Commercial Value Evidence record against the Runtime parser
      and prints the block (compact JSON between the two marker lines).
      evidence.json: {"determination": "...", "evidenceText": "...", "evidence": {...} | null}

  sources --entity ENT-n --matter MAT-n [--call-notes <page URL or 32-hex id>]
      Prints the Sources text: one entry per line.
        token:entity:ENT-n
        token:matter:MAT-n
        https://www.notion.so/<32-hex id>   (only with --call-notes)

  verify --entity ENT-n --matter MAT-n --reason-file … --vfs-file … --sources-file …
         [--call-notes <id>]
      Re-checks Reason, Verified Facts & Sources and Sources as READ BACK from
      the created Handoff.

Exit codes: 0 PASS, 1 FAIL, 2 usage.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan_identity_leakage import scan  # noqa: E402  (same folder, read-only)

CHECKS = [
    "operational_entity_reference_present",
    "operational_matter_reference_present",
    "identity_bearing_content_removed",
    "identity_resolution_registry_data_not_transferred",
    "handoff_context_identity_safe",
]
KNOWN_FIELDS = ["entityName", "matterName", "contactName", "email", "phone"]
MARKER_RE = re.compile(r"\[source_boundary_check ([^\]]*)\]")
FIELD_RE = re.compile(r"(\w+)=([^\s\]]*)")
ENT = re.compile(r"^ENT-\d+$")
MAT = re.compile(r"^MAT-\d+$")
REGISTRY_RE = re.compile(r"\bRES-\d{3}\b|\b(?:Real_Name|Contact_Name|Resolution_ID|Resolution_Status|Additional_Contact_Channel)\b")
CVE_START = "=== COMMERCIAL VALUE EVIDENCE ==="
CVE_END = "=== END COMMERCIAL VALUE EVIDENCE ==="
DETERMINATIONS = ["Satisfied", "Not Satisfied", "Insufficient Evidence"]
EVIDENCE_TYPES = ["directly_measured", "client_estimated", "derived", "assumption"]
FIG_NUM = ["value", "low", "high"]
FIG_STR = ["currency", "period", "source", "evidenceQuality", "assumptions", "limitations"]
FIG_ORDER = ["value", "low", "high", "currency", "period", "evidenceType", "source", "evidenceQuality", "assumptions", "limitations"]
EV_STR = ["financialConsequence", "affectedRevenueOrOpportunity", "desiredMeasurableOutcome", "uncertainty"]
EV_ORDER = ["financialConsequence", "valueAtStake", "costOfInaction", "affectedRevenueOrOpportunity", "desiredMeasurableOutcome", "uncertainty"]
NOTION_ID = re.compile(r"([0-9a-fA-F]{32})|([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")


def read(path):
    return sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()


# ---- source-boundary ---------------------------------------------------------

def cmd_source_boundary(a):
    problems = []
    if not ENT.match(a.entity.strip()):
        problems.append("operational_entity_reference_present: --entity is not ENT-n")
    if not MAT.match(a.matter.strip()):
        problems.append("operational_matter_reference_present: --matter is not MAT-n")
    text = read(a.text_file)
    if not text.strip():
        print("USAGE ERROR: the Handoff text is empty — nothing was checked.")
        return 2
    named = {"entityName": a.entity_name, "contactName": a.contact_name, "email": a.email, "phone": a.phone}
    identity = [v for v in named.values() if v] + list(a.identity or [])
    hard, warnings = scan(text, identity)
    if hard:
        problems.append("identity_bearing_content_removed: " + "; ".join(hard))
    if REGISTRY_RE.search(text):
        problems.append("identity_resolution_registry_data_not_transferred: Registry identifiers or field names appear in the Handoff text")
    if re.search(r"app\.notion\.com/p/[A-Za-z]", text):
        problems.append("handoff_context_identity_safe: a page link with a readable slug appears; use https://www.notion.so/<id> in Sources only")
    for w in warnings:
        print(f"WARN — re-read by hand: {w}")
    if problems:
        print("FAIL — no marker built:")
        for p in problems:
            print(f"  - {p}")
        return 1
    fields = ",".join(k for k in KNOWN_FIELDS if named.get(k))
    print(f"[source_boundary_check result=Passed entity={a.entity.strip()} matter={a.matter.strip()} checks={','.join(CHECKS)} fields={fields}]")
    return 0


def parse_marker(reason, entity, matter):
    m = MARKER_RE.search(reason or "")
    if not m:
        return "no source_boundary_check marker in Reason"
    f = dict(FIELD_RE.findall(m.group(1)))
    if f.get("result") != "Passed":
        return f"marker result is {f.get('result') or 'missing'}, not Passed"
    if f.get("entity") != entity or f.get("matter") != matter:
        return "marker is not bound to this Handoff's ENT-n / MAT-n"
    missing = [c for c in CHECKS if c not in (f.get("checks") or "").split(",")]
    if missing:
        return f"marker does not evidence: {', '.join(missing)}"
    unknown = [x for x in (f.get("fields") or "").split(",") if x and x not in KNOWN_FIELDS]
    if unknown:
        return f"marker names unknown identity fields: {', '.join(unknown)}"
    return None


# ---- Commercial Value Evidence ----------------------------------------------

def check_figure(raw, path, problems):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        problems.append(f"{path} is not an object")
        return None
    for k in raw:
        if k not in FIG_ORDER:
            problems.append(f"{path}.{k} is not a known value-at-stake field")
    out = {}
    for k in FIG_NUM:
        v = raw.get(k)
        if v is None:
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            problems.append(f"{path}.{k} is not a finite number")
        else:
            out[k] = v
    for k in FIG_STR:
        v = raw.get(k)
        if v is None:
            continue
        if not isinstance(v, str):
            problems.append(f"{path}.{k} is not a string")
        else:
            out[k] = v
    et = raw.get("evidenceType")
    if et is not None:
        if et not in EVIDENCE_TYPES:
            problems.append(f"{path}.evidenceType is not one of {', '.join(EVIDENCE_TYPES)}")
        else:
            out["evidenceType"] = et
    return {k: out[k] for k in FIG_ORDER if k in out}


def check_cve(payload):
    problems = []
    if not isinstance(payload, dict):
        return None, ["the record is not a JSON object"]
    for k in payload:
        if k not in ("determination", "evidenceText", "evidence"):
            problems.append(f"{k} is not a known Commercial Value Evidence field")
    if payload.get("determination") not in DETERMINATIONS:
        problems.append(f"determination must be one of {', '.join(DETERMINATIONS)}")
    et = payload.get("evidenceText")
    if not isinstance(et, str) or not et.strip():
        problems.append("evidenceText is not a non-empty string")
    ev = payload.get("evidence")
    evidence = None
    if ev is not None:
        if not isinstance(ev, dict):
            problems.append("evidence is not an object")
        else:
            for k in ev:
                if k not in EV_ORDER:
                    problems.append(f"evidence.{k} is not a known commercial-evidence field")
            evidence = {}
            for k in EV_STR:
                v = ev.get(k)
                if v is None:
                    continue
                if not isinstance(v, str):
                    problems.append(f"evidence.{k} is not a string")
                else:
                    evidence[k] = v
            for k in ("valueAtStake", "costOfInaction"):
                fig = check_figure(ev.get(k), f"evidence.{k}", problems)
                if fig is not None:
                    evidence[k] = fig
            evidence = {k: evidence[k] for k in EV_ORDER if k in evidence}
    record = {"determination": payload.get("determination"), "evidenceText": et, "evidence": evidence}
    return record, problems


def cve_block(record):
    return f"{CVE_START}\n{json.dumps(record, separators=(',', ':'), ensure_ascii=False)}\n{CVE_END}"


def extract_cve(text):
    s = text.find(CVE_START)
    if s == -1:
        return None
    e = text.find(CVE_END, s + len(CVE_START))
    if e == -1:
        return None
    return text[s + len(CVE_START):e].strip()


def cmd_cve(a):
    try:
        payload = json.loads(read(a.json_file))
    except (OSError, ValueError) as err:
        print(f"FAIL: cannot read the evidence JSON: {err}")
        return 1
    record, problems = check_cve(payload)
    if problems:
        print("FAIL — the Runtime would refuse this block:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(cve_block(record))
    return 0


# ---- Sources -----------------------------------------------------------------

def notion_id(value):
    m = NOTION_ID.search(value or "")
    if not m:
        return None
    return (m.group(1) or m.group(2)).replace("-", "").lower()


def sources_text(entity, matter, call_notes):
    lines = [f"token:entity:{entity}", f"token:matter:{matter}"]
    if call_notes:
        lines.append(f"https://www.notion.so/{notion_id(call_notes)}")
    return "\n".join(lines)


def cmd_sources(a):
    if not ENT.match(a.entity) or not MAT.match(a.matter):
        print("FAIL: --entity must be ENT-n and --matter MAT-n")
        return 1
    if a.call_notes and not notion_id(a.call_notes):
        print("FAIL: --call-notes carries no Notion page id")
        return 1
    print(sources_text(a.entity, a.matter, a.call_notes))
    return 0


def check_sources(text, entity, matter, call_notes):
    lines = [l.strip() for l in (text or "").replace("\\:", ":").splitlines() if l.strip()]
    tokens = {"entity": [], "matter": []}
    links = []
    for line in lines:
        m = re.fullmatch(r"token:(entity|matter):([A-Z]{1,6}-\d{1,6})", line)
        if m:
            tokens[m.group(1)].append(m.group(2))
        elif re.match(r"https?://", line):
            links.append(line)
        else:
            return f"unusable Sources entry: {line[:80]!r}"
    if tokens["entity"] != [entity]:
        return f"Sources must carry exactly token:entity:{entity}"
    if tokens["matter"] != [matter]:
        return f"Sources must carry exactly token:matter:{matter}"
    if len(links) > 1:
        return "Sources carries more than one link; the Sales → Strategy route allows one Call Notes link"
    if call_notes:
        if not links or notion_id(links[0]) != notion_id(call_notes):
            return "Sources does not carry the referenced Call Notes page link"
    return None


def cmd_verify(a):
    failures = []
    p = parse_marker(read(a.reason_file), a.entity, a.matter)
    if p:
        failures.append(f"Reason: {p}")
    inner = extract_cve(read(a.vfs_file))
    if inner is None:
        failures.append("Verified Facts & Sources: no Commercial Value Evidence block (Strategy holds the Handoff without it)")
    else:
        try:
            _, problems = check_cve(json.loads(inner))
            if problems:
                failures.append("Verified Facts & Sources: " + "; ".join(problems))
        except ValueError:
            failures.append("Verified Facts & Sources: the block is not valid JSON")
    s = check_sources(read(a.sources_file), a.entity, a.matter, a.call_notes)
    if s:
        failures.append(f"Sources: {s}")
    if failures:
        print("FAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: Reason marker, Commercial Value Evidence block and Sources match what the Runtime reads")
    return 0


def main(argv):
    p = argparse.ArgumentParser(prog="handoff_attestation.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")
    sb = sub.add_parser("source-boundary")
    sb.add_argument("--text-file", required=True)
    sb.add_argument("--entity", required=True)
    sb.add_argument("--matter", required=True)
    for opt in ("--entity-name", "--contact-name", "--email", "--phone"):
        sb.add_argument(opt)
    sb.add_argument("--identity", nargs="*")
    cv = sub.add_parser("cve")
    cv.add_argument("--json-file", required=True)
    so = sub.add_parser("sources")
    so.add_argument("--entity", required=True)
    so.add_argument("--matter", required=True)
    so.add_argument("--call-notes")
    ve = sub.add_parser("verify")
    for opt in ("--entity", "--matter", "--reason-file", "--vfs-file", "--sources-file"):
        ve.add_argument(opt, required=True)
    ve.add_argument("--call-notes")
    try:
        a = p.parse_args(argv)
    except SystemExit:
        return 2
    handlers = {"source-boundary": cmd_source_boundary, "cve": cmd_cve, "sources": cmd_sources, "verify": cmd_verify}
    if a.cmd not in handlers:
        p.print_usage()
        return 2
    return handlers[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
