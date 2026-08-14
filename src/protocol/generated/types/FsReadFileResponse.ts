// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
