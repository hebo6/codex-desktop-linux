// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * Metadata returned by `fs/getMetadata`.
 */
export interface FsGetMetadataResponse {
  /**
   * File creation time in Unix milliseconds when available, otherwise `0`.
   */
  createdAtMs: number;
  /**
   * Whether the path resolves to a directory.
   */
  isDirectory: boolean;
  /**
   * Whether the path resolves to a regular file.
   */
  isFile: boolean;
  /**
   * Whether the path itself is a symbolic link.
   */
  isSymlink: boolean;
  /**
   * File modification time in Unix milliseconds when available, otherwise `0`.
   */
  modifiedAtMs: number;
  [k: string]: unknown | undefined;
}
