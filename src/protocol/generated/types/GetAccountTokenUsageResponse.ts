// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

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
