/**
 * Locates a `${startMarker} ... ${endMarker}` block within `text` and
 * returns its inner content (trimmed), or null if the markers aren't both
 * present in order.
 *
 * The shared extraction primitive every downstream consumer of a labeled
 * boundary block uses -- Finance, to carry the Strategy block forward
 * verbatim without re-authoring it; Sales, to parse both the Strategy and
 * Finance blocks out of the combined Finance -> Sales Handoff; Strategy and
 * Finance, to read the Commercial Value Evidence block Sales authored -- one
 * matching implementation, not one per caller.
 *
 * Deliberately home-neutral (src/, not under any Unit): it is a pure string
 * primitive that Units on both sides of a boundary need, and placing it
 * inside a Unit's module would make every cross-Unit block read an import
 * cycle. strategyAnalyst.ts re-exports it under its established import path.
 */
export function extractLabeledBlock(text: string, startMarker: string, endMarker: string): string | null {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const contentStart = startIdx + startMarker.length;
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx === -1) return null;
  return text.slice(contentStart, endIdx).trim();
}
