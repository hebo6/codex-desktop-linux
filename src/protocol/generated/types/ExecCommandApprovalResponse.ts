// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * User's decision in response to an ExecApprovalRequest.
 */
export type ReviewDecision =
  | "approved"
  | ApprovedExecpolicyAmendmentReviewDecision
  | "approved_for_session"
  | NetworkPolicyAmendmentReviewDecision
  | "denied"
  | "timed_out"
  | "abort";
export type NetworkPolicyRuleAction = "allow" | "deny";

export interface ExecCommandApprovalResponse {
  decision: ReviewDecision;
  [k: string]: unknown | undefined;
}
/**
 * User has approved this command and wants to apply the proposed execpolicy amendment so future matching commands are permitted.
 */
export interface ApprovedExecpolicyAmendmentReviewDecision {
  approved_execpolicy_amendment: {
    proposed_execpolicy_amendment: string[];
    [k: string]: unknown | undefined;
  };
}
/**
 * User chose to persist a network policy rule (allow/deny) for future requests to the same host.
 */
export interface NetworkPolicyAmendmentReviewDecision {
  network_policy_amendment: {
    network_policy_amendment: NetworkPolicyAmendment;
    [k: string]: unknown | undefined;
  };
}
export interface NetworkPolicyAmendment {
  action: NetworkPolicyRuleAction;
  host: string;
  [k: string]: unknown | undefined;
}
