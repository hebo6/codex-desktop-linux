// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;

export interface ProjectListResponse {
  data: Project[];
  nextCursor?: string | null;
  [k: string]: unknown | undefined;
}
export interface Project {
  createdAt: number;
  id: string;
  metadata: {
    [k: string]: string | undefined;
  };
  name: string;
  position: number;
  /**
   * Newest non-archived member thread's recency, in Unix seconds; null when none exist.
   */
  recencyAt?: number | null;
  roots: ProjectRoot[];
  updatedAt: number;
  [k: string]: unknown | undefined;
}
export interface ProjectRoot {
  path: AbsolutePathBuf;
  [k: string]: unknown | undefined;
}
