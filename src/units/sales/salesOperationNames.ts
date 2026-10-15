/**
 * The names of the operations Sales declares on its manifest
 * (UnitManifest.operations) and callers invoke through
 * `WorkSession.runUnitOperation("Sales", name, input)`. Kept in its own file so
 * a caller and the declaration share one spelling without importing each other.
 */
export const SALES_OPERATION = {
  proposeLeadOpportunity: "propose_lead_opportunity",
  handleProposalDocComment: "handle_proposal_doc_comment",
  syncProposalDocApprovalCycle: "sync_proposal_doc_approval_cycle",
  handleProposalDocFormatting: "handle_proposal_doc_formatting",
  requestProposalDocClarification: "request_proposal_doc_clarification",
  replyProposalDocComment: "reply_proposal_doc_comment",
} as const;
