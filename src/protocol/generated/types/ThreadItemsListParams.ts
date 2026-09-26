// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export type SortDirection = "asc" | "desc";

export interface ThreadItemsListParams {
  /**
   * Opaque cursor to pass to the next call to continue after the last item.
   */
  cursor?: string | null;
  /**
   * Optional item page size.
   */
  limit?: number | null;
  /**
   * Optional item pagination direction; defaults to ascending.
   */
  sortDirection?: SortDirection | null;
  threadId: string;
  /**
   * Optional turn id to filter by. When omitted, returns items across the thread.
   */
  turnId?: string | null;
  [k: string]: unknown | undefined;
}
