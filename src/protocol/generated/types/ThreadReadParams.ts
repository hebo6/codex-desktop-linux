// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export interface ThreadReadParams {
  /**
   * When true, include turns and their items from rollout history.
   */
  includeTurns?: boolean;
  threadId: string;
  [k: string]: unknown | undefined;
}
