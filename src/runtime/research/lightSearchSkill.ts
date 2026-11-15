import { resolveRuntimeSkill } from "../actionSkills";

/**
 * Reads one section of the Light Search Skill by its exact id (Research
 * Runtime decision, 15 Nov 2026): the research METHOD lives in the Skill;
 * this runtime only assembles it with the machinery parts of each prompt --
 * the identity boundary, what web access the model has, and the response
 * formats. Resolved through the Skill Registry like every Skill; a missing
 * section throws (fails closed), never degrading to "no methodology".
 */
export function lightSearchSection(id: string): string {
  const content = resolveRuntimeSkill("light_search").content;
  const marker = `## ${id}\n\n`;
  const start = content.indexOf(marker);
  if (start === -1) throw new Error(`light_search Skill has no "${id}" section`);
  const from = start + marker.length;
  const next = content.indexOf("\n\n## ", from);
  return (next === -1 ? content.slice(from) : content.slice(from, next)).replace(/\n+$/, "");
}
