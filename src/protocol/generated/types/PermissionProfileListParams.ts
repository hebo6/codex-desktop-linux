// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

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
