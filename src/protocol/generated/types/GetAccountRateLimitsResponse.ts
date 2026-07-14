// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type RateLimitResetType = "codexRateLimits" | "unknown";
export type RateLimitResetCreditStatus = "available" | "redeeming" | "redeemed" | "unknown";
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";
export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface GetAccountRateLimitsResponse {
  rateLimitResetCredits?: RateLimitResetCreditsSummary | null;
  /**
   * Backward-compatible single-bucket view; mirrors the historical payload.
   */
  rateLimits: RateLimitSnapshot;
  /**
   * Multi-bucket view keyed by metered `limit_id` (for example, `codex`).
   */
  rateLimitsByLimitId?: {
    [k: string]: RateLimitSnapshot;
  } | null;
  [k: string]: unknown | undefined;
}
export interface RateLimitResetCreditsSummary {
  availableCount: number;
  /**
   * Detail rows for available reset credits, when the backend provides them.
   *
   * `null` means only `availableCount` is known, while an empty array means details were fetched and no available credits were returned. The backend may cap this list, so its length can be less than `availableCount`.
   */
  credits?: RateLimitResetCredit[] | null;
  [k: string]: unknown | undefined;
}
export interface RateLimitResetCredit {
  /**
   * Backend-provided display description for this credit, or `null` when unavailable.
   */
  description?: string | null;
  /**
   * Unix timestamp in seconds when the credit expires, or `null` if it does not expire.
   */
  expiresAt?: number | null;
  /**
   * Unix timestamp in seconds when the credit was granted.
   */
  grantedAt: number;
  /**
   * Opaque backend identifier for this reset credit.
   */
  id: string;
  resetType: RateLimitResetType;
  status: RateLimitResetCreditStatus;
  /**
   * Backend-provided display title for this credit, or `null` when unavailable.
   */
  title?: string | null;
  [k: string]: unknown | undefined;
}
export interface RateLimitSnapshot {
  credits?: CreditsSnapshot | null;
  individualLimit?: SpendControlLimitSnapshot | null;
  limitId?: string | null;
  limitName?: string | null;
  planType?: PlanType | null;
  primary?: RateLimitWindow | null;
  rateLimitReachedType?: RateLimitReachedType | null;
  secondary?: RateLimitWindow | null;
  [k: string]: unknown | undefined;
}
export interface CreditsSnapshot {
  balance?: string | null;
  hasCredits: boolean;
  unlimited: boolean;
  [k: string]: unknown | undefined;
}
export interface SpendControlLimitSnapshot {
  limit: string;
  remainingPercent: number;
  resetsAt: number;
  used: string;
  [k: string]: unknown | undefined;
}
export interface RateLimitWindow {
  resetsAt?: number | null;
  usedPercent: number;
  windowDurationMins?: number | null;
  [k: string]: unknown | undefined;
}
