import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../types";
import type { AccessContext } from "../access";
import { deleteMessage, editMessageText, sendMessage } from "../telegram";
import { setSkillStageListener, type SkillStage } from "../platform/skillRegistry";

/**
 * Universal live status (Martin's decision, 2026-11-11): every run the
 * Runtime does -- any Work, any Hat, any Handoff pickup, any conversation --
 * shows Martin what it is doing right now, without per-Hat code.
 *
 * How: a run is opened at the few places every run passes through
 * (WorkSession.execute, the chat turns, Chat-mode read Actions), and the
 * shared chokepoints every run already uses report steps into it: Notion
 * reads and writes (src/notion.ts), AI calls (src/ai/policy.ts), Tool
 * invocations (src/runtime/toolRegistry.ts), the Skill stages
 * (src/platform/skillRegistry.ts reports through the listener registered at
 * the bottom of this file -- the edge points this way on purpose so the
 * Registry never imports this module), web search (src/runtime/research/
 * webSearch.ts) and the research review stage (src/runtime/research/
 * executor.ts). Code outside a run reports into nothing. A run is carried by
 * AsyncLocalStorage, so concurrent requests never see each other's run.
 *
 * What Martin sees: one message in the run's own chat/topic, edited in place
 *   🧭 <header>
 *   ✓ Reading Payments ×2
 *   ⏳ Writing Payments
 * ending with ⏸ (waiting for his approval or reply) or ⛔ (stopped, the
 * step marked ✗). A run that succeeds DELETES its message (Martin's choice
 * (b)): the result stays in the topic and the trail is in the Activity Log.
 *
 * The rules this module keeps:
 *   - Honest: a step is recorded only when the chokepoint actually starts it.
 *     Labels come from fixed maps (a governed source's name, a registered AI
 *     task's name, a registered Tool operation id) -- never a page title,
 *     record content, client text or model output. One approved exception
 *     (Martin, 2026-11-13): a finished web search names the public site of
 *     its top result, domain only ("Searching the web — trade.gov").
 *   - Always shown (Martin, 2026-11-11, replacing the earlier 2-second
 *     quiet period): the message is sent at the run's first real step,
 *     however short the run is. A run that reports no step sends nothing.
 *     There is deliberately no start timer: inside a Worker the clock only
 *     advances on I/O, so a timer-plus-clock check could see "not yet" and
 *     never send (the bug that hid the first deployment).
 *   - Within budget: every send/edit/delete is a Worker subrequest sharing
 *     the run's budget with Notion and AI calls (HO-86, 2026-10-08). A run
 *     makes at most 1 send + MAX_EDITS edits + 1 final edit or delete, and
 *     edits at most once every EDIT_INTERVAL_MS.
 *   - Never blocking: a failed Telegram call is logged and the run carries on.
 *   - One message per run: where a Hat already reports its own named steps
 *     (src/runtime/workStatus.ts), this run stays silent and feeds those
 *     steps a detail line instead of opening a second message.
 */

export const EDIT_INTERVAL_MS = 1000;
export const MAX_EDITS = 6;

export type LiveStatusOutcome = "succeeded" | "waiting" | "failed";

export interface LiveStatusTarget {
  chatId: number;
  threadId?: number;
  /** "<Hat or Unit> — <token>", already identity-free. */
  header: string;
}

export interface Step {
  label: string;
  count: number;
}

/** The handle a Hat's own named status uses to receive this run's current step as a detail line. */
export interface LiveStatusDetailSink {
  hatStatusOpen(): boolean;
  setDetail(detail: string | undefined): void;
  /** A pending step finished: one occurrence of `pending` becomes `final` (see resolveLiveStep). */
  resolveDetail?(pending: string, final: string): void;
  refresh(): Promise<void>;
}

/**
 * What else a run carries for the Runtime services that work per run (the
 * universal web research tool, src/runtime/webResearch.ts): the run's own
 * Access context, its web-lookup count and ceiling, and hooks run once the
 * run's status has ended. One run context, so a run is opened in one place.
 */
export interface RunExtras {
  /**
   * The run's Access context -- or a function giving it at the moment of
   * use. A Work passes a function because its Hat can be resolved during the
   * run (Marketing's intake picks the Hat after the run opens); a context
   * captured at the start named no real Hat and every search under it was
   * refused (2026-11-13).
   */
  access?: AccessContext | (() => AccessContext);
}

class LiveStatusRun {
  private readonly accessSource: AccessContext | (() => AccessContext) | undefined;
  get access(): AccessContext | undefined {
    return typeof this.accessSource === "function" ? this.accessSource() : this.accessSource;
  }
  searches = 0;
  searchLimit = 0;
  readonly endHooks: Array<() => Promise<void>> = [];
  private steps: Step[] = [];
  /** Labels already reported by `stepOnce` this run -- one "Using tool: Tavily" for a run's whole search fan-out. */
  private readonly onceLabels = new Set<string>();
  private messageId: number | undefined;
  private sendAttempted = false;
  private edits = 0;
  private lastEditAt = 0;
  private dirty = false;
  private finished = false;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly env: Env,
    readonly target: LiveStatusTarget,
    private readonly sink: LiveStatusDetailSink | undefined,
    extras: RunExtras = {},
    private readonly clock: { now: () => number } = { now: () => Date.now() },
  ) {
    this.accessSource = extras.access;
  }

  step(label: string): void {
    if (this.finished) return;
    const last = this.steps.at(-1);
    if (last && last.label === label) last.count++;
    else this.steps.push({ label, count: 1 });
    this.dirty = true;
    if (this.sink?.hatStatusOpen()) {
      this.sink.setDetail(this.current());
      void this.schedule(() => this.sink!.refresh());
      return;
    }
    void this.schedule(() => this.flush());
  }

  /** Reports `label` at most once per run; later calls with the same label do nothing. */
  stepOnce(label: string): void {
    if (this.onceLabels.has(label)) return;
    this.onceLabels.add(label);
    this.step(label);
  }

  /** Test seam: the run's steps as they would render right now ("label", "label ×n"). */
  stepsForTest(): string[] {
    return this.steps.map(render);
  }

  /**
   * One occurrence of the pending step `pending` finished as `final`: a
   * single pending step is renamed in place; one of several merged pending
   * steps ("Searching the web ×3") is taken out of the count and shown as
   * its own line just before the still-pending ones.
   */
  resolve(pending: string, final: string): void {
    if (this.finished) return;
    resolvePendingStep(this.steps, pending, final);
    this.dirty = true;
    if (this.sink?.hatStatusOpen()) {
      this.sink.resolveDetail?.(pending, final);
      void this.schedule(() => this.sink!.refresh());
      return;
    }
    void this.schedule(() => this.flush());
  }

  private current(): string | undefined {
    const s = this.steps.at(-1);
    return s ? render(s) : undefined;
  }

  /** Serializes Telegram calls; a failure is logged and never propagates to the run. */
  private schedule(op: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(op).catch((err) => console.error("liveStatus: Telegram update failed (the run carries on)", err));
    return this.chain;
  }

  private text(ending?: { line: string; failed: boolean }): string {
    const lines = [`🧭 ${this.target.header}`];
    this.steps.forEach((s, i) => {
      const isLast = i === this.steps.length - 1;
      const mark = !isLast ? "✓" : ending ? (ending.failed ? "✗" : "✓") : "⏳";
      lines.push(`${mark} ${render(s)}`);
    });
    if (this.steps.length === 0 && !ending) lines.push("⏳ Working");
    if (ending) lines.push(ending.line);
    return escapeMarkdown(lines.join("\n"));
  }

  /** `fromTimer`: the trailing timer itself proves the interval passed, so the (I/O-frozen) clock is not consulted again. */
  private async flush(fromTimer = false): Promise<void> {
    if (this.finished || this.sink?.hatStatusOpen()) return;
    if (this.messageId === undefined) {
      if (this.sendAttempted) return;
      this.sendAttempted = true;
      this.dirty = false;
      this.lastEditAt = this.clock.now();
      this.messageId = await sendMessage(this.env, this.target.chatId, this.text(), undefined, this.target.threadId);
      return;
    }
    if (!this.dirty || this.edits >= MAX_EDITS) return;
    const wait = fromTimer ? 0 : this.lastEditAt + EDIT_INTERVAL_MS - this.clock.now();
    if (wait > 0) {
      if (!this.trailingTimer) {
        this.trailingTimer = setTimeout(() => {
          this.trailingTimer = undefined;
          void this.schedule(() => this.flush(true));
        }, wait);
      }
      return;
    }
    this.dirty = false;
    this.edits++;
    this.lastEditAt = this.clock.now();
    await editMessageText(this.env, this.target.chatId, this.messageId, this.text());
  }

  /** Called by a Hat's own named status when it opens: this run's message (if any) is removed so only one remains. */
  yieldToHatStatus(): void {
    const id = this.messageId;
    this.messageId = undefined;
    this.sendAttempted = true;
    if (id !== undefined) void this.schedule(() => deleteMessage(this.env, this.target.chatId, id));
  }

  async finish(outcome: LiveStatusOutcome): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.trailingTimer) clearTimeout(this.trailingTimer);
    this.sink?.setDetail(undefined);
    await this.chain;
    const id = this.messageId;
    if (id === undefined) return;
    if (outcome === "succeeded") {
      await this.schedule(() => deleteMessage(this.env, this.target.chatId, id));
      return;
    }
    const ending = outcome === "waiting" ? { line: "⏸ Waiting for your reply or approval.", failed: false } : { line: `⛔ Stopped${this.current() ? ` at: ${this.current()}` : ""}.`, failed: true };
    await this.schedule(() => editMessageText(this.env, this.target.chatId, id, this.text(ending)));
  }

  /** Runs the end hooks once, after the status has ended; a hook's failure is logged and never reaches the run. */
  async runEndHooks(): Promise<void> {
    for (const hook of this.endHooks.splice(0)) {
      try {
        await hook();
      } catch (err) {
        console.error("run end hook failed (the run's result is unaffected)", err);
      }
    }
  }
}

/** Shared by the live run and a Hat's trail: renames, or splits off, one occurrence of a pending step. */
export function resolvePendingStep(steps: Step[], pending: string, final: string): void {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].label !== pending) continue;
    if (steps[i].count > 1) {
      steps[i].count--;
      steps.splice(i, 0, { label: final, count: 1 });
    } else steps[i] = { label: final, count: 1 };
    return;
  }
  steps.push({ label: final, count: 1 });
}

function render(s: Step): string {
  return s.count > 1 ? `${s.label} ×${s.count}` : s.label;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

const RUNS = new AsyncLocalStorage<LiveStatusRun>();

/**
 * Runs `fn` with a live status run open. Nested calls join the run already
 * open (one message per run). `outcomeOf` reads the result as succeeded or
 * waiting; a throw is "failed" and is rethrown unchanged.
 */
export async function withLiveStatus<T>(
  env: Env,
  target: LiveStatusTarget,
  fn: () => Promise<T>,
  outcomeOf: (result: T) => LiveStatusOutcome = () => "succeeded",
  sink?: LiveStatusDetailSink,
  extras?: RunExtras,
): Promise<T> {
  if (RUNS.getStore()) return fn();
  const run = new LiveStatusRun(env, target, sink, extras);
  return RUNS.run(run, async () => {
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      await run.finish("failed");
      await run.runEndHooks();
      throw err;
    }
    await run.finish(outcomeOf(result));
    await run.runEndHooks();
    return result;
  });
}

/** The open run's Access context, target and lookup counters, for per-run Runtime services; undefined outside a run. */
export function currentRun(): Pick<LiveStatusRun, "access" | "target" | "searches" | "searchLimit" | "endHooks"> | undefined {
  return RUNS.getStore();
}

/** Reports a step into the open run, if any. Safe to call from anywhere; a no-op outside a run. Labels must come from fixed maps, never content. */
export function reportLiveStep(label: string): void {
  RUNS.getStore()?.step(label);
}

/**
 * Reports a step at most ONCE per run: the first call in the run reports
 * it, later calls with the same label are no-ops. For a stage that is
 * genuinely entered once even though the code reaches it many times (one
 * "Using tool: Tavily" for a run's whole search fan-out) -- per-call
 * reporting would flood the trail and break the approved adjacent merge
 * ("Searching the web ×3"). Same fixed-label rule as reportLiveStep.
 */
export function reportLiveStepOnce(label: string): void {
  RUNS.getStore()?.stepOnce(label);
}

/**
 * Reports that a step reported earlier as `pending` has finished as `final`
 * -- e.g. "Searching the web" becomes "Searching the web — modernghana.com".
 * A no-op outside a run. `final` follows the same fixed-label rule as
 * reportLiveStep, with the one approved exception for a search's public site
 * name (src/runtime/research/webSearch.ts).
 */
export function resolveLiveStep(pending: string, final: string): void {
  RUNS.getStore()?.resolve(pending, final);
}

/** For src/runtime/workStatus.ts: a Hat opening its own named status takes over the run's message. */
export function yieldLiveStatusToHat(): void {
  RUNS.getStore()?.yieldToHatStatus();
}

/** Test seam: whether a run is open in the current async context. */
export function liveStatusOpen(): boolean {
  return RUNS.getStore() !== undefined;
}

/** Test seam: the open run's steps as they would render right now, or undefined outside a run. */
export function liveStatusSteps(): string[] | undefined {
  return RUNS.getStore()?.stepsForTest();
}

// ---------------------------------------------------------------------------
// Skill stages (issue #369). src/platform/skillRegistry.ts reports the three
// stages a Skill execution genuinely reaches -- resolving, verifying,
// applying -- through the listener the Registry exposes. The edge points THIS
// way on purpose: the Registry is loaded by Unit manifests, so an import of
// this module from it would close a module cycle through Units, Notion and
// Telegram (the same direction as the AI layer's augmenters, which register
// into ai/policy.ts rather than being imported by it). Labels are built here
// from fixed stage wording plus the registered Skill id -- never the Skill's
// content, prompt or methodology.
// ---------------------------------------------------------------------------

/** True while a synchronous parallel Skill-application wave reports its own single line (see withoutSkillApplyReports). */
let skillApplySuppressed = false;

/**
 * Runs `fn` with the per-Skill "Applying" reports suppressed, for a path
 * that fetches several Skills in ONE synchronous wave (Strategy's parallel
 * plan): the wave's own line (reportSkillApplyWave) stands for the whole
 * wave instead of a per-Skill checklist that would read as sequential
 * execution. `fn` MUST be synchronous -- the flag is module-level and safe
 * only because no await can interleave inside it.
 */
export function withoutSkillApplyReports<T>(fn: () => T): T {
  const previous = skillApplySuppressed;
  skillApplySuppressed = true;
  try {
    return fn();
  } finally {
    skillApplySuppressed = previous;
  }
}

/**
 * Reports one line for a whole parallel Skill-application wave -- the single
 * Skill as "Applying skill: x", several as "Applying skills: a, b". Called
 * by the owner of the wave (src/units/strategy/strategySkillCycle.ts), which
 * wraps its plan in withoutSkillApplyReports so the per-Skill reports do not
 * fabricate a sequential checklist around it.
 */
export function reportSkillApplyWave(skillIds: readonly string[]): void {
  const unique = [...new Set(skillIds)];
  if (unique.length === 0) return;
  reportLiveStep(unique.length === 1 ? `Applying skill: ${unique[0]}` : `Applying skills: ${unique.join(", ")}`);
}

const SKILL_STAGE_LABELS: Record<SkillStage, string> = {
  resolving: "Resolving skill",
  verifying: "Verifying skill",
  applying: "Applying skill",
};

// The one registration of the Registry's stage listener. A listener failure
// is swallowed by the Registry, so live reporting can never fail a
// resolution; outside a run reportLiveStep is a no-op.
setSkillStageListener((stage, id) => {
  if (stage === "applying" && skillApplySuppressed) return;
  reportLiveStep(`${SKILL_STAGE_LABELS[stage]}: ${id}`);
});
