/**
 * Pure parser for a Telegram button's `callback_data`, owned by the
 * integration (index.ts reads it before dispatching a tap).
 *
 * Shape: `<action>:<workId>:<value...>`
 * - `action` is the text before the FIRST ":"
 * - `workId` is the text between the first and second ":"
 * - `value` is EVERYTHING after the second ":", keeping any further ":"
 *   (the `googlefolder` picker carries `<listOpaqueId>:<position>` there,
 *   and truncating at the third segment dropped the position entirely)
 * - missing parts are "" and the function never throws, so empty or
 *   malformed callback data stays safe to dispatch.
 *
 * Unit-free by design: no imports, so it composes with any Unit or Hat
 * without crossing a boundary.
 */
export function parseCallbackData(data: string): { action: string; workId: string; value: string } {
  const first = data.indexOf(":");
  if (first === -1) return { action: data, workId: "", value: "" };
  const second = data.indexOf(":", first + 1);
  if (second === -1) return { action: data.slice(0, first), workId: data.slice(first + 1), value: "" };
  return {
    action: data.slice(0, first),
    workId: data.slice(first + 1, second),
    value: data.slice(second + 1),
  };
}
