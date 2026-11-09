#!/usr/bin/env python3
"""
check_client_text.py — client-facing text must carry no internal ENIG token.

A client agreement or email is the one place real identity belongs, so the
identity scan does not apply to it. What must never appear there is an
internal ENIG identifier. This hard-fails on any canonical internal token:
ENT-n, MAT-n, PROP-n, HO-n, CSA-n, PAY-n, LOG-n, RES-nnn, CN-<id>.

Read-only: it reads text and prints a result. It never calls Notion, Gmail or
Drive, and a PASS is never proof of Martin's approval.

Usage:
    python3 check_client_text.py path/to/agreement.txt
    cat email.txt | python3 check_client_text.py -

Exit code 0 = PASS, 1 = FAIL (internal token found), 2 = usage error.
"""
import re
import sys

TOKEN = re.compile(r"\b(?:ENT|MAT|PROP|HO|CSA|PAY|LOG)-\d+\b|\bRES-\d{3}\b|\bCN-[0-9a-fA-F-]{8,}\b")


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[0])
        print("usage: check_client_text.py <file|->", file=sys.stderr)
        return 2
    try:
        text = sys.stdin.read() if argv[1] == "-" else open(argv[1], encoding="utf-8").read()
    except OSError as err:
        print(f"usage error: {err}", file=sys.stderr)
        return 2
    found = sorted(set(m.group(0) for m in TOKEN.finditer(text)))
    if found:
        print("FAIL: internal ENIG tokens in client-facing text: " + ", ".join(found))
        return 1
    print("PASS: no internal ENIG tokens in client-facing text")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
