// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export interface ThreadReadParams {
  /**
   * When true, include turns and their items from rollout history. Full-history hydration is deprecated for paginated threads; prefer a metadata-only read and page with `thread/turns/list` and `thread/items/list`.
   */
  includeTurns?: boolean;
  threadId: string;
  [k: string]: unknown | undefined;
}
