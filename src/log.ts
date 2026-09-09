import type { Env } from "./types";
import { createPage, richText, select, title } from "./notion";

export type LogType = "Activity" | "Decision" | "Change" | "Discovery" | "Blocker";
export type LogOutcome = "Active" | "Complete" | "Blocked";

export interface LogEntryInput {
  entry: string;
  type: LogType;
  area: string;
  activity?: string;
  decisions?: string;
  decisionRationale?: string;
  nextActions?: string;
  outcome: LogOutcome;
}

export async function logActivity(env: Env, input: LogEntryInput): Promise<void> {
  try {
    await createPage(env, env.ACTIVITY_LOG_DATA_SOURCE_ID, {
      Entry: title(input.entry),
      Type: select(input.type),
      Area: richText(input.area),
      "Activity / Event": richText(input.activity ?? ""),
      Decisions: richText(input.decisions ?? ""),
      "Decision Rationale": richText(input.decisionRationale ?? ""),
      "Next Actions": richText(input.nextActions ?? ""),
      Outcome: select(input.outcome),
    });
  } catch (err) {
    console.error("Activity & Decision Log write failed", err, input);
  }
}
