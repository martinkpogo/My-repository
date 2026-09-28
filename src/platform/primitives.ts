import type { Env, Unit, WorkState } from "../types";
import type { SemanticTaskId, SensitivityLevel } from "../dataBoundary/types";
import { queryDataSource, updatePage, type NotionPage, type NotionProperties } from "../notion";
import { createHandoff, updateHandoff, type HandoffIdentity } from "../handoffWriter";
import { getGovernance } from "../governance";
import { aiJson, aiChat, aiText, type ChatTurn } from "../ai";
import { searchWeb, isWebSearchConfigured, type WebSearchResult } from "../units/research/webSearch";
import { sendHatMessage, type InlineButton } from "../telegram";
import { canRead, canWrite, resolveDataSourceEnvId, type DataSourceId } from "./dataSourceRegistry";
import { getSkill, type SkillId } from "./skillRegistry";

/**
 * The Action Catalog's primitive functions (ENIG Operating Model design
 * doc, "Platform layer" -- Stage 1 of the confirmed build order). Six
 * shared, generic functions -- never Unit-owned -- that any Hat's own
 * pipeline function composes as its task requires. See the design doc's
 * own worked reasoning for why these six and not more or fewer: split
 * into a separate primitive only where governance/boundary treatment
 * genuinely differs (search vs. read_record), never for a merely
 * conceptual distinction (generate does not split by output shape;
 * write_record does not split into create/update).
 *
 * These are ordinary, deterministic functions -- composed in ordinary
 * TypeScript pipeline code written once per Hat, never by a live,
 * dynamic model loop deciding the sequence at runtime (considered and
 * explicitly rejected -- see the design doc).
 */

// ---------------------------------------------------------------------------
// read_record
// ---------------------------------------------------------------------------

/**
 * Fetches records from a registered Data Source. Fails closed if the
 * calling Unit isn't declared readable for this source in the Data
 * Source Registry -- an access problem must be a loud, visible error,
 * never a silently empty result indistinguishable from "nothing found."
 */
export async function readRecord(
  env: Env,
  callingUnit: Unit,
  source: DataSourceId,
  filter?: Record<string, unknown>,
  options?: { pageSize?: number; sortByCreatedDescending?: boolean },
): Promise<NotionPage[]> {
  if (!canRead(source, callingUnit)) {
    throw new Error(`read_record: ${callingUnit} is not declared readable for data source "${source}" in the Data Source Registry.`);
  }
  const dataSourceId = resolveDataSourceEnvId(env, source);
  return queryDataSource(env, dataSourceId, filter, {
    pageSize: options?.pageSize ?? 20,
    sortByCreatedDescending: options?.sortByCreatedDescending ?? true,
  });
}

// ---------------------------------------------------------------------------
// fetch_skill
// ---------------------------------------------------------------------------

/**
 * Loads a registered Skill's governance/methodology content, through the
 * existing `getGovernance` (live-fetched, cached, fail-closed). Kept
 * distinct from read_record because Skills are Architect-authored
 * governance content with different outbound-leak-detector treatment
 * (see governance.ts's GOVERNANCE_CONTENT_START/END wrapping) than
 * ordinary business data.
 */
export async function fetchSkill(env: Env, skillId: SkillId): Promise<string> {
  const skill = getSkill(skillId);
  const content = await getGovernance(env, skill.pageId, skill.id);
  if (!content) {
    throw new Error(`fetch_skill: "${skillId}" could not be retrieved -- cache and live fetch both failed, or the page came back empty.`);
  }
  return content;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/**
 * External web search (Tavily). Kept distinct from read_record because
 * the trust/provider-eligibility profile genuinely differs -- an
 * untrusted external source, not our own governed, tokenized data.
 * Never throws on a provider hiccup (matches searchWeb's own contract);
 * throws only if search isn't configured at all, since that is a
 * pipeline-authoring mistake (calling search where none is available),
 * not a transient condition to swallow silently.
 */
export async function search(env: Env, query: string): Promise<WebSearchResult[]> {
  if (!isWebSearchConfigured(env)) {
    throw new Error("search: web search isn't configured (TAVILY_API_KEY unset).");
  }
  return searchWeb(env, query);
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

/**
 * The pieces `generate` assembles into one prompt automatically, so no
 * pipeline hand-writes a full role+context+instruction+behavior+
 * situation+example prompt itself (see the design doc's "How generate
 * assembles a prompt"):
 *   - persona    -> Role: the Hat's own voice/authority framing
 *   - behavior   -> Behavior: cross-cutting rules for every persona
 *     (typically fetchSkill("universal_role_contract")'s own content,
 *     fetched once by the caller so pipelines control their own
 *     caching/reuse -- generate() does not fetch it again itself)
 *   - skillContent -> Instruction (+ Example, if the skill's own content
 *     includes worked examples)
 *   - context    -> Context: whatever this pipeline's read_record/search
 *     calls actually pulled in for this task
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
  /** This use's own registered SemanticTaskId -- resolved per actual call, never once for the whole primitive (see the design doc's "What never changes"). */
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
 * One primitive regardless of output shape (json classification vs.
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

// ---------------------------------------------------------------------------
// request_approval
// ---------------------------------------------------------------------------

export interface RequestApprovalOptions {
  state: WorkState;
  label: string;
  message: string;
  buttons: InlineButton[][];
  /** The WorkState.awaiting key this pipeline resumes on when Martin responds -- the Hat's own registered awaitingHandler (unitManifest.ts) picks this up, the same generic mechanism every existing approval flow already uses. */
  awaiting: WorkState["awaiting"];
}

/**
 * request_approval -- presents output for Martin's Approve/Refine/Reject
 * and pauses. Deliberately not folded into write_record as an implicit
 * side effect -- see the design doc's own reasoning (a pipeline can
 * request approval once and then write several records, or draft-then-
 * approve before ever attempting a write, and the privileged step stays
 * directly testable in isolation).
 *
 * Cannot itself "return" the eventual decision: Cloudflare Workers is
 * request-scoped, and Martin's response arrives in a genuinely separate,
 * later Telegram callback invocation. This primitive performs the
 * "propose and pause" half only -- sends the message to wherever this
 * WorkState's conversation actually is (state.chatId/threadId, correct
 * for both Chat- and Cowork-originated sessions alike, never forced to
 * the Workspace stream the way resolveUnitRequest's own
 * sendWorkspaceHatMessage forces Cowork's replies), and persists
 * pendingActionSummary + the awaiting marker. Resuming when Martin
 * responds is the Hat's own registered awaitingHandler -- this
 * standardizes the send-and-pause half of a pattern every existing
 * approval flow already hand-implements (e.g. strategyAnalyst.ts's
 * handleStrategyHandoffApproval pairing), it does not invent new
 * resumable-execution machinery.
 */
export async function requestApproval(env: Env, options: RequestApprovalOptions): Promise<void> {
  const { state, label, message, buttons, awaiting } = options;
  await sendHatMessage(env, { chatId: state.chatId, threadId: state.threadId, hat: state.hat, workId: state.workId }, message, buttons);
  state.pendingActionSummary = { label, message, buttons, createdAt: new Date().toISOString() };
  state.awaiting = awaiting;
}

// ---------------------------------------------------------------------------
// write_record
// ---------------------------------------------------------------------------

export interface WriteRecordArgs {
  /** Omit to create a new record (Handoffs only -- every other source updates an existing record). */
  id?: string;
  properties: NotionProperties;
  /** Required only when source is "handoffs" -- see handoffWriter.ts's HandoffIdentity. */
  identity?: HandoffIdentity;
}

/**
 * write_record -- persist an outcome to a registered Data Source. Fails
 * closed if the calling Unit isn't declared writable for this source.
 * Handoffs specifically are routed through handoffWriter.ts's
 * createHandoff/updateHandoff -- never a plain field update -- enforced
 * here so no pipeline can bypass the Entity_Token/Matter_Token-only
 * identity boundary by mistake.
 */
export async function writeRecord(env: Env, callingUnit: Unit, source: DataSourceId, args: WriteRecordArgs): Promise<NotionPage> {
  if (!canWrite(source, callingUnit)) {
    throw new Error(`write_record: ${callingUnit} is not declared writable for data source "${source}" in the Data Source Registry.`);
  }
  if (source === "handoffs") {
    if (!args.identity) {
      throw new Error('write_record: writing to "handoffs" requires identity (Entity_Token/Matter_Token) -- see handoffWriter.ts\'s HandoffIdentity.');
    }
    if (args.id) {
      return updateHandoff(env, args.id, args.properties, args.identity);
    }
    const { page } = await createHandoff(env, args.properties, args.identity);
    return page;
  }
  if (!args.id) {
    throw new Error(`write_record: "${source}" requires an existing record id -- this primitive updates records; only Handoffs may be created through it.`);
  }
  return updatePage(env, args.id, args.properties);
}
