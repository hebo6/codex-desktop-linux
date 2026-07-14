// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type TurnItemsView = "notLoaded" | "summary" | "full";
export type SortDirection = "asc" | "desc";

export interface ThreadTurnsListParams {
  /**
   * Opaque cursor to pass to the next call to continue after the last turn.
   */
  cursor?: string | null;
  /**
   * How much item detail to include for each returned turn; defaults to summary.
   */
  itemsView?: TurnItemsView | null;
  /**
   * Optional turn page size.
   */
  limit?: number | null;
  /**
   * Optional turn pagination direction; defaults to descending.
   */
  sortDirection?: SortDirection | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
