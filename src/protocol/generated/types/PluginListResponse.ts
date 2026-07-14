// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type PluginAuthPolicy = "ON_INSTALL" | "ON_USE";
export type PluginAvailability = "DISABLED_BY_ADMIN" | "AVAILABLE";
export type PluginInstallPolicy = "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
export type PluginInstallPolicySource = "WORKSPACE_SETTING" | "IMPLICIT_CANONICAL_APP";
export type PluginShareDiscoverability = "LISTED" | "UNLISTED" | "PRIVATE";
export type PluginSharePrincipalType = "user" | "group" | "workspace";
export type PluginSharePrincipalRole = "reader" | "editor" | "owner";
export type PluginSource =
  LocalPluginSource | GitPluginSource | NpmPluginSource | RemotePluginSource;
export type LocalPluginSourceType = "local";
export type GitPluginSourceType = "git";
export type NpmPluginSourceType = "npm";
export type RemotePluginSourceType = "remote";

export interface PluginListResponse {
  featuredPluginIds?: string[];
  marketplaceLoadErrors?: MarketplaceLoadErrorInfo[];
  marketplaces: PluginMarketplaceEntry[];
  [k: string]: unknown | undefined;
}
export interface MarketplaceLoadErrorInfo {
  marketplacePath: AbsolutePathBuf;
  message: string;
  [k: string]: unknown | undefined;
}
export interface PluginMarketplaceEntry {
  interface?: MarketplaceInterface | null;
  name: string;
  /**
   * Local marketplace file path when the marketplace is backed by a local file. Remote-only catalog marketplaces do not have a local path.
   */
  path?: AbsolutePathBuf | null;
  plugins: PluginSummary[];
  [k: string]: unknown | undefined;
}
export interface MarketplaceInterface {
  displayName?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginSummary {
  authPolicy: PluginAuthPolicy;
  /**
   * Availability state for installing and using the plugin.
   */
  availability?: PluginAvailability & string;
  enabled: boolean;
  id: string;
  installPolicy: PluginInstallPolicy;
  installPolicySource?: PluginInstallPolicySource | null;
  installed: boolean;
  interface?: PluginInterface | null;
  keywords?: string[];
  /**
   * Version of the locally materialized plugin package when available.
   */
  localVersion?: string | null;
  name: string;
  /**
   * Backend remote plugin identifier when available.
   */
  remotePluginId?: string | null;
  /**
   * Remote sharing context associated with this plugin when available.
   */
  shareContext?: PluginShareContext | null;
  source: PluginSource;
  /**
   * Version advertised by the remote marketplace backend when available.
   */
  version?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginInterface {
  brandColor?: string | null;
  capabilities: string[];
  category?: string | null;
  /**
   * Local composer icon path, resolved from the installed plugin package.
   */
  composerIcon?: AbsolutePathBuf | null;
  /**
   * Remote composer icon URL from the plugin catalog.
   */
  composerIconUrl?: string | null;
  /**
   * Starter prompts for the plugin. Capped at 3 entries with a maximum of 128 characters per entry.
   */
  defaultPrompt?: string[] | null;
  developerName?: string | null;
  displayName?: string | null;
  /**
   * Local logo path, resolved from the installed plugin package.
   */
  logo?: AbsolutePathBuf | null;
  /**
   * Local dark-mode logo path, resolved from the installed plugin package.
   */
  logoDark?: AbsolutePathBuf | null;
  /**
   * Remote logo URL from the plugin catalog.
   */
  logoUrl?: string | null;
  /**
   * Remote dark-mode logo URL from the plugin catalog.
   */
  logoUrlDark?: string | null;
  longDescription?: string | null;
  privacyPolicyUrl?: string | null;
  /**
   * Remote screenshot URLs from the plugin catalog.
   */
  screenshotUrls: string[];
  /**
   * Local screenshot paths, resolved from the installed plugin package.
   */
  screenshots: AbsolutePathBuf[];
  shortDescription?: string | null;
  termsOfServiceUrl?: string | null;
  websiteUrl?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginShareContext {
  creatorAccountUserId?: string | null;
  creatorName?: string | null;
  discoverability?: PluginShareDiscoverability | null;
  remotePluginId: string;
  /**
   * Version of the remote shared plugin release when available.
   */
  remoteVersion?: string | null;
  sharePrincipals?: PluginSharePrincipal[] | null;
  shareUrl?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginSharePrincipal {
  name: string;
  principalId: string;
  principalType: PluginSharePrincipalType;
  role: PluginSharePrincipalRole;
  [k: string]: unknown | undefined;
}
export interface LocalPluginSource {
  path: AbsolutePathBuf;
  type: LocalPluginSourceType;
  [k: string]: unknown | undefined;
}
export interface GitPluginSource {
  path?: string | null;
  refName?: string | null;
  sha?: string | null;
  type: GitPluginSourceType;
  url: string;
  [k: string]: unknown | undefined;
}
export interface NpmPluginSource {
  package: string;
  /**
   * Optional HTTPS registry URL. Authentication stays in the user's npm config.
   */
  registry?: string | null;
  type: NpmPluginSourceType;
  /**
   * Optional npm version or version range.
   */
  version?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * The plugin is available in the remote catalog. Download metadata is kept server-side and is not exposed through the app-server API.
 */
export interface RemotePluginSource {
  type: RemotePluginSourceType;
  [k: string]: unknown | undefined;
}
