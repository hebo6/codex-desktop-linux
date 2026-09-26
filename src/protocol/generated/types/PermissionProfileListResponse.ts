// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

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
