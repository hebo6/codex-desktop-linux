// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * EXPERIMENTAL - list available apps/connectors.
 */
export interface AppsListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * When true, bypass app caches and fetch the latest data from sources.
   */
  forceRefetch?: boolean;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  /**
   * Optional thread id used to evaluate app feature gating from that thread's config.
   */
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
