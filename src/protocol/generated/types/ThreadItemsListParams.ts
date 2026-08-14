// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
