#!/usr/bin/env python3
"""
scan_identity_leakage.py — a deterministic floor under the identity boundary,
not a replacement for it.

Hard-fails on structural patterns that have a fixed shape a regex can catch
reliably: email addresses, phone numbers. Soft-warns on patterns that only
*might* be a real person's or company's name — those have no fixed shape,
so this script flags them for a human/model re-read rather than blocking on
them. This is deliberate: a hard block on every capitalized-word sequence
would bury real leaks in false positives and train people to ignore the
output. The warnings exist to prompt the "re-read it yourself" step each
skill already requires before showing anything to Martin — they don't
replace it.

Usage:
    python3 scan_identity_leakage.py path/to/draft_narrative.txt
    cat draft.txt | python3 scan_identity_leakage.py -

    # Recommended: also pass every identity string from the source.
    python3 scan_identity_leakage.py draft.txt --identity "Full Name" "First" "Surname" "Company" "email" "phone"

Hard fails: email addresses, phone numbers, web addresses, and any --identity
string (case-insensitive). Identity strings shorter than 3 characters are ignored.

    # Client-facing text (an email, invite, Proposal or agreement document) is
    # MEANT to carry the client's identity. Check it instead for internal
    # ENIG tokens, which must never reach a client:
    python3 scan_identity_leakage.py email.txt --client-facing

--client-facing hard-fails only on internal tokens: ENT-n, MAT-n, PROP-n, HO-n,
CSA-n, PAY-n, LOG-n, RES-nnn, CN-<id>.

Exit code 0 = no hard failures (warnings may still be present, check output),
1 = at least one hard failure, 2 = usage error.
"""
import re
import sys

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL_RE = re.compile(
    r"(?:https?://|www\.)\S+"
    r"|\b[a-z0-9][a-z0-9-]*\.(?:com|org|net|io|co|biz|info|africa|gh|ng|uk|us)(?:\.[a-z]{2})?\b",
    re.I,
)

# Loose but practical: catches +233501234567, (055) 123-4567, 020-123-4567, etc.
# without needing a country-specific library.
PHONE_RE = re.compile(r"(\+?\d[\d\-\s()]{7,}\d)")
ISO_DATETIME_RE = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b")

# Heuristic only — a run of 2-3 capitalized words that isn't a sentence start
# and isn't a known safe business term. Soft warning, never a hard fail.
NAME_LIKE_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b")

# Words that commonly trigger the name-like heuristic but are legitimate
# business vocabulary, not identity. Extend this list as false positives show up.
SAFE_TERMS = {
    "Organisation", "Entity", "Matter", "Call Notes", "Evidence Package",
    "Status Open", "Status Lead", "Status Ready", "Business Context",
    # Stakeholder roles: the evidence rules require people to be written as roles.
    "Managing Director", "Operations Director", "Finance Director", "Finance Manager",
    "Operations Manager", "Marketing Manager", "Marketing Director", "Sales Director",
    "Sales Manager", "General Manager", "Chief Executive", "Chief Operating Officer",
    "Chief Financial Officer", "Chief Marketing Officer", "Head Of", "Project Manager",
    "Product Manager", "Brand Manager", "Business Owner", "Sales Executive",
    "Strategy Analyst",
    # Governed field and section names used in Matter evidence and Handoffs.
    "Verified Facts", "Open Questions", "Required Next Action", "Expected Output",
    "Acceptance Criteria", "Work Completed", "Stated Need", "Current Understanding",
    "Value Evidence", "Decision Process", "Next Action", "Evidence Source",
}


def scan(text: str, identity: list[str] | None = None) -> tuple[list[str], list[str]]:
    hard_failures = []
    warnings = []

    emails = EMAIL_RE.findall(text)
    if emails:
        hard_failures.append(f"{len(emails)} email address(es) found: {', '.join(sorted(set(emails)))}")

    # Strip emails first so their domains aren't double-reported as web addresses.
    urls = [m.group(0) for m in URL_RE.finditer(EMAIL_RE.sub(" ", text))]
    if urls:
        hard_failures.append(f"{len(urls)} web address(es) found: {', '.join(sorted(set(urls)))}")

    low = text.lower()
    hits = sorted({s for s in (identity or []) if len(s.strip()) >= 3 and s.strip().lower() in low})
    if hits:
        hard_failures.append(f"{len(hits)} identity string(s) from the source found: {', '.join(hits)}")

    # ISO dates and timestamps (2026-10-05, 2026-10-05 04:20) are required in
    # evidence locators and are not phone numbers; mask them before matching.
    phone_text = ISO_DATETIME_RE.sub(" ", text)
    phones = [m.group(0) for m in PHONE_RE.finditer(phone_text) if len(re.sub(r"\D", "", m.group(0))) >= 8]
    if phones:
        hard_failures.append(f"{len(phones)} phone-number-shaped string(s) found: {', '.join(sorted(set(phones)))}")

    name_like = {m for m in NAME_LIKE_RE.findall(text) if m not in SAFE_TERMS}
    if name_like:
        warnings.append(
            f"{len(name_like)} capitalized phrase(s) that *might* be a person's or company's "
            f"name — review by hand, this is a heuristic, not a reliable detector: {', '.join(sorted(name_like))}"
        )

    return hard_failures, warnings


INTERNAL_TOKEN_RE = re.compile(r"\b(?:ENT|MAT|PROP|HO|CSA|PAY|LOG)-\d+\b|\bRES-\d{3}\b|\bCN-[0-9a-fA-F-]{8,}\b")


def scan_client_facing(text: str) -> list[str]:
    tokens = sorted({m.group(0) for m in INTERNAL_TOKEN_RE.finditer(text)})
    return [f"{len(tokens)} internal ENIG token(s) in client-facing text: {', '.join(tokens)}"] if tokens else []


def main() -> int:
    args = sys.argv[1:]
    client_facing = "--client-facing" in args
    if client_facing:
        args = [a for a in args if a != "--client-facing"]
    identity = []
    if "--identity" in args:
        i = args.index("--identity")
        identity, args = args[i + 1:], args[:i]
    if len(args) != 1:
        print('USAGE: scan_identity_leakage.py <path-to-file | -> [--identity "string" ...] | [--client-facing]')
        return 2

    source = args[0]
    try:
        text = sys.stdin.read() if source == "-" else open(source, encoding="utf-8").read()
    except OSError as e:
        print(f"USAGE ERROR: cannot read {source}: {e}")
        return 2
    if not text.strip():
        print("USAGE ERROR: the draft is empty — nothing was scanned.")
        return 2

    if client_facing:
        failures = scan_client_facing(text)
        if failures:
            print("FAIL — client-facing text carries internal ENIG tokens:")
            for f in failures:
                print(f"  - {f}")
            return 1
        print("PASS: no internal ENIG tokens in client-facing text.")
        return 0

    hard_failures, warnings = scan(text, identity)

    if hard_failures:
        print("FAIL — structural identity leak detected:")
        for f in hard_failures:
            print(f"  - {f}")

    if warnings:
        print("WARN — possible leak, needs a human/model re-read (not auto-blocked):")
        for w in warnings:
            print(f"  - {w}")

    if not hard_failures and not warnings:
        print("PASS: no structural leaks or name-like patterns found. "
              "This does not certify the text is clean — still do the skill's own re-read.")

    return 1 if hard_failures else 0


if __name__ == "__main__":
    sys.exit(main())
