// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface ThreadGoalGetResponse {
  goal?: ThreadGoal | null;
  [k: string]: unknown | undefined;
}
export interface ThreadGoal {
  createdAt: number;
  objective: string;
  status: ThreadGoalStatus;
  threadId: string;
  timeUsedSeconds: number;
  tokenBudget?: number | null;
  tokensUsed: number;
  updatedAt: number;
  [k: string]: unknown | undefined;
}
