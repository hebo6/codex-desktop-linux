// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export interface ThreadBackgroundTerminalsListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional page size.
   */
  limit?: number | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
