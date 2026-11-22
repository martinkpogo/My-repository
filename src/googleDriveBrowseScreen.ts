/**
 * One screen of the Telegram Drive file browser, stored as a single KV record
 * under `google_option:<workId>:<screenId>`, plus the short code each button
 * carries: `googlefolder:<workId>:<screenId>:<code>`.
 *
 * Telegram buttons carry only 64 bytes, so a screen's details live in ONE
 * stored record and each button carries only a short code pointing into it.
 * Nothing in production consumes these yet -- the folder picker wires them up
 * in a later task.
 *
 * This module uses kvPut/kvGet (not saveOpaqueOption from googleOAuth.ts):
 * googleOAuth.ts imports this module in a later step, and importing it back
 * would be a circular import. The `google_option:` key family keeps the
 * existing storage-fallback behaviour of src/kvStore.ts (Section 5B).
 *
 * Imports are deliberately limited to ./kvStore, ./googleDriveBrowse (type
 * only) and ./types (type only).
 */

import type { DriveItem } from "./googleDriveBrowse";
import type { Env } from "./types";
import { kvGet, kvPut } from "./kvStore";

export interface BrowseScreen {
  kind: "drivebrowse";
  folderId: string; // real Drive folder id shown on this screen
  folderName: string; // e.g. "My Drive" at the top level
  parentScreenId?: string; // screen that "Back" returns to; absent at top
  items: DriveItem[];
  truncated: boolean;
  context: Record<string, unknown>; // the flow's own data; stored and returned
  // UNCHANGED, never interpreted
}

export type BrowseAction =
  | { type: "open"; index: number } // code "o<index>" -- open a folder
  | { type: "file"; index: number } // code "f<index>" -- tap a file
  | { type: "save" } // code "s"
  | { type: "back" }; // code "b"

const SCREEN_ID_PATTERN = /^[a-f0-9]{8}$/;
// Index 0-999 with no leading zeros: "0" or [1-9][0-9]{0,2} ("o0" ok,
// "o07" rejected).
const INDEX_PATTERN = /^(0|[1-9][0-9]{0,2})$/;

const CALLBACK_ACTION = "googlefolder";
const SCREEN_TTL_SECONDS = 1800;
const MAX_CALLBACK_BYTES = 64;

export async function saveBrowseScreen(
  env: Env,
  workId: string,
  screen: BrowseScreen,
): Promise<{ ok: true; screenId: string } | { ok: false }> {
  const screenId = crypto.randomUUID().slice(0, 8); // 8 lowercase hex chars
  const key = `google_option:${workId}:${screenId}`;
  try {
    // Browser screens expire after 30 minutes.
    await kvPut(env, key, JSON.stringify(screen), {
      expirationTtl: SCREEN_TTL_SECONDS,
    });
    return { ok: true, screenId };
  } catch {
    // kvPut throws -> { ok: false }. Never throw.
    return { ok: false };
  }
}

export async function readBrowseScreen(
  env: Env,
  workId: string,
  screenId: string,
): Promise<BrowseScreen | null> {
  // An invalid screenId fails without reading anything.
  if (!SCREEN_ID_PATTERN.test(screenId)) return null;

  const key = `google_option:${workId}:${screenId}`;
  let raw: string | null;
  try {
    raw = await kvGet(env, key);
  } catch {
    // A kvGet that throws -> null. Never throw.
    return null;
  }
  return decodeScreen(raw);
}

function decodeScreen(raw: string | null): BrowseScreen | null {
  if (raw === null) return null; // missing key
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // unparseable
  }
  return isBrowseScreen(parsed) ? parsed : null;
}

function isDriveItem(value: unknown): value is DriveItem {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.kind === "folder" || item.kind === "file") &&
    typeof item.mimeType === "string" &&
    (item.webViewLink === undefined || typeof item.webViewLink === "string")
  );
}

function isBrowseScreen(value: unknown): value is BrowseScreen {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  if (s.kind !== "drivebrowse") return false;
  if (typeof s.folderId !== "string") return false;
  if (typeof s.folderName !== "string") return false;
  if (s.parentScreenId !== undefined && typeof s.parentScreenId !== "string")
    return false;
  if (!Array.isArray(s.items) || !s.items.every(isDriveItem)) return false;
  if (typeof s.truncated !== "boolean") return false;
  if (
    s.context === null ||
    typeof s.context !== "object" ||
    Array.isArray(s.context)
  )
    return false;
  return true;
}

export function buildBrowseCallback(
  workId: string,
  screenId: string,
  action: BrowseAction,
): string | null {
  let code: string;
  if (action.type === "open" || action.type === "file") {
    const index = action.index;
    if (!Number.isInteger(index) || index < 0 || index > 999) return null;
    // String(index) of an in-range integer is canonical (no leading zeros),
    // so the produced code always parses back.
    code = `${action.type === "open" ? "o" : "f"}${index}`;
  } else {
    code = action.type === "save" ? "s" : "b";
  }

  const value = `${CALLBACK_ACTION}:${workId}:${screenId}:${code}`;
  if (new TextEncoder().encode(value).length > MAX_CALLBACK_BYTES) return null;
  return value;
}

export function parseBrowseValue(
  value: string,
): { screenId: string; action: BrowseAction } | null {
  // "<screenId>:<code>" -- exactly two segments (codes never contain ":").
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const [screenId, code] = parts;
  if (!SCREEN_ID_PATTERN.test(screenId)) return null;

  if (code === "s") return { screenId, action: { type: "save" } };
  if (code === "b") return { screenId, action: { type: "back" } };

  const letter = code[0];
  const rest = code.slice(1);
  if (letter !== "o" && letter !== "f") return null;
  if (!INDEX_PATTERN.test(rest)) return null;
  return {
    screenId,
    action: {
      type: letter === "o" ? "open" : "file",
      index: Number(rest), // 0-999, guaranteed by INDEX_PATTERN
    },
  };
}
