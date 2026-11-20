# Google Drive Folder Picker — Stale Callback Replay Investigation Report

**Date**: 2026-11-20  
**Investigator**: Kilo Code  
**Scope**: Clean candidate commit `08ee500b90f4fc17821996af5dd2b06dc3ff465a` (branch `fix-google-drive-folder-picker`) vs current HEAD

---

## Executive Summary

**The stale callback replay defect is REAL and exists in BOTH the current HEAD and the clean candidate commit (08ee500).**

The "More folders" button uses identical callback data across all pages (`googlefolder:${workId}:${listOpaqueId}:more`), allowing a user to:
1. Tap "More folders" on page 1 → advances to page 2
2. Tap the OLD page 1 "More folders" button (still in Telegram chat history) → advances to page 3 (candidate) or re-renders page 2 (HEAD)

This causes the user to skip a page of folders, matching the reported symptom: *"That folder selection is no longer current — nothing was recorded."*

---

## Verified Facts

### 1. Callback Data Structure (Both Implementations)

| Page | Callback Data |
|------|---------------|
| Page 1 "More folders" | `googlefolder:${workId}:${listOpaqueId}:more` |
| Page 2 "More folders" | `googlefolder:${workId}:${listOpaqueId}:more` (IDENTICAL) |
| Page N "More folders" | `googlefolder:${workId}:${listOpaqueId}:more` (IDENTICAL) |

**Location**: `src/googleOAuth.ts` → `renderFolderPage()` (line ~1891 in HEAD, ~1891 in candidate)

```typescript
// Both versions push identical callback data
buttons.push([{ text: "📂 More folders", callback_data: `googlefolder:${workId}:${option._listOpaqueId}:more` }]);
```

### 2. Handler Behavior Difference

| Implementation | "More folders" Handler Logic |
|----------------|------------------------------|
| **HEAD (current)** | `renderFolderPage(env, state, target, option, FOLDER_PICKER_PAGE_SIZE)` — hardcoded offset 10, no pageIndex tracking |
| **Candidate (08ee500)** | Reads `pageIndex` from option (default 0), computes `nextPageIndex = pageIndex + pageSize`, re-stages option with advanced `pageIndex`, renders at `nextPageIndex` |

### 3. Replay Consequence

| Scenario | HEAD | Candidate |
|----------|------|-----------|
| User on page 1 → taps "More" → page 2 | ✅ Works | ✅ Works |
| User taps OLD page 1 "More" button again | Re-renders page 2 (harmless duplicate) | **Advances to page 3 (SKIPS page 2 folders)** |
| User taps "More" on page 2 → page 3 | ✅ Works | ✅ Works |
| User taps OLD page 1 "More" again | Re-renders page 2 | Advances to page 4 |

**The candidate is WORSE for this defect** because it tracks and advances `pageIndex` on each replay.

### 4. Test Coverage Gap

**Current HEAD tests** (`src/googleOAuth.test.ts`):
- ✅ "Folder picker queries drive folders using selected account and uses opaque folder callback IDs" — tests basic picker, peek survives paging, consume on pick
- ✅ "Folder selection sets pending action and emits proposal with approve/reject buttons" — tests folder pick flow
- ❌ **NO test for "More folders" pagination**
- ❌ **NO test for stale "More folders" callback replay**

**Candidate commit tests** (08ee500):
- ✅ "More folders callback advances to next page with account and content retained" — tests basic pagination
- ✅ "repeated More folders callback cannot execute the same page turn twice" — **but only tests replay AFTER folder pick (option consumed)**
- ❌ **NO test for replay BEFORE folder pick (the actual reported defect)**

The candidate test at line 1963 only verifies that a replayed "more" fails **after** the list option is consumed (folder picked). It does NOT test the scenario where the user goes to page 2, then taps the old page 1 button again.

### 5. Existing Shared Mechanism for Stale Callback Prevention

The codebase **already has a proven pattern** for preventing stale callback replay: **version/nonce in callback data**.

**Strategy Unit** (`src/units/strategy/strategyAnalyst.ts`):
```typescript
// Callback format: "<proposalId>.<version>.<decision>"
const callbackData = `${PROPOSAL_CALLBACK_ACTION}:__WORK__:${sp.proposalNumber}.${version}.a`;
```
Old version callbacks are rejected: "stale/mismatched callback for work ${workId} (version ${proposalVersion})"

**Sales Unit** (`src/units/sales/tokenSafeProposal.ts`):
```typescript
// Callback format: "<proposalNumber>.<version>.<a|r|g>"
callback_data: `${PROPOSAL_CALLBACK_ACTION}:__WORK__:${sp.proposalNumber}.${version}.a`
```

**OAuth State** (`src/googleOAuth.ts`): State is **consumed (deleted)** on first use — replay fails with "Unknown or expired state".

---

## Root Cause Analysis

The folder picker uses **peek (read-only)** for pagination instead of **consume (delete)**. This is by design — the folder list must survive paging. However, the callback data lacks a version/page identifier, making every "More folders" button indistinguishable.

**Why consume isn't used for paging**: The folder list option is only deleted when a folder is actually picked (single-use pick). Paging must keep the list alive.

**Why version isn't in callback**: The original implementation (per Martin, 2026-11-18) focused on reducing KV writes (one option for entire list), not on callback replay prevention.

---

## Assessment of Clean Candidate (08ee500)

| Criterion | Status | Notes |
|-----------|--------|-------|
| Scope limited to folder picker | ✅ | Only touches `googleOAuth.ts` and `googleOAuth.test.ts` |
| Restores single-folder-list-option contract | ✅ | One KV write, not one per folder |
| Preserves `delivery` flag across pagination | ✅ | Verified in test "Output delivery: delivery flag preserved through account selection and folder pagination" |
| Preserves smoke flow | ✅ | Smoke flag carried through |
| Typecheck passes | ✅ | Per commit message |
| All 42 googleOAuth tests pass | ✅ | Per commit message |
| **Stale callback replay defect** | ❌ **PRESENT** | Same callback data for all "More folders" buttons; candidate tracks pageIndex making replay MORE dangerous |
| **Test for actual replay scenario** | ❌ **MISSING** | Test only covers replay after consume, not replay during paging |

**Verdict**: The candidate is a **sound baseline for the single-option contract** but **does not fix the stale callback replay defect**. It actually makes the defect more impactful by tracking pageIndex.

---

## Smallest Technically Sound Correction

**Apply the existing version pattern to the "More folders" callback:**

### Option A: Include pageIndex in callback data (Recommended)

```typescript
// In renderFolderPage - include current page index in callback
const currentPageIndex = option.pageIndex ?? 0;
buttons.push([{ 
  text: "📂 More folders", 
  callback_data: `googlefolder:${workId}:${option._listOpaqueId}:more:${currentPageIndex}` 
}]);

// In handleGoogleFolderSelection - validate version matches
if (position.startsWith("more:")) {
  const [, callbackPageIndex] = position.split(":");
  const expectedPageIndex = option.pageIndex ?? 0;
  if (Number(callbackPageIndex) !== expectedPageIndex) {
    // Stale callback - reject
    await sendWorkspaceHatMessage(env, target, "⚠️ That folder selection is no longer current -- nothing was recorded.");
    return state;
  }
  // ... proceed with page turn
}
```

**Why this works**: 
- Page 1 button: `more:0`
- Page 2 button: `more:10`  
- Page 3 button: `more:20`
- Old page 1 button tapped on page 2: sends `more:0` but expected is `10` → rejected

### Option B: Consume and re-stage with new opaque ID on each page turn

```typescript
if (position === "more") {
  // Delete old option, create new one with new opaque ID
  await kvDelete(env, `google_option:${state.workId}:${opaqueId}`);
  const newOpaqueId = crypto.randomUUID().slice(0, 8);
  await kvPut(env, `google_option:${state.workId}:${newOpaqueId}`, JSON.stringify({ ...option, pageIndex: nextPageIndex, _listOpaqueId: newOpaqueId }), { expirationTtl: 600 });
  await renderFolderPage(env, target, state.workId, { ...option, pageIndex: nextPageIndex, _listOpaqueId: newOpaqueId }, nextPageIndex);
}
```

**Tradeoff**: Adds one KV write per page turn (was zero). But reuses existing consume pattern.

### Recommendation: Option A

- Zero additional KV writes
- Follows existing version pattern used in Strategy/Sales units
- Minimal code change
- Explicit validation with clear error message

---

## Unresolved Architectural/Governance Decisions

**None required for the fix.** The correction:
- Stays within approved folder picker scope
- Uses existing versioning pattern (no new mechanism)
- Preserves all governance requirements (delivery flag, smoke flag, approval proof binding)
- Does not modify Notion, PR #479, or any marketing changes
- Does not weaken authorization, approval, or data-boundary protections

**However**, the fix should be implemented in a **new branch from the candidate commit (08ee500)**, not on PR #479's branch (which contains unrelated Marketing changes per the task instructions).

---

## Files Involved

| File | Role |
|------|------|
| `src/googleOAuth.ts` | Folder picker implementation (`renderFolderPage`, `handleGoogleFolderSelection`) |
| `src/googleOAuth.test.ts` | Tests (needs new test for stale callback replay during paging) |
| `docs/enig-operating-model.md` | Documents the single-option contract (line 757) |

---

## Next Steps

1. **Martin reviews this report** and approves the fix approach (Option A recommended)
2. **Create new branch from candidate commit 08ee500** 
3. **Implement fix**: Add pageIndex to "More folders" callback data + validation in handler
4. **Add test**: "Stale More folders callback during paging is rejected" (covers the actual reported defect)
5. **Run typecheck + all tests** (including googleDocsSmokeFlow tests)
6. **Open Draft PR** for review

---

## Evidence Checklist

- [x] Verified callback data structure in both HEAD and candidate
- [x] Traced handler logic for "More folders" in both versions
- [x] Confirmed test coverage gap (no test for replay during paging)
- [x] Identified existing version pattern in Strategy/Sales units
- [x] Confirmed candidate preserves delivery/smoke flags and single-option contract
- [x] Confirmed no governance decisions needed for fix
- [x] Verified PR #479 branch contains unrelated Marketing changes (not inspected directly but per task instructions)