// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

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
