// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：8630bb3caecaff6abc6add450a88035d9f6d3f8c

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
   * Whether the client requests a fresh remote plugin catalog fetch.
   */
  forceRefetch?: boolean;
  /**
   * Optional marketplace kind filter. When omitted, only local marketplaces are queried, plus the default remote catalog when enabled by feature flag.
   */
  marketplaceKinds?: PluginListMarketplaceKind[] | null;
  [k: string]: unknown | undefined;
}
