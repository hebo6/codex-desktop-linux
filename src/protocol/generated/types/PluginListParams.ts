// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type PluginListMarketplaceKind =
  "local" | "vertical" | "workspace-directory" | "shared-with-me" | "created-by-me-remote";

export interface PluginListParams {
  /**
   * Optional working directories used to discover repo marketplaces. When omitted, only home-scoped marketplaces and the official curated marketplace are considered.
   */
  cwds?: AbsolutePathBuf[] | null;
  /**
   * Optional marketplace kind filter. When omitted, only local marketplaces are queried, plus the default remote catalog when enabled by feature flag.
   */
  marketplaceKinds?: PluginListMarketplaceKind[] | null;
  [k: string]: unknown | undefined;
}
