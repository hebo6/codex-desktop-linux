// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

export interface GetAccountTokenUsageResponse {
  dailyUsageBuckets?: AccountTokenUsageDailyBucket[] | null;
  summary: AccountTokenUsageSummary;
  /**
   * Estimated usage when a thread was requested and its billing route is available.
   */
  threadUsage?: ThreadUsage | null;
  [k: string]: unknown | undefined;
}
export interface AccountTokenUsageDailyBucket {
  startDate: string;
  tokens: number;
  [k: string]: unknown | undefined;
}
export interface AccountTokenUsageSummary {
  currentStreakDays?: number | null;
  lifetimeTokens?: number | null;
  longestRunningTurnSec?: number | null;
  longestStreakDays?: number | null;
  peakDailyTokens?: number | null;
  [k: string]: unknown | undefined;
}
export interface ThreadUsage {
  estimatedUsageCreditsMicros: number;
  estimatedUsageUsdMicros?: number | null;
  groups: ThreadUsageBreakdownGroup[];
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadUsageBreakdownGroup {
  cachedInputTokens?: number | null;
  estimatedUsageCreditsMicros: number;
  inputTokens?: number | null;
  model?: string | null;
  netNewInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningEffort?: string | null;
  speed?: string | null;
  totalTokens?: number | null;
  [k: string]: unknown | undefined;
}
