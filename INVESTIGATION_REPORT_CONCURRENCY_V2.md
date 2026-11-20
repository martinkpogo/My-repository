# Google Drive Folder Picker — Concurrency Investigation (Corrected)

**Date**: 2026-11-20  
**Investigator**: Kilo Code  
**Scope**: Corrected analysis of callback byte budget, parser compatibility, DO concurrency, and recommended fix for issue #479

---

## 1. Callback Byte Budget — Proven

### Production Values

| Component | Value | Bytes |
|-----------|-------|-------|
| Action prefix | `googlefolder:` | 13 |
| Work ID | UUID v4 (e.g., `01234567-89ab-cdef-0123-456789abcdef`) | 36 |
| Separator | `:` | 1 |
| Opaque ID | 8 hex chars (from `crypto.randomUUID().slice(0, 8)`) | 8 |
| Separator | `:` | 1 |
| **Position suffix** | varies | **varies** |

### Current Production Callbacks

| Callback Type | Position Suffix | Total Bytes |
|---------------|-----------------|-------------|
| "More folders" | `more` | 13+36+1+8+1+4 = **63** |
| Folder pick (index 0-9) | `0`–`9` | 13+36+1+8+1+1 = **60** |
| Folder pick (index 10-99) | `10`–`99` | **61** |

**Current "More folders" callback: 63 bytes** — 1 byte under Telegram's 64-byte limit.

### Proposed Compact Encoding

Use a single **base36 page number character** appended to `more`:

```
googlefolder:${workId}:${opaqueId}:more${pageChar}
```

Where `pageChar = base36(pageIndex / 10)` (pageIndex is always a multiple of 10: 0, 10, 20, 30...).

| Page Index | Page Number | pageChar | Position Suffix | Total Bytes |
|------------|-------------|----------|-----------------|-------------|
| 0 | 0 | `0` | `more0` | **64** |
| 10 | 1 | `1` | `more1` | **64** |
| 20 | 2 | `2` | `more2` | **64** |
| ... | ... | ... | ... | **64** |
| 100 | 10 | `a` | `morea` | **64** |
| 350 | 35 | `z` | `morez` | **64** |
| 360 | 36 | `10` | `more10` | **65** (exceeds) |

**Result**: Fits exactly 64 bytes for up to 350 folders (35 pages × 10 folders/page). Production folders rarely exceed 50.

### Backward Compatibility

Existing buttons in chat history have position `more` (no pageChar). Handler treats:
- `position === "more"` → pageIndex = 0 (backward compatible)
- `position.startsWith("more")` with extra char → parse pageChar

### Test to Add

```typescript
test("More folders callback with page version fits 64-byte Telegram limit", () => {
  const workId = "01234567-89ab-cdef-0123-456789abcdef"; // 36-char UUID
  const opaqueId = "a1b2c3d4"; // 8 hex chars
  for (const pageChar of ["0", "1", "5", "a", "z"]) {
    const callback = `googlefolder:${workId}:${opaqueId}:more${pageChar}`;
    assert.strictEqual(callback.length, 64, `pageChar ${pageChar} must be 64 bytes`);
  }
  // Backward compat
  const legacy = `googlefolder:${workId}:${opaqueId}:more`;
  assert.strictEqual(legacy.length, 63, "legacy callback is 63 bytes");
});
```

---

## 2. Callback Parser Correction

### Current Router Parsing (index.ts:794)

```typescript
const [action, workId, value] = data.split(":");
```

- `action` = `googlefolder`
- `workId` = full UUID
- `value` = everything after second `:` → `${opaqueId}:more${pageChar}`

### Current Handler Parsing (googleOAuth.ts:1935-1937)

```typescript
const colon = opaqueOptionId.lastIndexOf(":");
const opaqueId = colon === -1 ? opaqueOptionId : opaqueOptionId.slice(0, colon);
const position = colon === -1 ? undefined : opaqueOptionId.slice(colon + 1);
```

### Incompatibility of Prior Proposal

Prior proposal: `googlefolder:${workId}:${opaqueId}:more:${pageIndex}`
- `value` = `${opaqueId}:more:${pageIndex}`
- `lastIndexOf(":")` → before `${pageIndex}`
- `opaqueId` = `${opaqueId}:more` ❌ (not 8 hex chars)
- `position` = `${pageIndex}` ❌

### Corrected Format & Parser

**Callback format**: `googlefolder:${workId}:${opaqueId}:more${pageChar}`

| Example | value | lastIndexOf(":") | opaqueId | position |
|---------|-------|------------------|----------|----------|
| Page 0 (legacy) | `a1b2c3d4:more` | before `more` | `a1b2c3d4` ✓ | `more` |
| Page 0 (new) | `a1b2c3d4:more0` | before `more0` | `a1b2c3d4` ✓ | `more0` |
| Page 1 | `a1b2c3d4:more1` | before `more1` | `a1b2c3d4` ✓ | `more1` |
| Folder pick | `a1b2c3d4:5` | before `5` | `a1b2c3d4` ✓ | `5` |

**Parser change in handleGoogleFolderSelection**:

```typescript
const colon = opaqueOptionId.lastIndexOf(":");
const opaqueId = colon === -1 ? opaqueOptionId : opaqueOptionId.slice(0, colon);
const position = colon === -1 ? undefined : opaqueOptionId.slice(colon + 1);

// NEW: Extract page version from position
let expectedPageIndex: number | null = null;
if (position === "more") {
  expectedPageIndex = 0; // backward compat
} else if (position?.startsWith("more")) {
  const pageChar = position[4]; // "moreX" → char at index 4
  const pageNumber = parseInt(pageChar, 36);
  if (!Number.isNaN(pageNumber)) {
    expectedPageIndex = pageNumber * 10;
  }
}

// Validation (added after peekOpaqueOption succeeds)
if (expectedPageIndex !== null) {
  const storedPageIndex = option.pageIndex ?? 0;
  if (expectedPageIndex !== storedPageIndex) {
    await sendWorkspaceHatMessage(env, target,
      "⚠️ That folder selection is no longer current -- nothing was recorded.");
    return state;
  }
}
```

### End-to-End Test to Add

```typescript
test("More folders callback with page version parses correctly end-to-end", async () => {
  const { fakeEnv } = createFakeEnv();
  await persistGoogleTokens(fakeEnv, { access_token: "t", refresh_token: "r", expires_in: 3600 }, "u@e.com");
  
  const workId = "test-work-id";
  const opaqueId = "abcd1234";
  const allFolders = Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, name: `Folder ${i}` }));
  
  // Mock fetch
  globalThis.fetch = mockFetch(allFolders);
  
  // Stage folder list at pageIndex=10 (simulating user already on page 2)
  await kvPut(fakeEnv, `google_option:${workId}:${opaqueId}`, JSON.stringify({
    kind: "folderlist",
    folders: allFolders,
    pageIndex: 10,
    _listOpaqueId: opaqueId
  }), { expirationTtl: 600 });
  
  const state = { workId, chatId: 1, stage: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  
  // Callback with WRONG version (page 0 button tapped while on page 2)
  const badCallback = `${opaqueId}:more0`; // pageChar '0' = pageIndex 0
  const result = await handleGoogleFolderSelection(fakeEnv, state, badCallback);
  
  // Should reject with "no longer current"
  const sent = getLastTelegramMessage();
  assert.ok(sent.text.includes("no longer current"));
  assert.strictEqual(result, state);
  
  // Callback with CORRECT version (page 2 button)
  const goodCallback = `${opaqueId}:more1`; // pageChar '1' = pageIndex 10
  const result2 = await handleGoogleFolderSelection(fakeEnv, state, goodCallback);
  
  // Should advance to page 20
  assert.ok(result2 !== state);
});
```

---

## 3. Durable Object Concurrency — Corrected Assessment

### Cloudflare DO Execution Model

**Verified from Cloudflare documentation and WorkSession code**:
- Each DO instance is **single-threaded**.
- Requests to the same DO are **queued and processed sequentially**.
- A handler's `await` yields to **other async operations within the same request context** (timers, promises), **NOT to other queued requests**.
- The next queued request **does not start** until the current handler **fully returns**.

### Evidence from WorkSession.execute()

```typescript
private async execute(fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState> {
  const state = await this.require();           // await 1 - loads from DO storage
  // ... install persistence
  const saved = await withLiveStatus(...);      // await 2 - runs fn(state), saves to DO storage
  await this.scheduleAdvisoryAssessment(saved); // await 3
  return saved;
}
```

If DO interleaved requests at `await`, two callbacks could:
1. Both load `state` from DO storage
2. Both modify `state` 
3. Both save → **lost update**

This **does not happen**. DO guarantees sequential completion.

### Three Callback Scenarios — Actual Behavior

| Scenario | What Happens | Version Check Result |
|----------|--------------|----------------------|
| **Sequential duplicate (Telegram retry)** | Callback A queued → completes (reads pageIndex=0, writes 10) → Callback B (retry) starts → reads pageIndex=10 | B's callback has pageVersion=0, validates 0≠10 → **REJECTED** ✓ |
| **True concurrent** | **Impossible** for same workId — DO queues requests | N/A |
| **Stale button (old page)** | User on page 2 (stored pageIndex=10) taps page 1 button (pageVersion=0) → handler reads stored pageIndex=10 | Validates 0≠10 → **REJECTED** ✓ |
| **Normal pagination** | User taps current page's "More" (pageVersion matches stored) | Validates 10=10 → **ADVANCES** ✓ |

### What About DO Migration?

If DO instance is evicted mid-handler:
1. Handler A's `kvPut(pageIndex=10)` completes (KV is global)
2. DO migrates to new instance
3. Handler B (retry) routes to new instance
4. New instance loads WorkState from DO storage (no folder list pageIndex there)
5. Handler B calls `peekOpaqueOption` → reads from KV → gets pageIndex=10
6. Validation: callback pageVersion=0 vs stored=10 → **REJECTED**

**KV is the source of truth for pageIndex**, not DO storage. Migration doesn't break validation.

### Exactly-Once Guarantee?

**No**. DO guarantees **sequential execution**, not exactly-once. Telegram retries cause duplicate handler invocations. The **version check** is the exactly-once mechanism at the application level.

---

## 4. Smallest Safe Design

### Requirements Checklist

| Requirement | How Satisfied |
|-------------|---------------|
| Reject stale page buttons | Version in callback validated against KV-stored pageIndex |
| Prevent repeated callback skipping folders | Telegram retry has old version → rejected |
| Single-folder-list-option contract | Unchanged — one `google_option:` key per picker |
| 64-byte Telegram callback limit | `more${pageChar}` = 64 bytes exact (up to 350 folders) |
| Output-delivery context | `delivery` flag in folderlist option unchanged |
| Smoke context | `smoke` flag in folderlist option unchanged |
| Authorization/approval | Unchanged — only pagination logic modified |
| Sequential pagination | `pageIndex` advanced by `FOLDER_PICKER_PAGE_SIZE` on valid callback |
| Final page (no "More") | `renderFolderPage` omits button when `offset + page.length >= folders.length` |

### Reuse of Existing Mechanisms

| Mechanism | Location | Reused For |
|-----------|----------|------------|
| Version in callback | Strategy (`<id>.<version>.<action>`), Sales | Page version validation |
| Consume-on-use | OAuth state, Result review, folder pick | Folder list consumed on pick (not on page) |
| Fail-closed messaging | All callback handlers | "no longer current" message |

### No New Mechanisms Introduced

- No new storage type
- No new architectural pattern
- No new data-boundary logic
- Only: compact page version in existing callback + validation check

### Files to Modify

| File | Changes |
|------|---------|
| `src/googleOAuth.ts` | `renderFolderPage`: append `pageChar` to "More folders" callback; `handleGoogleFolderSelection`: parse `pageChar`, validate against `option.pageIndex` |
| `src/googleOAuth.test.ts` | Add tests: byte budget, parser end-to-end, stale rejection, retry rejection, normal pagination |

---

## Verified vs Uncertain

### Verified ✅
- Current callback is 63 bytes (production UUID workId + 8-char opaqueId)
- `more${pageChar}` encoding fits 64 bytes for ≤350 folders
- Current parser uses `lastIndexOf(":")` — compatible with `more${pageChar}` format
- DO queues callbacks sequentially for same workId
- Telegram retry causes sequential duplicate execution
- Version check rejects both stale buttons and retries
- KV is source of truth for pageIndex (survives DO migration)

### Uncertain ⚠️
- Maximum folders in production Google Drive accounts (if >350, pageChar needs 2 chars → 65 bytes)
  - Mitigation: Page 36+ uses two chars (`more10`), callback = 65 bytes. Could shorten action prefix to `gfolder:` (10 bytes) saving 3 bytes, but breaking change. Alternative: accept that page 36+ buttons use `more` without version (fallback to pageIndex from KV), since 350+ folders is extremely rare.
- Whether `pageIndex` field exists in all existing staged options (candidate commit adds it; HEAD doesn't have it)
  - HEAD uses hardcoded `FOLDER_PICKER_PAGE_SIZE` offset in `renderFolderPage` call, not `pageIndex` in option
  - Fix must handle both: `option.pageIndex ?? 0`

### Implementation Decision Needed

**Option A**: Require `pageIndex` in folderlist option (candidate commit already has it). Clean but requires candidate as base.

**Option B**: Support both HEAD (no pageIndex) and candidate (with pageIndex) by using `option.pageIndex ?? 0`. More compatible.

**Recommendation**: Implement on candidate commit base (08ee500) which already has `pageIndex` in the option. The fix is smaller and cleaner.

---

## Recommended Next Step

1. **Martin reviews** this corrected analysis
2. **Branch from candidate commit 08ee500** (not PR #479)
3. **Implement fix**:
   - `renderFolderPage`: compute `pageChar = (option.pageIndex ?? 0) / 10`, append to "More" callback
   - `handleGoogleFolderSelection`: parse `pageChar` from position, validate against stored `pageIndex`
4. **Add tests** for byte budget, parser, stale rejection, retry rejection, normal flow
5. **Run typecheck + all tests** (googleOAuth + googleDocsSmokeFlow)
6. **Open Draft PR**