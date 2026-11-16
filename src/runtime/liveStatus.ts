import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../types";
import type { AccessContext } from "../access";
import { deleteMessage, editMessageText, sendMessage } from "../telegram";

/**
 * Universal live status (Martin's decision, 2026-11-11): every run the
 * Runtime does -- any Work, any Hat, any Handoff pickup, any conversation --
 * shows Martin what it is doing right now, without per-Hat code.
 *
 * How: a run is opened at the few places every run passes through
 * (WorkSession.execute, the chat turns, Chat-mode read Actions), and the
 * shared chokepoints every run already uses report steps into it: Notion
 * reads and writes (src/notion.ts), AI calls (src/ai/policy.ts) and Tool
 * invocations (src/runtime/toolRegistry.ts). Code outside a run reports into
 * nothing. A run is carried by AsyncLocalStorage, so concurrent requests
 * never see each other's run.
 *
 * What Martin sees: one message in the run's own chat/topic, edited in place
 *   🧭 <header>
 *   ✓ Reading Payments ×2
 *   ⏳ Writing Payments
 * ending with ⏸ (waiting for his approval or reply) or ⛔ (stopped, the
 * step marked ✗). A run that succeeds DELETES its message (Martin's choice
 * (b)): the result stays in the topic and the trail is in the Activity Log.
 * A Work that ends blocked, incomplete or held did not succeed and keeps its
 * message (workLiveOutcome / STOPPED_STAGE in workStatus.ts, 2026-11-16).
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
 *   - Outcome-driven (#369): the chokepoints report OPERATIONS
 *     (withLiveOperation), each ended with the outcome it actually had --
 *     succeeded, failed, partially_completed, unverified or denied. Running
 *     operations each show ⏳, finished ones are listed in completion order,
 *     and a Hat's own status shows the same feed. See withLiveOperation.
 */

export const EDIT_INTERVAL_MS = 1000;
export const MAX_EDITS = 6;

export type LiveStatusOutcome = "succeeded" | "waiting" | "failed";

/**
 * How one operation actually ended (#369, the outcome-driven activity feed):
 * the same five states the Tool Registry already returns. `unverified` means
 * the effect may or may not have happened and must be reconciled.
 */
export type OperationOutcome = "succeeded" | "failed" | "partially_completed" | "unverified" | "denied";

/** One operation in a run's feed: running (no outcome yet) or finished. */
export interface OperationEntry {
  operationId: string;
  label: string;
  startedAt: number;
  outcome?: OperationOutcome;
  completedAt?: number;
  /** Consecutive finished operations with the same label and outcome are merged ("Reading Matters ×3"). */
  count?: number;
}

/** The run's operations as a Hat's own status shows them: what is running now, and what finished, in completion order. */
export interface OperationFeed {
  running: OperationEntry[];
  completed: OperationEntry[];
  /** Finished operations dropped from `completed` to keep the message bounded. */
  earlier: number;
}

/** At most this many finished entries are kept per run (merged entries count once); older ones are counted in `earlier`. */
export const MAX_COMPLETED_OPERATIONS = 8;

/** The mark a finished operation is shown with. */
export const OUTCOME_MARK: Record<OperationOutcome, string> = { succeeded: "✓", failed: "✗", partially_completed: "◐", unverified: "?", denied: "⛔" };
/** Plain words for a non-success outcome, shown after the label. */
export const OUTCOME_WORDS: Record<OperationOutcome, string> = { succeeded: "", failed: "failed", partially_completed: "partly done", unverified: "not confirmed", denied: "refused" };

export interface LiveStatusTarget {
  chatId: number;
  threadId?: number;
  /** "<Hat or Unit> — <token>", already identity-free. */
  header: string;
}

export interface Step {
  label: string;
  count: number;
  /** Set when an operation reported on this line finished other than `succeeded`. */
  outcome?: OperationOutcome;
  /** True when the line was opened by an operation (so it can show ✓ once nothing is running). */
  op?: boolean;
}

/** The handle a Hat's own named status uses to receive this run's current step as a detail line. */
export interface LiveStatusDetailSink {
  hatStatusOpen(): boolean;
  setDetail(detail: string | undefined): void;
  /** A pending step finished: one occurrence of `pending` becomes `final` (see resolveLiveStep). */
  resolveDetail?(pending: string, final: string): void;
  refresh(): Promise<void>;
  /**
   * The run's operation feed changed (#369). A Hat's own status shows it on
   * its message instead of the run opening a second one. Optional: a sink
   * without it gets the operation as a detail line, as before.
   */
  setOperations?(feed: OperationFeed): void;
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
  /**
   * Whether this run's Work can take a Hat's deep-research proposal right now
   * (its Hat declares continueAfterResearch and no proposal was made on this
   * Work yet) -- a function for the same reason as `access`. Absent: never.
   */
  offersDeepResearch?: () => boolean;
}

class LiveStatusRun {
  private readonly accessSource: AccessContext | (() => AccessContext) | undefined;
  private readonly deepResearchSource: (() => boolean) | undefined;
  get offersDeepResearch(): boolean {
    return this.deepResearchSource?.() === true;
  }
  get access(): AccessContext | undefined {
    return typeof this.accessSource === "function" ? this.accessSource() : this.accessSource;
  }
  searches = 0;
  searchLimit = 0;
  readonly endHooks: Array<() => Promise<void>> = [];
  private steps: Step[] = [];
  private messageId: number | undefined;
  private sendAttempted = false;
  private edits = 0;
  private lastEditAt = 0;
  private dirty = false;
  private finished = false;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private opSeq = 0;
  private readonly running = new Map<string, OperationEntry>();
  private readonly completed: OperationEntry[] = [];
  private earlier = 0;

  constructor(
    private readonly env: Env,
    readonly target: LiveStatusTarget,
    private readonly sink: LiveStatusDetailSink | undefined,
    extras: RunExtras = {},
    private readonly clock: { now: () => number } = { now: () => Date.now() },
  ) {
    this.accessSource = extras.access;
    this.deepResearchSource = extras.offersDeepResearch;
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

  /**
   * An operation starts. Into a Hat's own status it goes on the operation
   * feed; otherwise it is a line on this run's own message, exactly like a
   * step. Returns its id, or undefined once the run has finished.
   */
  startOperation(label: string): string | undefined {
    if (this.finished) return undefined;
    const id = `op${++this.opSeq}`;
    this.running.set(id, { operationId: id, label, startedAt: this.clock.now() });
    if (this.feedToHat()) {
      this.pushFeed();
      return id;
    }
    this.step(label);
    const last = this.steps.at(-1);
    if (last) last.op = true;
    return id;
  }

  /** The operation `id` ended with `outcome`; `finalLabel` renames it (a search naming the site it found). */
  finishOperation(id: string | undefined, outcome: OperationOutcome, finalLabel?: string): void {
    const entry = id === undefined ? undefined : this.running.get(id);
    if (!entry) return;
    this.running.delete(id!);
    const label = finalLabel ?? entry.label;
    this.recordCompleted({ ...entry, label, outcome, completedAt: this.clock.now(), count: 1 });
    if (this.finished) return;
    if (this.feedToHat()) {
      this.pushFeed();
      return;
    }
    if (label !== entry.label) resolvePendingStep(this.steps, entry.label, label);
    if (outcome !== "succeeded") markStepOutcome(this.steps, label, outcome);
    this.dirty = true;
    void this.schedule(() => this.flush());
  }

  /** The feed as it stands; running entries in start order, finished ones in completion order. */
  feed(): OperationFeed {
    return { running: [...this.running.values()], completed: this.completed.map((c) => ({ ...c })), earlier: this.earlier };
  }

  private feedToHat(): boolean {
    return Boolean(this.sink?.setOperations && this.sink.hatStatusOpen());
  }

  /** Hands the feed to the Hat's status. A failing sink is logged and never reaches the operation or the run. */
  private pushFeed(): void {
    try {
      this.sink!.setOperations!(this.feed());
    } catch (err) {
      console.error("liveStatus: operation feed not shown (the operation is unaffected)", err);
      return;
    }
    void this.schedule(() => this.sink!.refresh());
  }

  private recordCompleted(entry: OperationEntry): void {
    const last = this.completed.at(-1);
    if (last && last.label === entry.label && last.outcome === entry.outcome) {
      last.count = (last.count ?? 1) + 1;
      last.completedAt = entry.completedAt;
      return;
    }
    this.completed.push(entry);
    while (this.completed.length > MAX_COMPLETED_OPERATIONS) this.earlier += this.completed.shift()!.count ?? 1;
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
    const inFlight = new Set([...this.running.values()].map((r) => r.label));
    this.steps.forEach((s, i) => {
      const isLast = i === this.steps.length - 1;
      // An operation's line is ⏳ exactly while an operation with its label is
      // in flight, wherever it sits (truthful concurrency); a plain step keeps
      // the original rule (only the last line is running).
      const mark = s.outcome
        ? OUTCOME_MARK[s.outcome]
        : s.op && inFlight.has(s.label)
          ? "⏳"
          : !isLast || s.op
            ? "✓"
            : ending
              ? ending.failed
                ? "✗"
                : "✓"
              : "⏳";
      lines.push(`${mark} ${render(s)}${s.outcome && OUTCOME_WORDS[s.outcome] ? ` — ${OUTCOME_WORDS[s.outcome]}` : ""}`);
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
    // An operation still in flight when its run ends never reported how it
    // ended: its result is unknown, so it is shown as not confirmed -- never
    // as done.
    for (const id of [...this.running.keys()]) this.finishOperation(id, "unverified");
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

/** Marks one occurrence of `label` with a non-success outcome, splitting it off a merged line so the others keep theirs. */
function markStepOutcome(steps: Step[], label: string, outcome: OperationOutcome): void {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].label !== label || steps[i].outcome) continue;
    if (steps[i].count > 1) {
      steps[i].count--;
      steps.splice(i + 1, 0, { label, count: 1, outcome, op: true });
    } else steps[i].outcome = outcome;
    return;
  }
}

function render(s: Step): string {
  return s.count > 1 ? `${s.label} ×${s.count}` : s.label;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}

const RUNS = new AsyncLocalStorage<LiveStatusRun>();
/** Set inside an operation's own work, so a chokepoint it passes through reports a detail step, not a second operation. */
const IN_OPERATION = new AsyncLocalStorage<true>();

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
export function currentRun(): Pick<LiveStatusRun, "access" | "offersDeepResearch" | "target" | "searches" | "searchLimit" | "endHooks"> | undefined {
  return RUNS.getStore();
}

/** Reports a step into the open run, if any. Safe to call from anywhere; a no-op outside a run. Labels must come from fixed maps, never content. */
export function reportLiveStep(label: string): void {
  RUNS.getStore()?.step(label);
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

/**
 * How a thrown error ends an operation: an Access refusal is `denied`;
 * anything else is `failed`. Matched by name, so this module needs no Access
 * import.
 */
export function errorOperationOutcome(err: unknown): OperationOutcome {
  return err instanceof Error && err.name === "AccessDeniedError" ? "denied" : "failed";
}

/**
 * Runs `fn` as one operation of the open run (#369, the outcome-driven
 * activity feed): reported when it actually starts, and finished with the
 * outcome it actually had -- never assumed. Called only from the shared
 * chokepoints (AI calls, Notion operations, web searches, page reads, Tool
 * invocations) and for work a Hat runs in parallel, so no call site threads
 * a reporting handle: the run is found the same way every live step is.
 *
 * - Outside a run it just runs `fn`.
 * - Inside another operation it reports a plain detail step instead, so a
 *   wrapped call is not listed twice.
 * - Reporting never changes the result: `fn`'s value or error is returned
 *   or rethrown unchanged, whatever the reporting does.
 */
export async function withLiveOperation<T>(
  label: string,
  fn: () => Promise<T>,
  outcomeOf: (result: T) => OperationOutcome = () => "succeeded",
  options: { finalLabel?: (result: T) => string | undefined; errorOutcome?: (err: unknown) => OperationOutcome } = {},
): Promise<T> {
  const run = RUNS.getStore();
  if (!run) return fn();
  if (IN_OPERATION.getStore()) {
    safely(() => run.step(label), undefined);
    const result = await fn();
    safely(() => {
      const final = options.finalLabel?.(result);
      if (final && final !== label) run.resolve(label, final);
    }, undefined);
    return result;
  }
  const id = safely(() => run.startOperation(label), undefined);
  let result: T;
  try {
    result = await IN_OPERATION.run(true, fn);
  } catch (err) {
    safely(() => run.finishOperation(id, (options.errorOutcome ?? errorOperationOutcome)(err)), undefined);
    throw err;
  }
  safely(() => run.finishOperation(id, outcomeOf(result), options.finalLabel?.(result)), undefined);
  return result;
}

/** Records an operation that was refused before it could start (an Access denial at a chokepoint): it appears once, `denied`. */
export function reportRefusedOperation(label: string): void {
  const run = RUNS.getStore();
  if (!run || IN_OPERATION.getStore()) return;
  safely(() => run.finishOperation(run.startOperation(label), "denied"), undefined);
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error("liveStatus: operation reporting failed (the operation is unaffected)", err);
    return fallback;
  }
}
