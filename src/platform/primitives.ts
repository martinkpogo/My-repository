import type { Env } from "../types";
import type { SemanticTaskId, SensitivityLevel } from "../dataBoundary/types";
import { aiJson, aiChat, aiText, type ChatTurn } from "../ai";

/**
 * `generate` -- the sole surviving primitive from the retired six-primitive
 * Action Catalog model (ENIG Operating Model, "Platform layer" -- superseded
 * 2026-09-28 by the Kernel/Applications/Capabilities/Runtime Services
 * architecture; see docs/enig-operating-model.md). `readRecord`,
 * `fetchSkill` (the Notion-backed version), `search`, `requestApproval`, and
 * `writeRecord` have been removed outright -- confirmed by inspection before
 * this migration to have zero production callers (their real work already
 * happens directly against `queryDataSource`/`updatePage`/`handoffWriter.ts`,
 * `searchWeb`, and each Hat's own hand-written propose/approve pair). `generate`
 * remains as a convenience prompt-assembly wrapper only -- it is not Kernel
 * architecture, and it was never the boundary that enforces anything: the
 * real, verified-by-trace boundary is `AiPolicyExecutor.executeTask`, reached
 * identically whether a caller goes through `generate` or calls
 * `aiJson`/`aiChat`/`aiText` directly.
 *
 * Skill content is now supplied by callers via `skillRegistry.ts`'s
 * `getSkillContent` (a synchronous, repo-native lookup) rather than the
 * retired `fetchSkill`/`getGovernance` Notion round trip -- `generate` itself
 * is unaffected by that change, since it only ever consumed
 * `parts.skillContent` as a plain string.
 */

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

/**
 * The pieces `generate` assembles into one prompt automatically, so no
 * pipeline hand-writes a full role+context+instruction+behavior+
 * situation+example prompt itself:
 *   - persona    -> Role: the Hat's own voice/authority framing
 *   - behavior   -> Behavior: cross-cutting rules for every persona
 *     (typically the Universal Role Contract's own content, fetched once by
 *     the caller via getGovernance so pipelines control their own
 *     caching/reuse -- generate() does not fetch it again itself)
 *   - skillContent -> Instruction (+ Example, if the skill's own content
 *     includes worked examples)
 *   - context    -> Context: whatever this pipeline actually pulled in for
 *     this task
 *   - situation  -> Situation: the actual request/task text
 */
export interface GeneratePromptParts {
  persona: string;
  behavior?: string;
  skillContent?: string;
  context?: string;
  situation: string;
}

interface BaseGenerateOptions {
  /** This use's own registered SemanticTaskId -- resolved per actual call. */
  taskId: SemanticTaskId;
  parts: GeneratePromptParts;
  history?: ChatTurn[];
  sensitivity?: SensitivityLevel;
  light?: boolean;
  maxTokens?: number;
}

function assembleSystemPrompt(parts: GeneratePromptParts): string {
  return [parts.persona, parts.behavior, parts.skillContent, parts.context].filter((s): s is string => Boolean(s && s.trim())).join("\n\n");
}

/**
 * generate -- call the model with an assembled prompt, get output back.
 * One function regardless of output shape (json classification vs.
 * free-text draft) -- both get identical Data Boundary/Outbound Gate
 * treatment, so TypeScript overloads keep this one exported function
 * name while still typing each call site's return correctly.
 */
export async function generate<T = Record<string, unknown>>(env: Env, options: BaseGenerateOptions & { mode: "json" }): Promise<T | null>;
export async function generate(env: Env, options: BaseGenerateOptions & { mode: "text" }): Promise<string>;
export async function generate(env: Env, options: BaseGenerateOptions & { mode: "json" | "text" }): Promise<unknown> {
  const system = assembleSystemPrompt(options.parts);
  const situation = options.parts.situation;
  if (options.mode === "json") {
    return aiJson(env, { taskId: options.taskId, system, user: situation, light: options.light, maxTokens: options.maxTokens });
  }
  if (options.history) {
    return aiChat(env, options.taskId, system, options.history, situation, options.maxTokens ?? 800, options.sensitivity);
  }
  return aiText(env, options.taskId, system, situation, { light: options.light, maxTokens: options.maxTokens });
}
