// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

export interface ThreadReadParams {
  /**
   * When true, include turns and their items from rollout history. Full-history hydration is deprecated for paginated threads; prefer a metadata-only read and page with `thread/turns/list` and `thread/items/list`.
   */
  includeTurns?: boolean;
  threadId: string;
  [k: string]: unknown | undefined;
}
