/**
 * SHA-256 of a text, as lowercase hex. Shared by the Proposal content/version
 * hashes (units/sales/tokenSafeProposal.ts) and the Call Notes approval
 * marker (records/callNotes/callNotesMarker.ts), so neither depends on the
 * other. Moved verbatim from tokenSafeProposal.ts.
 */
export async function hashContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
