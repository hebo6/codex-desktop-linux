// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export interface ConsumeAccountRateLimitResetCreditParams {
  /**
   * Opaque reset-credit identifier to redeem. When omitted, the backend selects the next available credit.
   */
  creditId?: string | null;
  /**
   * Identifies one logical reset attempt. A UUID is recommended; reuse the same value when retrying that attempt.
   */
  idempotencyKey: string;
  [k: string]: unknown | undefined;
}
