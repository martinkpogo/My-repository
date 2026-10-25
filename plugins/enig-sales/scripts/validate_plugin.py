import json, os, sys, zipfile
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
manifest_path = os.path.join(root, ".claude-plugin", "plugin.json")
if not os.path.isfile(manifest_path):
    print("missing manifest"); sys.exit(1)
with open(manifest_path) as f:
    m = json.load(f)
for k in ("name","version","description"):
    if k not in m:
        print("missing field", k); sys.exit(1)
for skill_name in ("sales-call-prep", "sales-call-evidence"):
    skill = os.path.join(root, "skills", skill_name, "SKILL.md")
    if not os.path.isfile(skill):
        print("missing SKILL.md for", skill_name); sys.exit(1)
print("OK")
sys.exit(0)
