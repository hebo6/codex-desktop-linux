// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

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
