// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * EXPERIMENTAL - app list response.
 */
export interface AppsListResponse {
  data: AppInfo[];
  /**
   * Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return.
   */
  nextCursor?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - app metadata returned by app-list APIs.
 */
export interface AppInfo {
  appMetadata?: AppMetadata | null;
  branding?: AppBranding | null;
  description?: string | null;
  distributionChannel?: string | null;
  iconAssets?: {
    [k: string]: string | undefined;
  } | null;
  iconDarkAssets?: {
    [k: string]: string | undefined;
  } | null;
  id: string;
  installUrl?: string | null;
  isAccessible?: boolean;
  /**
   * Whether this app is enabled in config.toml. Example: ```toml [apps.bad_app] enabled = false ```
   */
  isEnabled?: boolean;
  labels?: {
    [k: string]: string | undefined;
  } | null;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  name: string;
  pluginDisplayNames?: string[];
  [k: string]: unknown | undefined;
}
export interface AppMetadata {
  categories?: string[] | null;
  developer?: string | null;
  firstPartyRequiresInstall?: boolean | null;
  firstPartyType?: string | null;
  review?: AppReview | null;
  screenshots?: AppScreenshot[] | null;
  seoDescription?: string | null;
  showInComposerWhenUnlinked?: boolean | null;
  subCategories?: string[] | null;
  version?: string | null;
  versionId?: string | null;
  versionNotes?: string | null;
  [k: string]: unknown | undefined;
}
export interface AppReview {
  status: string;
  [k: string]: unknown | undefined;
}
export interface AppScreenshot {
  fileId?: string | null;
  url?: string | null;
  userPrompt: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - app metadata returned by app-list APIs.
 */
export interface AppBranding {
  category?: string | null;
  developer?: string | null;
  isDiscoverableApp: boolean;
  privacyPolicy?: string | null;
  termsOfService?: string | null;
  website?: string | null;
  [k: string]: unknown | undefined;
}
