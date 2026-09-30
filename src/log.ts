import type { Env } from "./types";
import { createPage, richText, select, title } from "./notion";
import { systemContext } from "./access";

export type LogType = "Activity" | "Decision" | "Change" | "Discovery" | "Blocker";
export type LogOutcome = "Active" | "Complete" | "Blocked";

export interface LogEntryInput {
  entry: string;
  type: LogType;
  area?: string;
  activity?: string;
  decisions?: string;
  decisionRationale?: string;
  nextActions?: string;
  outcome: LogOutcome;
  /**
   * The Work item this entry is being written on behalf of, when there is
   * one. Carried into the Access context purely as provenance -- the
   * Activity Log append is a Kernel-owned record of what happened, not any
   * Unit's governed business action, so it is always a "system" write and
   * never requires an ApprovalProof of its own.
   */
  workId?: string;
}

export async function logActivity(env: Env, input: LogEntryInput): Promise<void> {
  try {
    await createPage(
      env,
      env.ACTIVITY_LOG_DATA_SOURCE_ID,
      {
        Entry: title(input.entry),
        Type: select(input.type),
        Area: richText(input.area ?? ""),
        "Activity / Event": richText(input.activity ?? ""),
        Decisions: richText(input.decisions ?? ""),
        "Decision Rationale": richText(input.decisionRationale ?? ""),
        "Next Actions": richText(input.nextActions ?? ""),
        Outcome: select(input.outcome),
      },
      systemContext(input.workId),
    );
  } catch (err) {
    console.error("Activity & Decision Log write failed", err, input);
  }
}
