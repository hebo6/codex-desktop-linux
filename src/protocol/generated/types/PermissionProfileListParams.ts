// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

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
