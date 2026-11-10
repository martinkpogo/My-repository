# ENIG Isolated Sales — fresh project setup

Four files, built together and checked against each other (`sync_check.py`):

| File | Goes where | Canonical source |
|---|---|---|
| `project-instruction.md` | The Claude Project's **instructions** (paste the whole text) | Notion: Isolated Sales: Operating Specification › Project Instruction |
| `enig-static-reference.md` | The Claude Project's **files / knowledge**, with exactly this file name | Notion: Isolated Sales: Operating Specification › Static Reference (LOG-1165) |
| `enig-sales.plugin` | Your Claude **plugins** (upload and enable) — version 3.3.0 | This repository, `plugins/enig-sales/` |
| `sync_check.py` | Nowhere — a check you can re-run after any change | — |

## Steps

1. **Remove old copies.** In Claude, uninstall or disable any older `enig-sales` plugin (3.1.0 or 3.2.x) and the separate `enig-sales-agreement` plugin. 3.3.0 replaces both; two copies of the same skill names will confuse the model.
2. **Create the Project** (for example "ENIG Isolated Sales").
3. **Instructions:** paste the full text of `project-instruction.md`.
4. **Project file:** add `enig-static-reference.md`. Keep the file name exactly; the Instruction and every skill refer to it by name.
5. **Plugin:** unzip the kit first, then upload **`enig-sales.plugin` itself** (not the kit zip) and enable it for the Project. Its manifest is `.claude-plugin/plugin.json` at the top level of that file; the kit zip has none, so uploading the kit is refused.
6. **Code execution:** make sure the Project can run code. Every skill runs the plugin's Python scripts (token checks, identity scan, Call Notes and Handoff attestation); without code execution they stop at "scripts can't be found".
7. **Connectors** (see the plugin's `CONNECTORS.md`): Notion (required — the account must see ENIG HQ, including the new Agreements and Payments databases), Gmail and Google Drive (required for correspondence, release and agreements), Read.ai (call evidence; fallbacks allowed), Google Calendar (optional).
8. **First check — no writes.** In a new chat in the Project, send:
   > TEST RUN — run the plugin check (`scripts/plugin_check.py` in any enig-sales skill folder) and report its result, then confirm the Static Reference's "Log reviewed through" line.

   Expected: `enig-sales 3.3.0: ALL PASS` (including "all 8 skills mounted"), and "Log reviewed through LOG-1164 (2026-11-09)". Claude chat loads only the skill folders, so the plugin's top-level files (manifest, README, `selftest.py`) are not visible there; that is normal. LOG-1165 appearing in the Log after the baseline is expected: it is the Change that corrected the Static Reference itself, not a Decision, and it pauses nothing.
9. **Then the #358 acceptance test**, with `docs/test-sales-call-transcript-acceptance.md` (steps B1–B4).

## Keeping them in sync later

- Change the canonical Notion page first (through a logged Decision or Change), then update the matching file here.
- After changing any of the three, run `python3 sync_check.py --plugin enig-sales.plugin`. It checks that the skills, scripts, references, cited Instruction sections, data-source IDs, plugin version and the Handoff/CVE rules agree.
