#!/usr/bin/env python3
"""
call_notes_attestation.py — the Call Notes `record_approval` marker, exactly as
the ENIG Runtime reads it (src/records/callNotes/callNotesMarker.ts, Call Notes
contract `marker_contract`).

Read-only: computes and checks text. Never calls Notion. A PASS is never proof
of Martin's approval — the marker is procedural assurance, not a signature.

Commands
  new-id
      Print a fresh Call Notes ID: CN-<uuid4>.

  build --record CN-… --entity ENT-n --matter MAT-n --call-date YYYY-MM-DD
        --call-type <option> --version <int> --approved-by-martin
      Print the marker. Refuses without --approved-by-martin (ask Martin first;
      this flag records that you did, it does not create approval).

  verify --marker "<Approval Attestation text>" --record … --entity … --matter …
         --call-date … --call-type … --version …
      Re-check a marker against the values READ BACK from the created record,
      failing closed exactly as the Runtime reader does.

Six-field hash: SHA-256 (lowercase hex) over the UTF-8 bytes of the compact JSON
array [["Call_Notes_ID",v],["Entity",v],["Matter",v],["Call Date",v],
["Call Type",v],["Version","<decimal>"]], every string trimmed. Entity and
Matter are the ENT-n / MAT-n tokens, never Notion page ids. Legacy eight-field
markers fail at fields_hash and are never reinterpreted.

Exit codes: 0 PASS, 1 FAIL, 2 usage.
"""
import argparse
import hashlib
import json
import re
import sys
import uuid

MARKER_NAME = "record_approval"
FIELDS = ["Call_Notes_ID", "Entity", "Matter", "Call Date", "Call Type", "Version"]
REQUIRED = ["result", "record", "entity", "matter", "version", "fields_hash"]
CALL_TYPES = ["Discovery", "Sales", "Qualification", "Follow-up", "Review", "Other"]
MARKER_RE = re.compile(r"\[record_approval ([^\]]*)\]")
FIELD_RE = re.compile(r"(\w+)=([^\s\]]*)")
TOKEN = {"entity": re.compile(r"^ENT-\d+$"), "matter": re.compile(r"^MAT-\d+$")}
CN_ID = re.compile(r"^CN-[0-9a-fA-F-]{8,}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def canonical_text(record, entity, matter, call_date, call_type, version):
    values = [record.strip(), entity.strip(), matter.strip(), call_date.strip(), call_type.strip(), str(version)]
    # JSON.stringify-compatible compact JSON: no spaces, non-ASCII kept as-is.
    return json.dumps([[f, v] for f, v in zip(FIELDS, values)], separators=(",", ":"), ensure_ascii=False)


def fields_hash(*args):
    return hashlib.sha256(canonical_text(*args).encode("utf-8")).hexdigest()


def record_problem(a):
    if not a.record.strip():
        return "the record carries no Call_Notes_ID"
    if not CN_ID.match(a.record.strip()):
        return f"Call_Notes_ID {a.record!r} is not CN-<unique-id>"
    for kind in ("entity", "matter"):
        if not TOKEN[kind].match(getattr(a, kind).strip()):
            return f"{kind} {getattr(a, kind)!r} is not an {kind.upper()[:3]}-n token (never a Notion page id)"
    if not DATE.match(a.call_date.strip()):
        return f"Call Date {a.call_date!r} is not YYYY-MM-DD"
    if a.call_type.strip() not in CALL_TYPES:
        return f"Call Type {a.call_type!r} is not one of {', '.join(CALL_TYPES)}"
    if a.version < 1:
        return "Version must be an integer of at least 1"
    return None


def cmd_build(a):
    if not a.approved_by_martin:
        print("FAIL: refusing to build an Approved marker without --approved-by-martin (ask Martin to approve the exact record first)")
        return 1
    problem = record_problem(a)
    if problem:
        print(f"FAIL: {problem}")
        return 1
    h = fields_hash(a.record, a.entity, a.matter, a.call_date, a.call_type, a.version)
    marker = (
        f"[{MARKER_NAME} result=Approved record={a.record.strip()} entity={a.entity.strip()} "
        f"matter={a.matter.strip()} version={a.version} fields_hash={h}]"
    )
    print(marker)
    return 0


def cmd_verify(a):
    problem = record_problem(a)
    if problem:
        print(f"FAIL: cannot check against this record — {problem}")
        return 1
    m = MARKER_RE.search(a.marker or "")
    if not m:
        print("FAIL: no record_approval marker found")
        return 1
    entries = FIELD_RE.findall(m.group(1))
    keys = [k for k, _ in entries]
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    if dupes:
        print(f"FAIL: field(s) recorded more than once: {', '.join(dupes)}")
        return 1
    f = dict(entries)
    missing = [k for k in REQUIRED if not f.get(k)]
    if missing:
        print(f"FAIL: field(s) missing or empty: {', '.join(missing)}")
        return 1
    if f["result"] not in ("Approved", "Rejected"):
        print("FAIL: result is missing or malformed")
        return 1
    if f["result"] != "Approved":
        print("FAIL: result is Rejected")
        return 1
    for key, expected in (("record", a.record), ("entity", a.entity), ("matter", a.matter)):
        if f[key] != expected.strip():
            print(f"FAIL: marker {key}={f[key]} does not match the record's {expected.strip()}")
            return 1
    if not re.fullmatch(r"\d+", f["version"]) or int(f["version"]) != a.version:
        print("FAIL: marker version does not match the record's Version")
        return 1
    if not re.fullmatch(r"[0-9a-f]{64}", f["fields_hash"]):
        print("FAIL: fields_hash is malformed")
        return 1
    if f["fields_hash"] != fields_hash(a.record, a.entity, a.matter, a.call_date, a.call_type, a.version):
        print("FAIL: fields_hash does not match this record's six registry fields (legacy eight-field markers fail here)")
        return 1
    print("PASS: record_approval marker matches the record as read back")
    return 0


def main(argv):
    p = argparse.ArgumentParser(prog="call_notes_attestation.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd")
    sub.add_parser("new-id")
    for name in ("build", "verify"):
        s = sub.add_parser(name)
        if name == "verify":
            s.add_argument("--marker", required=True)
        s.add_argument("--record", required=True)
        s.add_argument("--entity", required=True)
        s.add_argument("--matter", required=True)
        s.add_argument("--call-date", required=True)
        s.add_argument("--call-type", required=True)
        s.add_argument("--version", required=True, type=int)
        if name == "build":
            s.add_argument("--approved-by-martin", action="store_true")
    try:
        a = p.parse_args(argv)
    except SystemExit:
        return 2
    if a.cmd == "new-id":
        print(f"CN-{uuid.uuid4()}")
        return 0
    if a.cmd == "build":
        return cmd_build(a)
    if a.cmd == "verify":
        return cmd_verify(a)
    p.print_usage()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
