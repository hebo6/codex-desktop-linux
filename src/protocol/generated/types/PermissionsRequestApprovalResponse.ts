// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type FileSystemAccessMode = "read" | "write" | "deny";
export type FileSystemPath = PathFileSystemPath | GlobPatternFileSystemPath | SpecialFileSystemPath;
export type LegacyAppPathString = string;
export type PathFileSystemPathType = "path";
export type GlobPatternFileSystemPathType = "glob_pattern";
export type SpecialFileSystemPathType = "special";
export type FileSystemSpecialPath =
  | RootFileSystemSpecialPath
  | MinimalFileSystemSpecialPath
  | KindFileSystemSpecialPath
  | TmpdirFileSystemSpecialPath
  | SlashTmpFileSystemSpecialPath
  | {
      kind: "unknown";
      path: string;
      subpath?: string | null;
      [k: string]: unknown | undefined;
    };
export type PermissionGrantScope = "turn" | "session";

export interface PermissionsRequestApprovalResponse {
  permissions: GrantedPermissionProfile;
  scope?: PermissionGrantScope & string;
  /**
   * Review every subsequent command in this turn before normal sandboxed execution.
   */
  strictAutoReview?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface GrantedPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
  [k: string]: unknown | undefined;
}
export interface AdditionalFileSystemPermissions {
  entries?: FileSystemSandboxEntry[] | null;
  globScanMaxDepth?: number | null;
  /**
   * This will be removed in favor of `entries`.
   */
  read?: LegacyAppPathString[] | null;
  /**
   * This will be removed in favor of `entries`.
   */
  write?: LegacyAppPathString[] | null;
  [k: string]: unknown | undefined;
}
export interface FileSystemSandboxEntry {
  access: FileSystemAccessMode;
  path: FileSystemPath;
  [k: string]: unknown | undefined;
}
export interface PathFileSystemPath {
  path: LegacyAppPathString;
  type: PathFileSystemPathType;
  [k: string]: unknown | undefined;
}
export interface GlobPatternFileSystemPath {
  pattern: string;
  type: GlobPatternFileSystemPathType;
  [k: string]: unknown | undefined;
}
export interface SpecialFileSystemPath {
  type: SpecialFileSystemPathType;
  value: FileSystemSpecialPath;
  [k: string]: unknown | undefined;
}
export interface RootFileSystemSpecialPath {
  kind: "root";
  [k: string]: unknown | undefined;
}
export interface MinimalFileSystemSpecialPath {
  kind: "minimal";
  [k: string]: unknown | undefined;
}
export interface KindFileSystemSpecialPath {
  kind: "project_roots";
  subpath?: string | null;
  [k: string]: unknown | undefined;
}
export interface TmpdirFileSystemSpecialPath {
  kind: "tmpdir";
  [k: string]: unknown | undefined;
}
export interface SlashTmpFileSystemSpecialPath {
  kind: "slash_tmp";
  [k: string]: unknown | undefined;
}
export interface AdditionalNetworkPermissions {
  enabled?: boolean | null;
  [k: string]: unknown | undefined;
}
