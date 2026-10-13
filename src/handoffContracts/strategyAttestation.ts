import type { WorkState } from "../types";
import type { HandoffSourceBoundaryAttestation } from "../handoffWriter";

/**
 * Records, on the Work, the result of the Sales-side source-boundary check
 * performed when the Sales -> Strategy Handoff was created. Sales authors this
 * evidence and Strategy reads it at pickup, so the write belongs to the
 * neutral Handoff contract rather than to either Unit: Sales records it
 * without importing Strategy's code. It is stored in Strategy's slice of the
 * Work (`WorkState.strategy`), where Strategy looks for it.
 */
export function recordStrategySourceBoundaryAttestation(state: WorkState, attestation: HandoffSourceBoundaryAttestation): void {
  (state.strategy ??= {}).sourceBoundaryAttestation = attestation;
}
