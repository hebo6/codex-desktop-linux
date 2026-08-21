// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：657bd889ae28edcbf5395c103b479bf8b328704e

export interface ModelListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * When true, include models that are hidden from the default picker list.
   */
  includeHidden?: boolean | null;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  [k: string]: unknown | undefined;
}
