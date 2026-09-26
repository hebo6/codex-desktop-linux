// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

/**
 * Base64-encoded file contents returned by `fs/readFile`.
 */
export interface FsReadFileResponse {
  /**
   * File contents encoded as base64.
   */
  dataBase64: string;
  [k: string]: unknown | undefined;
}
