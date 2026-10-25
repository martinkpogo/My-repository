import os, sys, zipfile, hashlib

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dist = os.path.join(root, "dist")
os.makedirs(dist, exist_ok=True)
out = os.path.join(dist, "enig-sales.plugin")

ALLOWED = {
    ".claude-plugin/plugin.json",
    "README.md",
    "skills/sales-call-prep/SKILL.md",
    "skills/sales-call-evidence/SKILL.md",
}

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(root):
        for fn in files:
            full = os.path.join(dirpath, fn)
            if os.path.abspath(full) == os.path.abspath(out):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if rel.startswith("dist/"):
                continue
            if rel == ".gitignore":
                continue
            if rel.startswith("REQUIREMENTS-MAPPING"):
                continue
            if rel.startswith("scripts/"):
                continue
            arc = rel  # files at plugin root layout
            if arc not in ALLOWED:
                raise SystemExit(f"unexpected file in package allowlist: {arc}")
            z.write(full, arc)

# validate
with zipfile.ZipFile(out) as z:
    names = z.namelist()
    for r in sorted(ALLOWED):
        assert r in names, f"manifest/required missing: {r}"
print("packaged:", out)
print("sha256:", hashlib.sha256(open(out,"rb").read()).hexdigest())
