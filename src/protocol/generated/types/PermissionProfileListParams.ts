// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export interface PermissionProfileListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional working directory to resolve project config layers.
   */
  cwd?: string | null;
  /**
   * Optional page size; defaults to the full result set.
   */
  limit?: number | null;
  [k: string]: unknown | undefined;
}
