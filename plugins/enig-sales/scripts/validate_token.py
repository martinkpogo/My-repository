#!/usr/bin/env python3
"""
validate_token.py — catches the "E-ENT-25" / "M-MAT-26" bug mechanically.

Checks that an Entity/Matter ID or title is built from the canonical
token format (ENT-<sequence> / MAT-<sequence>) with no added prefix.

Usage:
    python3 validate_token.py entity ENT-25
    python3 validate_token.py matter "MAT-26 - Logo redesign"
    python3 validate_token.py entity "E-ENT-25 (Organisation - Energy)"   # fails

  Full-title checks (use before setting any title):
    python3 validate_token.py entity-title "ENT-27 (Organisation – Agro-processing)"
    python3 validate_token.py matter-title "MAT-28 – Market perception and retail account loss"

  Other identifiers:
    python3 validate_token.py resolution RES-003     # Registry Resolution_ID
    python3 validate_token.py handoff HO-12          # Handoff ID

Titles use an EN DASH (–), not a hyphen (-).
Exit code 0 = valid, 1 = invalid, 2 = usage error. Prints one line: PASS/FAIL plus reason.
"""
import re
import sys

CANONICAL = {
    "entity": re.compile(r"^ENT-\d+$"),
    "matter": re.compile(r"^MAT-\d+$"),
}

# Whole-value checks: the value must match exactly, not just its first token.
FULL = {
    "entity-title": (re.compile(r"^ENT-[1-9]\d* \((Individual|Organisation) – [^()–]+\)$"),
                     "ENT-n (Individual|Organisation – <sector descriptor>)"),
    "matter-title": (re.compile(r"^MAT-[1-9]\d* – \S.*$"),
                     "MAT-n – <non-identifying descriptor>"),
    "resolution": (re.compile(r"^RES-\d{3}$"), "RES-nnn (three digits, e.g. RES-003)"),
    "handoff": (re.compile(r"^HO-[1-9]\d*$"), "HO-n"),
}


def check_full(kind: str, value: str) -> int:
    pattern, expected = FULL[kind]
    if pattern.match(value):
        print(f"PASS: '{value}' is a valid {kind}")
        return 0
    reasons = [f"expected {expected}"]
    if kind.endswith("-title") and re.search(r"\s-\s", value):
        reasons.append("found a hyphen ( - ) where an en dash ( – ) is required")
    if re.match(r"^[A-Z]-(ENT|MAT)-", value):
        reasons.append("has a doubled prefix (e.g. E-ENT-)")
    print(f"FAIL: '{value}' is not a valid {kind}: " + "; ".join(reasons))
    return 1

# Common ways a malformed token shows up, so the failure message is specific
# rather than a bare "doesn't match".
KNOWN_BAD_PATTERNS = [
    (re.compile(r"^E-ENT-\d+"), "has a doubled prefix (E- on top of the already-canonical ENT- form)"),
    (re.compile(r"^M-MAT-\d+"), "has a doubled prefix (M- on top of the already-canonical MAT- form)"),
    (re.compile(r"^E-\d+"), "uses the stale E-<n> shorthand instead of canonical ENT-<n>"),
    (re.compile(r"^M-\d+"), "uses the stale M-<n> shorthand instead of canonical MAT-<n>"),
]


def extract_token(object_type: str, value: str) -> str:
    """Pull the leading token off a full title string like 'ENT-25 (Organisation - Energy)'."""
    return value.strip().split(" ", 1)[0].rstrip("–—-:")


def main() -> int:
    if len(sys.argv) != 3:
        print("USAGE: validate_token.py <entity|matter|entity-title|matter-title|resolution|handoff> <value>")
        return 2

    object_type, raw_value = sys.argv[1].lower(), sys.argv[2]
    if object_type in FULL:
        return check_full(object_type, raw_value.strip())
    if object_type not in CANONICAL:
        print(f"FAIL: unknown object type '{object_type}' — must be one of: "
              "entity, matter, entity-title, matter-title, resolution, handoff")
        return 2

    token = extract_token(object_type, raw_value)
    pattern = CANONICAL[object_type]

    if pattern.match(token):
        print(f"PASS: '{token}' is a valid canonical {object_type} token")
        return 0

    for bad_pattern, reason in KNOWN_BAD_PATTERNS:
        if bad_pattern.match(token):
            expected_prefix = "ENT-" if object_type == "entity" else "MAT-"
            print(f"FAIL: '{token}' {reason}. Expected bare '{expected_prefix}<sequence>', nothing in front of it.")
            return 1

    print(f"FAIL: '{token}' does not match the canonical {object_type} token format "
          f"({'ENT' if object_type == 'entity' else 'MAT'}-<sequence>)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
