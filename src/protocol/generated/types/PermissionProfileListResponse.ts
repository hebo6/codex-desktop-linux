// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：a4535884169be8da2f81b8a4debecbd4dc11aa97

export interface PermissionProfileListResponse {
  data: PermissionProfileSummary[];
  /**
   * Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.
   */
  nextCursor?: string | null;
  [k: string]: unknown | undefined;
}
export interface PermissionProfileSummary {
  /**
   * Whether the effective requirements allow selecting this profile.
   */
  allowed: boolean;
  /**
   * Optional user-facing description for display in clients.
   */
  description?: string | null;
  /**
   * Available permission profile identifier.
   */
  id: string;
  [k: string]: unknown | undefined;
}
