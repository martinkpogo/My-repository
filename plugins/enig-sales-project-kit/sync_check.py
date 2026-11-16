#!/usr/bin/env python3
"""sync_check.py — the three Isolated Sales working copies agree with each other.

Checks project-instruction.md, enig-static-reference.md and the enig-sales
plugin (a folder or a .plugin archive) against one another. Read-only.

Usage: python3 sync_check.py [--plugin <dir or .plugin>]
Exit 0 = in sync, 1 = a check failed.
"""
import json, os, re, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
plugin = args[args.index("--plugin") + 1] if "--plugin" in args else os.path.join(HERE, "..", "enig-sales")
if plugin.endswith(".plugin"):
    tmp = tempfile.mkdtemp()
    zipfile.ZipFile(plugin).extractall(tmp)
    plugin = tmp

instr = open(os.path.join(HERE, "project-instruction.md"), encoding="utf-8").read()
ref = open(os.path.join(HERE, "enig-static-reference.md"), encoding="utf-8").read()
skills = {s: open(os.path.join(plugin, "skills", s, "SKILL.md"), encoding="utf-8").read() for s in sorted(os.listdir(os.path.join(plugin, "skills")))}
calls = open(os.path.join(plugin, "references", "notion-calls.md"), encoding="utf-8").read()
manifest = json.load(open(os.path.join(plugin, ".claude-plugin", "plugin.json")))
fails = 0


def check(ok, label):
    global fails
    print(("PASS " if ok else "FAIL ") + label)
    fails += 0 if ok else 1


# 1. Skills: Static Reference stage table <-> plugin
stage = ref.split("### Stage → skill")[1].split("###")[0]
named = set(re.findall(r"`(sales-[a-z-]+)`", stage))
check(named == set(skills), f"Static Reference stage table names exactly the plugin's skills ({', '.join(sorted(named ^ set(skills))) or 'match'})")

# 2. Files the Static Reference names exist in the plugin
howto = ref.split("### How-to → plugin file")[1].split("###")[0]
for f in sorted(set(re.findall(r"`((?:references|scripts)/[a-z_\-]+\.(?:md|py))`", howto))):
    check(os.path.exists(os.path.join(plugin, f)), f"plugin ships {f} (named in Static Reference)")
check("references/notion-calls.md" in instr and os.path.exists(os.path.join(plugin, "references", "notion-calls.md")), "Instruction §9's references/notion-calls.md ships in the plugin")
check("enig-static-reference.md" in instr, "Instruction names enig-static-reference.md")

# 3. Section numbers the skills cite exist in the Instruction
sections = set(re.findall(r"^#{2,3} (\d+(?:\.\d+)?)\.? ", instr, re.M))
for s, text in skills.items():
    cited = set(re.findall(r"Project Instruction §(\d+(?:\.\d+)?)", text)) | set(re.findall(r"\(§(\d+(?:\.\d+)?)\)", text))
    cited |= {x for m in re.findall(r"Project Instruction §(\d+)[–-]§?(\d+)", text) for x in m}
    missing = sorted(c for c in cited if c not in sections)
    check(not missing, f"{s}: every cited Instruction section exists ({', '.join(missing) or 'ok'})")

# 4. Data sources agree
ref_ids = dict(re.findall(r"\| ([A-Za-z &]+?) \| `collection://([0-9a-f-]{36})`", ref))
call_ids = dict(re.findall(r"\| ([A-Za-z &]+?) \| `collection://([0-9a-f-]{36})`", calls))
for name, cid in sorted(call_ids.items()):
    check(ref_ids.get(name) == cid, f"data source {name}: plugin and Static Reference agree")

# 5. Log-check baseline line the plugin reads
check(bool(re.search(r"Log reviewed through LOG-\d+ \(\d{4}-\d{2}-\d{2}\)", ref)), "Static Reference has the 'Log reviewed through LOG-n (date)' line the plugin's log check reads")

# 6. Versions and rules agree
check(f"plugin **{manifest['version']}**" in ref, f"Static Reference records plugin {manifest['version']}")
check("compatibility copy" in ref and "retain the existing Commercial Value Evidence block in the Handoff" in instr and "compatibility copy" in calls, "CVE compatibility copy: Instruction §8, Static Reference and plugin agree")
check("token:entity:" in ref and "token:entity:" in calls and "Entity_Token` / `Matter_Token` properties are retired" in ref, "Handoff identity via Sources tokens (LOG-1149): Static Reference and plugin agree")
check("search, fetch, backlinks" in instr and "Search, fetch and backlinks only" in calls, "Notion lookups: Instruction §9 and plugin agree")
writes_retired = [s for s, t in skills.items() if re.search(r'"(Entity_Token|Matter_Token)"\s*:', t)]
check(not writes_retired, "no skill writes the retired Handoff token properties")

print(f"\n{'IN SYNC' if fails == 0 else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
