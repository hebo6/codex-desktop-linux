// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export type ConsumeAccountRateLimitResetCreditOutcome =
  "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface ConsumeAccountRateLimitResetCreditResponse {
  outcome: ConsumeAccountRateLimitResetCreditOutcome;
  [k: string]: unknown | undefined;
}
