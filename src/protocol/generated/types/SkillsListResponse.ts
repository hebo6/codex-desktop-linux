// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：36650394c5b38c2990ccf2a3457165ca3e9d9726

/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type SkillScope = "user" | "repo" | "system" | "admin";

export interface SkillsListResponse {
  data: SkillsListEntry[];
  [k: string]: unknown | undefined;
}
export interface SkillsListEntry {
  cwd: string;
  errors: SkillErrorInfo[];
  skills: SkillMetadata[];
  [k: string]: unknown | undefined;
}
export interface SkillErrorInfo {
  message: string;
  path: string;
  [k: string]: unknown | undefined;
}
export interface SkillMetadata {
  dependencies?: SkillDependencies | null;
  description: string;
  enabled: boolean;
  interface?: SkillInterface | null;
  name: string;
  path: AbsolutePathBuf;
  /**
   * Owning plugin ID, matching `PluginSummary.id`, when known.
   */
  pluginId?: string | null;
  scope: SkillScope;
  /**
   * Legacy short_description from SKILL.md. Prefer SKILL.json interface.short_description.
   */
  shortDescription?: string | null;
  [k: string]: unknown | undefined;
}
export interface SkillDependencies {
  tools: SkillToolDependency[];
  [k: string]: unknown | undefined;
}
export interface SkillToolDependency {
  command?: string | null;
  description?: string | null;
  transport?: string | null;
  type: string;
  url?: string | null;
  value: string;
  [k: string]: unknown | undefined;
}
export interface SkillInterface {
  brandColor?: string | null;
  defaultPrompt?: string | null;
  displayName?: string | null;
  iconLarge?: AbsolutePathBuf | null;
  /**
   * Remote large icon URL from the plugin catalog.
   */
  iconLargeUrl?: string | null;
  iconSmall?: AbsolutePathBuf | null;
  /**
   * Remote small icon URL from the plugin catalog.
   */
  iconSmallUrl?: string | null;
  shortDescription?: string | null;
  [k: string]: unknown | undefined;
}
