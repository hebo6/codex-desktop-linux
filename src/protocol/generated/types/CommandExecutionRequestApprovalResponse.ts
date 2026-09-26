// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | AcceptWithExecpolicyAmendmentCommandExecutionApprovalDecision
  | ApplyNetworkPolicyAmendmentCommandExecutionApprovalDecision
  | "decline"
  | "cancel";
export type NetworkPolicyRuleAction = "allow" | "deny";

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
  [k: string]: unknown | undefined;
}
/**
 * User approved the command, and wants to apply the proposed execpolicy amendment so future matching commands can run without prompting.
 */
export interface AcceptWithExecpolicyAmendmentCommandExecutionApprovalDecision {
  acceptWithExecpolicyAmendment: {
    execpolicy_amendment: string[];
    [k: string]: unknown | undefined;
  };
}
/**
 * User chose a persistent network policy rule (allow/deny) for this host.
 */
export interface ApplyNetworkPolicyAmendmentCommandExecutionApprovalDecision {
  applyNetworkPolicyAmendment: {
    network_policy_amendment: NetworkPolicyAmendment;
    [k: string]: unknown | undefined;
  };
}
export interface NetworkPolicyAmendment {
  action: NetworkPolicyRuleAction;
  host: string;
  [k: string]: unknown | undefined;
}
