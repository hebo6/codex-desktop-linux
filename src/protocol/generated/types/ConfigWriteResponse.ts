// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type ConfigLayerSource =
  | PackagedDefaultsConfigLayerSource
  | MdmConfigLayerSource
  | SystemConfigLayerSource
  | EnterpriseManagedConfigLayerSource
  | UserConfigLayerSource
  | ProjectConfigLayerSource
  | SessionFlagsConfigLayerSource
  | LegacyManagedConfigTomlFromFileConfigLayerSource
  | LegacyManagedConfigTomlFromMdmConfigLayerSource;
export type PackagedDefaultsConfigLayerSourceType = "packagedDefaults";
export type MdmConfigLayerSourceType = "mdm";
export type SystemConfigLayerSourceType = "system";
export type EnterpriseManagedConfigLayerSourceType = "enterpriseManaged";
export type UserConfigLayerSourceType = "user";
export type ProjectConfigLayerSourceType = "project";
export type SessionFlagsConfigLayerSourceType = "sessionFlags";
export type LegacyManagedConfigTomlFromFileConfigLayerSourceType =
  "legacyManagedConfigTomlFromFile";
export type LegacyManagedConfigTomlFromMdmConfigLayerSourceType = "legacyManagedConfigTomlFromMdm";
export type WriteStatus = "ok" | "okOverridden";

export interface ConfigWriteResponse {
  /**
   * Canonical path to the config file that was written.
   */
  filePath: AbsolutePathBuf;
  overriddenMetadata?: OverriddenMetadata | null;
  status: WriteStatus;
  version: string;
  [k: string]: unknown | undefined;
}
export interface OverriddenMetadata {
  effectiveValue: unknown;
  message: string;
  overridingLayer: ConfigLayerMetadata;
  [k: string]: unknown | undefined;
}
export interface ConfigLayerMetadata {
  name: ConfigLayerSource;
  version: string;
  [k: string]: unknown | undefined;
}
/**
 * Default configuration supplied with the installed Codex package.
 */
export interface PackagedDefaultsConfigLayerSource {
  /**
   * Path to the packaged default configuration file.
   */
  file: AbsolutePathBuf;
  type: PackagedDefaultsConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * Managed preferences layer delivered by MDM (macOS only).
 */
export interface MdmConfigLayerSource {
  domain: string;
  key: string;
  type: MdmConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * Managed config layer from a file (usually `managed_config.toml`).
 */
export interface SystemConfigLayerSource {
  /**
   * This is the path to the system config.toml file, though it is not guaranteed to exist.
   */
  file: AbsolutePathBuf;
  type: SystemConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * Enterprise-managed config layer delivered by the cloud config bundle.
 */
export interface EnterpriseManagedConfigLayerSource {
  /**
   * Stable identifier for the delivered layer.
   */
  id: string;
  /**
   * Admin-facing name for the delivered layer. This is surfaced in diagnostics so users know which cloud layer needs administrator attention.
   */
  name: string;
  type: EnterpriseManagedConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * User config layer from $CODEX_HOME/config.toml. This layer is special in that it is expected to be: - writable by the user - generally outside the workspace directory
 */
export interface UserConfigLayerSource {
  /**
   * This is the path to the user's config.toml file, though it is not guaranteed to exist.
   */
  file: AbsolutePathBuf;
  /**
   * Name of the selected profile-v2 config layered on top of the base user config, when this layer represents one.
   */
  profile?: string | null;
  type: UserConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * Path to a .codex/ folder within a project. There could be multiple of these between `cwd` and the project/repo root.
 */
export interface ProjectConfigLayerSource {
  dotCodexFolder: AbsolutePathBuf;
  type: ProjectConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * Session-layer overrides supplied via `-c`/`--config`.
 */
export interface SessionFlagsConfigLayerSource {
  type: SessionFlagsConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
/**
 * `managed_config.toml` was designed to be a config that was loaded as the last layer on top of everything else. This scheme did not quite work out as intended, but we keep this variant as a "best effort" while we phase out `managed_config.toml` in favor of `requirements.toml`.
 */
export interface LegacyManagedConfigTomlFromFileConfigLayerSource {
  file: AbsolutePathBuf;
  type: LegacyManagedConfigTomlFromFileConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
export interface LegacyManagedConfigTomlFromMdmConfigLayerSource {
  type: LegacyManagedConfigTomlFromMdmConfigLayerSourceType;
  [k: string]: unknown | undefined;
}
