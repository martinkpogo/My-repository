import type { Env, Unit, WorkState } from "../types";
import { findUnitManifest } from "./registry";

/**
 * The generic body of `WorkSession.runUnitOperation`, kept out of the Durable
 * Object class so it can be tested (the class cannot be loaded under the test
 * runner). Looks the operation up on the named Unit's manifest, runs it inside
 * the Work's execute cycle (`execute` is the session's own), and returns its
 * result -- or the operation's declared `failed` answer when the run threw
 * (execute reports and swallows the failure).
 *
 * Fails closed: a Unit with no such operation is an error, never a silent
 * no-op.
 */
export async function runUnitOperationOnWork(
  env: Env,
  unit: Unit,
  name: string,
  input: unknown,
  execute: (fn: (state: WorkState) => Promise<WorkState>) => Promise<WorkState>,
): Promise<unknown> {
  const operation = findUnitManifest(unit)?.operations?.[name];
  if (!operation) throw new Error(`${unit} declares no operation "${name}" -- nothing was run`);
  let completed = false;
  let result: unknown;
  await execute(async (state) => {
    const out = await operation.run(env, state, input);
    result = out.result;
    completed = true;
    return out.state;
  });
  return completed ? result : operation.failed;
}
