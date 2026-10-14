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
 * no-op -- and the operation must also belong to the Work it was dispatched
 * against: the fetched Work's own `state.unit` must match the Unit named in
 * the dispatch, checked BEFORE the handler runs. A mismatch executes no
 * handler, saves no state and reaches no Notion write (the throw is what
 * keeps execute from saving, exactly as for a handler that threw), and the
 * caller receives this operation's declared `failed` answer.
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
    if (state.unit !== unit) {
      throw new Error(`Work ${state.workId} belongs to ${state.unit ?? "no Unit"}, not ${unit} -- operation "${name}" was refused before its handler ran.`);
    }
    const out = await operation.run(env, state, input);
    result = out.result;
    completed = true;
    return out.state;
  });
  return completed ? result : operation.failed;
}
