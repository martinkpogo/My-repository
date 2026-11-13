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
 *
 * The rules this module keeps:
 *   - Honest: a step is recorded only when the chokepoint actually starts it.
 *     Labels come from fixed maps (a governed source's name, a registered AI
 *     task's name, a registered Tool operation id) -- never a page title,
 *     record content, client text or model output.
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

interface Step {
  label: string;
  count: number;
}

/** The handle a Hat's own named status uses to receive this run's current step as a detail line. */
export interface LiveStatusDetailSink {
  hatStatusOpen(): boolean;
  setDetail(detail: string | undefined): void;
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

/** For src/runtime/workStatus.ts: a Hat opening its own named status takes over the run's message. */
export function yieldLiveStatusToHat(): void {
  RUNS.getStore()?.yieldToHatStatus();
}

/** Test seam: whether a run is open in the current async context. */
export function liveStatusOpen(): boolean {
  return RUNS.getStore() !== undefined;
}
