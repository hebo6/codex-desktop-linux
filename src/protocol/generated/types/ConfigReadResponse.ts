// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type AppToolApproval = "auto" | "prompt" | "writes" | "approve";
/**
 * Backward-compatible API shape for ChatGPT workspace login restrictions.
 */
export type ForcedChatgptWorkspaceIds = string | string[];
export type ForcedLoginMethod = "chatgpt" | "api";
/**
 * Selects which part of the active context is charged against `model_auto_compact_token_limit`.
 */
export type AutoCompactTokenLimitScope = "total" | "body_after_prefix";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
/**
 * A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
 */
export type ReasoningSummary = ("auto" | "concise" | "detailed") | "none";
/**
 * Controls output length/detail on GPT-5 models via the Responses API. Serialized with lowercase values to match the OpenAI API.
 */
export type Verbosity = "low" | "medium" | "high";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchContextSize = "low" | "medium" | "high";
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type ConfigLayerSource =
  | MdmConfigLayerSource
  | SystemConfigLayerSource
  | EnterpriseManagedConfigLayerSource
  | UserConfigLayerSource
  | ProjectConfigLayerSource
  | SessionFlagsConfigLayerSource
  | LegacyManagedConfigTomlFromFileConfigLayerSource
  | LegacyManagedConfigTomlFromMdmConfigLayerSource;
export type MdmConfigLayerSourceType = "mdm";
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type SystemConfigLayerSourceType = "system";
export type EnterpriseManagedConfigLayerSourceType = "enterpriseManaged";
export type UserConfigLayerSourceType = "user";
export type ProjectConfigLayerSourceType = "project";
export type SessionFlagsConfigLayerSourceType = "sessionFlags";
export type LegacyManagedConfigTomlFromFileConfigLayerSourceType =
  "legacyManagedConfigTomlFromFile";
export type LegacyManagedConfigTomlFromMdmConfigLayerSourceType = "legacyManagedConfigTomlFromMdm";

export interface ConfigReadResponse {
  config: Config;
  layers?: ConfigLayer[] | null;
  origins: {
    [k: string]: ConfigLayerMetadata | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface Config {
  analytics?: AnalyticsConfig | null;
  approval_policy?: AskForApproval | null;
  /**
   * [UNSTABLE] Optional default for where approval requests are routed for review.
   */
  approvals_reviewer?: ApprovalsReviewer | null;
  apps?: AppsConfig | null;
  compact_prompt?: string | null;
  desktop?: {
    [k: string]: unknown | undefined;
  } | null;
  developer_instructions?: string | null;
  forced_chatgpt_workspace_id?: ForcedChatgptWorkspaceIds | null;
  forced_login_method?: ForcedLoginMethod | null;
  instructions?: string | null;
  model?: string | null;
  model_auto_compact_token_limit?: number | null;
  model_auto_compact_token_limit_scope?: AutoCompactTokenLimitScope | null;
  model_context_window?: number | null;
  model_provider?: string | null;
  model_reasoning_effort?: ReasoningEffort | null;
  model_reasoning_summary?: ReasoningSummary | null;
  model_verbosity?: Verbosity | null;
  review_model?: string | null;
  sandbox_mode?: SandboxMode | null;
  sandbox_workspace_write?: SandboxWorkspaceWrite | null;
  service_tier?: string | null;
  tools?: ToolsV2 | null;
  web_search?: WebSearchMode | null;
  [k: string]: unknown | undefined;
}
export interface AnalyticsConfig {
  enabled?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface GranularAskForApproval {
  granular: {
    mcp_elicitations: boolean;
    request_permissions?: boolean;
    rules: boolean;
    sandbox_approval: boolean;
    skill_approval?: boolean;
    [k: string]: unknown | undefined;
  };
}
export interface AppsConfig {
  _default?: AppsDefaultConfig | null;
  [k: string]: unknown | undefined;
}
export interface AppsDefaultConfig {
  approvals_reviewer?: ApprovalsReviewer | null;
  default_tools_approval_mode?: AppToolApproval | null;
  destructive_enabled?: boolean;
  enabled?: boolean;
  open_world_enabled?: boolean;
  [k: string]: unknown | undefined;
}
export interface SandboxWorkspaceWrite {
  exclude_slash_tmp?: boolean;
  exclude_tmpdir_env_var?: boolean;
  network_access?: boolean;
  writable_roots?: string[];
  [k: string]: unknown | undefined;
}
export interface ToolsV2 {
  web_search?: WebSearchToolConfig | null;
  [k: string]: unknown | undefined;
}
export interface WebSearchToolConfig {
  allowed_domains?: string[] | null;
  context_size?: WebSearchContextSize | null;
  location?: WebSearchLocation | null;
}
export interface WebSearchLocation {
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}
export interface ConfigLayer {
  config: unknown;
  disabledReason?: string | null;
  name: ConfigLayerSource;
  version: string;
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
export interface ConfigLayerMetadata {
  name: ConfigLayerSource;
  version: string;
  [k: string]: unknown | undefined;
}
