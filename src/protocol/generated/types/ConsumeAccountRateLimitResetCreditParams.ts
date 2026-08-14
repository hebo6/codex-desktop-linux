// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
