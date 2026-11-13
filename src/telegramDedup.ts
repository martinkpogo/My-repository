import type { Env } from "./types";
import { kvGet, kvPut } from "./kvStore";

const SEEN_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * Telegram redelivers an update it gets no timely answer for, and a run that
 * researches online can take longer than Telegram waits -- so one button tap
 * once arrived twice and ran twice (2026-11-13: two Digital Marketer drafts).
 * Claims an update by its update_id: true the first time, false for every
 * redelivery. A KV failure fails open (processes), never drops an update.
 */
export async function claimTelegramUpdate(env: Env, updateId: unknown): Promise<boolean> {
  if (typeof updateId !== "number") return true;
  const key = `tg_update:${updateId}`;
  try {
    if (await kvGet(env, key)) return false;
  } catch (err) {
    console.error("telegram: could not check update_id (processing anyway)", err);
    return true;
  }
  await kvPut(env, key, "1", { expirationTtl: SEEN_TTL_SECONDS }).catch((err) => console.error("telegram: could not record update_id (processing anyway)", err));
  return true;
}
