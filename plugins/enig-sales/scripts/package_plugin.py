import os, sys, zipfile, hashlib
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dist = os.path.join(root, "dist")
os.makedirs(dist, exist_ok=True)
out = os.path.join(dist, "enig-sales.plugin")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(root):
        for fn in files:
            full = os.path.join(dirpath, fn)
            if os.path.abspath(full) == os.path.abspath(out):
                continue
            arc = os.path.relpath(full, root)
            z.write(full, arc)
# validate
with zipfile.ZipFile(out) as z:
    names = z.namelist()
    assert ".claude-plugin/plugin.json" in names, "manifest missing"
    assert "skills/sales-call-prep/SKILL.md" in names, "skill missing"
print("packaged:", out)
print("sha256:", hashlib.sha256(open(out,"rb").read()).hexdigest())
