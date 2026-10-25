import os, sys, zipfile, json

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dist", "enig-sales.plugin")
if not os.path.isfile(path):
    print("archive missing:", path)
    sys.exit(1)

ALLOWED = {
    ".claude-plugin/plugin.json",
    "README.md",
    "skills/sales-call-prep/SKILL.md",
    "skills/sales-call-evidence/SKILL.md",
}

with zipfile.ZipFile(path) as z:
    names = set(z.namelist())
    # Check required files
    for r in sorted(ALLOWED):
        if r not in names:
            print("missing in archive:", r)
            sys.exit(1)
    # Check for unexpected files
    unexpected = sorted(list(names - ALLOWED))
    if unexpected:
        print("unexpected files in archive:", unexpected)
        sys.exit(1)
    # Validate manifest
    m = json.loads(z.read(".claude-plugin/plugin.json"))
    for k in ("name", "version", "description"):
        if k not in m:
            print("manifest missing field", k)
            sys.exit(1)
print("archive OK:", path)
sys.exit(0)
