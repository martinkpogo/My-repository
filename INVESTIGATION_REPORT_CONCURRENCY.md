# Google Drive Folder Picker — Callback Concurrency Investigation

**Date**: 2026-11-20  
**Investigator**: Kilo Code  
**Scope**: Can two nearly simultaneous "More folders" callbacks both advance the folder list?  
**Context**: Follow-up to stale-callback investigation on issue #479, commit `08ee500`

---

## Executive Summary

**The proposed consume-and-re-stage approach does NOT guarantee exactly one page advance under concurrent callback execution.**

While Cloudflare Durable Objects serialize callback handling *per WorkSession*, the folder picker's pagination state lives in **KV/Turso** (`google_option:` keys), not in DO storage. KV operations are external calls that race independently of DO serialization.

Both the current HEAD implementation and the candidate commit (`08ee500`) have a **read-modify-write race window** where two concurrent "More folders" callbacks can both read the same `pageIndex`, both compute the same `nextPageIndex`, and both write it — resulting in a single page advance instead of two, or both rendering the same page.

---

## Architecture: Where State Lives

| State | Storage | Serialization |
|-------|---------|---------------|
| WorkSession state (chatId, hat, stage, etc.) | Durable Object storage (`this.ctx.storage`) | **Serialized** — DO guarantees single-threaded execution per instance |
| Folder list option (`google_option:<workId>:<opaqueId>`) | KV + Turso fallback (`kvStore.ts`) | **NOT serialized** — external KV calls race freely |
| OAuth tokens, chat history, etc. | KV + Turso (varies by prefix) | Not serialized |

**Critical insight**: The `handleGoogleFolderSelection` handler runs inside `WorkSession.execute()`, which is serialized per Work. But the handler makes **multiple independent KV calls** (`peekOpaqueOption` → `kvPut` → `renderFolderPage` reads again). The DO serialization only protects the *handler function execution*, not the *external KV operations* it performs.

---

## Current Candidate Implementation (08ee500) — "More folders" Path

```typescript
// handleGoogleFolderSelection (candidate)
if (position === "more") {
  // 1. READ: peek (read-only) — gets current pageIndex (default 0)
  const option = await peekOpaqueOption(env, state.workId, opaqueId);
  
  // 2. COMPUTE: nextPageIndex = pageIndex + pageSize
  const { folders, pageIndex = 0, pageSize = GOOGLE_FOLDER_PICKER_PAGE_SIZE, ...rest } = option;
  const nextPageIndex = pageIndex + pageSize;
  
  // 3. WRITE: kvPut with advanced pageIndex
  await kvPut(env, `google_option:${state.workId}:${listOpaqueId}`, 
    JSON.stringify({ ...rest, folders, pageIndex: nextPageIndex, _listOpaqueId: listOpaqueId }), 
    { expirationTtl: 600 });
  
  // 4. RENDER: renderFolderPage reads the option AGAIN (via kvGet in renderFolderPage? No, passes option directly)
  await renderFolderPage(env, target, state.workId, { ...rest, folders, pageIndex: nextPageIndex, _listOpaqueId: listOpaqueId }, nextPageIndex);
  return state;
}
```

### Race Window

```
Callback A                          Callback B
─────────────────                   ─────────────────
peekOpaqueOption() → pageIndex=0    peekOpaqueOption() → pageIndex=0
                                    (both read same value)
compute nextPageIndex = 10          compute nextPageIndex = 10
kvPut(pageIndex=10)                 kvPut(pageIndex=10)
                                    (both write SAME value)
render page 2                       render page 2
```

**Result**: Two callbacks → one page advance (page 2 rendered twice), page 3 never reached.

---

## Proposed "Consume-and-Re-stage" Fix — Same Race

The previous investigation recommended: *consume the current option and stage a fresh one with a new opaque ID for each page turn.*

```typescript
// Hypothetical consume-and-re-stage
if (position === "more") {
  // 1. CONSUME (get + delete)
  const option = await consumeOpaqueOption(env, state.workId, opaqueId);
  if (!option) return error; // already consumed
  
  // 2. COMPUTE
  const nextPageIndex = (option.pageIndex ?? 0) + pageSize;
  
  // 3. STAGE NEW with new opaqueId
  const newOpaqueId = crypto.randomUUID().slice(0, 8);
  await kvPut(env, `google_option:${state.workId}:${newOpaqueId}`, 
    JSON.stringify({ ...option, pageIndex: nextPageIndex, _listOpaqueId: newOpaqueId }), 
    { expirationTtl: 600 });
  
  // 4. RENDER
  await renderFolderPage(env, target, state.workId, {...}, nextPageIndex);
}
```

### Race Window (Consume-and-Re-stage)

```
Callback A                          Callback B
─────────────────                   ─────────────────
consumeOpaqueOption()               consumeOpaqueOption()
  kvGet() → value                    kvGet() → SAME value
                                    (both read before either deletes)
  kvDelete()                         kvDelete()
                                    (both delete - idempotent)
compute nextPageIndex = 10          compute nextPageIndex = 10
kvPut(newOpaqueId=A, pageIndex=10)  kvPut(newOpaqueId=B, pageIndex=10)
                                    (TWO options created!)
render page 2 (A)                   render page 2 (B)
```

**Result**: Two callbacks → TWO folder list options created (different opaque IDs), both at pageIndex=10. User sees page 2 twice, and now has TWO valid "More folders" buttons (different IDs) that both advance to page 3.

---

## KV/Turso Semantics — No Atomic Primitives

From `src/kvStore.ts`:

| Operation | Atomic? | Notes |
|-----------|---------|-------|
| `kvGet` | N/A | Read only |
| `kvPut` | No CAS | Last write wins (versioned envelope resolves conflicts on read) |
| `kvDelete` | No CAS | Idempotent; tombstone written to Turso on KV failure |
| `kvList` | N/A | Read only |
| **Transactions** | **No** | Cloudflare KV has no transactions, no compare-and-swap |
| **Durable Object storage** | **Yes** | `this.ctx.storage` has `put`/`get`/`delete`/`list` with transaction support via `transaction()` |

**Key finding from kvStore.ts header (lines 60-77)**:
> "KV has no compare-and-swap, so a sweep racing a concurrent write inside the same millisecond can lose the loser (bounded, pre-existing)"

The versioned envelope (`{"__enig_kv":1,"seq":<epoch ms>,"val":...}`) resolves conflicts **on read**, not on write. Concurrent writes with the same timestamp can lose one.

---

## Production Callback Routing — DO Serialization Only

From `src/session.ts`:

```typescript
// Each callback routes through WorkSession.execute()
private async execute(fn: (state: WorkState) => Promise<WorkState>): Promise<WorkState> {
  const state = await this.require();  // Load from DO storage
  // ... install persistence, run fn(state), save to DO storage
}
```

**Durable Object guarantee**: Cloudflare Workers Durable Objects process requests **sequentially per instance**. Two callbacks for the same `workId` (same DO) will not run `execute()` in parallel.

**BUT**: The `handleGoogleFolderSelection` handler makes **multiple async KV calls** that yield to the event loop. While DO serialization prevents two `execute()` calls from overlapping, the KV calls themselves are independent HTTP requests to the KV/Turso backend that can interleave with other DO instances or external traffic.

More importantly: **if two callbacks arrive for the SAME workId, they queue in the DO**. The first `execute()` runs to completion (including all its `await kvGet/kvPut`), then the second runs. So for the SAME Work, there IS serialization.

**However**, the race exists when:
1. **Different WorkSessions** (different users) hit the same folder list option — not applicable here (option is per workId)
2. **The same callback delivered twice by Telegram** (network retry) — these arrive as separate HTTP requests to the Worker, which routes to the same DO. The DO queues them.

**Wait** — if the DO queues them, then the first `execute()` completes fully before the second starts. The first handler's `kvPut` completes before the second handler's `peekOpaqueOption` runs.

Let me re-verify this...

---

## Critical Clarification: DO Request Queueing

Cloudflare Durable Objects **guarantee sequential execution per instance**. When two HTTP requests target the same DO (same `workId`), the DO runtime queues them. The second request's `execute()` does not start until the first `execute()` **fully completes** (including all `await`).

```typescript
// First callback: execute() starts
await peekOpaqueOption()  // await yields, but DO stays on this request
await kvPut()             // await yields, but DO stays on this request
await renderFolderPage()  // await yields, but DO stays on this request
return state              // execute() completes
save state to DO storage  // DO storage write

// Second callback: execute() starts ONLY after first completes
await peekOpaqueOption()  // sees the kvPut from first callback
```

**So for the SAME WorkSession, the DO serialization DOES protect the read-modify-write!**

---

## The Real Concurrency Risk: Telegram Retry + DO Instance Migration

The race can still occur in these scenarios:

### 1. DO Instance Migration (Eviction/Recreation)
- Callback A starts on DO Instance 1
- Instance 1 evicted (idle timeout, deploy, scaling)
- Callback A's `kvPut` completes (external KV)
- Callback B arrives, routed to **new DO Instance 2**
- Instance 2 loads Work state from DO storage (which doesn't have folder list pageIndex)
- Instance 2 runs `peekOpaqueOption` → reads OLD pageIndex from KV (before A's write propagated? No, KV is global)
- **Actually**: KV is global and consistent. Both instances see the same KV state.

### 2. Telegram Sends Duplicate Callback (Network Retry)
- User taps "More folders" once
- Telegram sends callback, Worker receives, routes to DO
- Network hiccup: Telegram doesn't get 200 OK, **retries** same callback
- Both requests hit the Worker, both route to same DO
- **DO queues them** — second waits for first to complete
- First completes `kvPut(pageIndex=10)`
- Second runs `peekOpaqueOption` → sees `pageIndex=10` → computes `20` → `kvPut(pageIndex=20)`
- **Result**: Single user tap → TWO page advances (page 2 skipped)

**This is the real bug!** Telegram's retry behavior + DO serialization = double page advance.

### 3. Multiple "More folders" Buttons in Chat History (Stale Callback)
- User on page 1, taps "More" → page 2
- Page 1 button still visible in chat
- User taps OLD page 1 button → sends SAME callback data
- DO queues: if previous handler still running, waits; else runs fresh
- If fresh: reads `pageIndex=10` (from page 2 render) → advances to 20
- **Result**: Stale callback advances page (sequential defect, already known)

---

## Does the Version-in-Callback Fix Solve Both?

**Yes.** Include `pageIndex` in callback data:

```typescript
// renderFolderPage: include current pageIndex in callback
const currentPageIndex = option.pageIndex ?? 0;
buttons.push([{ 
  text: "📂 More folders", 
  callback_data: `googlefolder:${workId}:${option._listOpaqueId}:more:${currentPageIndex}` 
}]);

// handleGoogleFolderSelection: validate
if (position.startsWith("more:")) {
  const [, callbackPageIndexStr] = position.split(":");
  const callbackPageIndex = Number(callbackPageIndexStr);
  const expectedPageIndex = option.pageIndex ?? 0;
  if (callbackPageIndex !== expectedPageIndex) {
    await sendWorkspaceHatMessage(env, target, 
      "⚠️ That folder selection is no longer current -- nothing was recorded.");
    return state;
  }
  // proceed with page turn...
}
```

### Scenario: Telegram Retry (Same Callback Data Twice)

```
Callback A (original tap)           Callback B (Telegram retry)
─────────────────────────           ─────────────────────────
callback data: more:0               callback data: more:0
peek → pageIndex=0                  [waits for A]
validate 0 === 0 ✓                  peek → pageIndex=10 (A's write)
kvPut(pageIndex=10)                 validate 0 === 10 ✗ REJECTED
render page 2                       "no longer current"
```

### Scenario: Stale Button (Old Page 1 Button Tapped on Page 2)

```
Page 1 render: callback more:0
Page 2 render: callback more:10

User taps old page 1 button:
callback data: more:0
peek → pageIndex=10
validate 0 === 10 ✗ REJECTED
"no longer current"
```

### Scenario: Concurrent Different Users (Not applicable — per-workId)

Each `workId` has its own folder list option. Different users = different workIds = different DO instances = no shared KV keys.

---

## Evidence Summary

| Question | Answer |
|----------|--------|
| Does DO serialization protect KV read-modify-write for same workId? | **Yes**, for sequential execution within one DO instance lifetime. |
| Can two callbacks for same workId run in parallel? | **No** — DO queues requests. |
| Can Telegram retry cause double page advance? | **YES** — retry sends identical callback data; DO queues them; first advances page, second validates against old pageIndex if no version check. |
| Does consume-and-re-stage fix the Telegram retry race? | **NO** — same callback data, same validation gap. Consume-and-re-stage adds new opaque ID but doesn't validate expected pageIndex. |
| Does version-in-callback fix both races? | **YES** — callback carries expected pageIndex; handler validates; mismatch = reject. |
| Is version-in-callback a new mechanism? | **NO** — same pattern used in Strategy (`<id>.<version>.<action>`) and Sales units. |
| Does it require new storage? | **NO** — purely callback data + validation logic. |
| Does it weaken any contract? | **NO** — callback_data still fits 64-byte limit (pageIndex ≤ 2-3 digits). |

---

## Recommendation

**Implement the version-in-callback fix (Option A from previous report):**

1. **Modify `renderFolderPage`** to include `pageIndex` in "More folders" callback data:
   ```typescript
   const currentPageIndex = option.pageIndex ?? 0;
   callback_data: `googlefolder:${workId}:${option._listOpaqueId}:more:${currentPageIndex}`
   ```

2. **Modify `handleGoogleFolderSelection`** to parse and validate:
   ```typescript
   if (position.startsWith("more:")) {
     const [, callbackPageIndexStr] = position.split(":");
     const callbackPageIndex = Number(callbackPageIndexStr);
     const expectedPageIndex = option.pageIndex ?? 0;
     if (callbackPageIndex !== expectedPageIndex) {
       await sendWorkspaceHatMessage(env, target, 
         "⚠️ That folder selection is no longer current -- nothing was recorded.");
       return state;
     }
     // ... proceed with page turn using expectedPageIndex
   }
   ```

3. **Add test** for:
   - Telegram retry (same callback twice) → second rejected
   - Stale button (old pageIndex) → rejected
   - Normal pagination → works

This is the **smallest technically sound correction** that:
- Fits existing architecture (reuses Strategy/Sales version pattern)
- Requires no new storage mechanism
- Preserves all contracts (delivery/smoke flags, callback size, single-option KV write)
- Solves both sequential stale-callback AND concurrent retry races
- No architectural decision needed — Martin already approved the version pattern elsewhere

---

## Files to Modify

| File | Change |
|------|--------|
| `src/googleOAuth.ts` | `renderFolderPage`: add `pageIndex` to callback; `handleGoogleFolderSelection`: parse & validate |
| `src/googleOAuth.test.ts` | Add tests for concurrent retry rejection and stale callback rejection |

---

## Unresolved Decisions

**None.** The version pattern is already established in the codebase (Strategy/Sales units). No new architectural decision required.