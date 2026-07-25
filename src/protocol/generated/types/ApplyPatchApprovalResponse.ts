// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

/**
 * User's decision in response to an ExecApprovalRequest.
 */
export type ReviewDecision =
  | "approved"
  | ApprovedExecpolicyAmendmentReviewDecision
  | "approved_for_session"
  | NetworkPolicyAmendmentReviewDecision
  | DeniedReviewDecision
  | "timed_out"
  | "abort";
export type NetworkPolicyRuleAction = "allow" | "deny";

export interface ApplyPatchApprovalResponse {
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
/**
 * User has denied this command and the agent should not execute it, but it should continue the session and try something else.
 */
export interface DeniedReviewDecision {
  denied: {
    rejection: string;
    [k: string]: unknown | undefined;
  };
}
