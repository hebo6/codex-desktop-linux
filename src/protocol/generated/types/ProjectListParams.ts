// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

export type SortDirection = "asc" | "desc";
export type ProjectSortKey = "position" | "recencyAt";

export interface ProjectListParams {
  cursor?: string | null;
  limit?: number | null;
  /**
   * Requires sortKey. Defaults to asc for position and desc for recencyAt.
   */
  sortDirection?: SortDirection | null;
  /**
   * Defaults to position. Recency sorting always places empty projects last.
   */
  sortKey?: ProjectSortKey | null;
  [k: string]: unknown | undefined;
}
