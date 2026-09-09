import type { Env } from "./types";

export interface ReadAiPayload {
  session_id: string;
  trigger: string;
  title?: string;
  summary?: string;
  action_items?: { text: string }[];
  key_questions?: { text: string }[];
  transcript?: {
    speaker_blocks?: { speaker?: { name?: string }; words?: string }[];
  };
  report_url?: string;
  request_id?: string;
}

/**
 * Read.ai signs webhook bodies with HMAC-SHA256 over the raw request body,
 * using the base64-decoded signing key shown when the webhook was created.
 * The signature arrives hex-encoded in X-Read-Signature.
 */
export async function verifyReadAiSignature(
  env: Env,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !env.READAI_WEBHOOK_SECRET) return false;
  const keyBytes = base64ToBytes(env.READAI_WEBHOOK_SECRET);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHex = bytesToHex(new Uint8Array(sigBytes));
  return timingSafeEqualHex(computedHex, signatureHeader);
}

export function formatCallNotesFromPayload(payload: ReadAiPayload): string {
  const parts: string[] = [];
  if (payload.title) parts.push(`Meeting: ${payload.title}`);
  if (payload.summary) parts.push(`Summary: ${payload.summary}`);
  if (payload.key_questions?.length) {
    parts.push(`Key questions:\n${payload.key_questions.map((q) => `- ${q.text}`).join("\n")}`);
  }
  if (payload.action_items?.length) {
    parts.push(`Action items:\n${payload.action_items.map((a) => `- ${a.text}`).join("\n")}`);
  }
  const blocks = payload.transcript?.speaker_blocks ?? [];
  if (blocks.length) {
    const transcriptText = blocks
      .map((b) => `${b.speaker?.name ?? "Unknown"}: ${b.words ?? ""}`)
      .join("\n")
      .slice(0, 4000);
    parts.push(`Transcript excerpt:\n${transcriptText}`);
  }
  return parts.join("\n\n");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
