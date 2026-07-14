// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

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
