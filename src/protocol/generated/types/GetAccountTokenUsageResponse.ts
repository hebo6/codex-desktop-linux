// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export interface GetAccountTokenUsageResponse {
  dailyUsageBuckets?: AccountTokenUsageDailyBucket[] | null;
  summary: AccountTokenUsageSummary;
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
