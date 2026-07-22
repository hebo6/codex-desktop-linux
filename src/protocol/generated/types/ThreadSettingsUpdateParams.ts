// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
/**
 * Initial collaboration mode to use when the TUI starts.
 */
export type ModeKind = "plan" | "default";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
/**
 * Controls the effective multi-agent delegation instructions for a turn. `custom` means the configured mode hint defines the policy instead of a built-in policy.
 */
export type MultiAgentMode = ("explicitRequestOnly" | "proactive") | CustomMultiAgentMode;
export type Personality = "none" | "friendly" | "pragmatic";
export type SandboxPolicy =
  | DangerFullAccessSandboxPolicy
  | ReadOnlySandboxPolicy
  | ExternalSandboxSandboxPolicy
  | WorkspaceWriteSandboxPolicy;
export type DangerFullAccessSandboxPolicyType = "dangerFullAccess";
export type ReadOnlySandboxPolicyType = "readOnly";
export type NetworkAccess = "restricted" | "enabled";
export type ExternalSandboxSandboxPolicyType = "externalSandbox";
export type WorkspaceWriteSandboxPolicyType = "workspaceWrite";
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
/**
 * A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
 */
export type ReasoningSummary = ("auto" | "concise" | "detailed") | "none";

export interface ThreadSettingsUpdateParams {
  /**
   * Override the approval policy for subsequent turns.
   */
  approvalPolicy?: AskForApproval | null;
  /**
   * Override where approval requests are routed for subsequent turns.
   */
  approvalsReviewer?: ApprovalsReviewer | null;
  /**
   * EXPERIMENTAL - Set a pre-set collaboration mode for subsequent turns.
   *
   * For `collaboration_mode.settings.developer_instructions`, `null` means "use the built-in instructions for the selected mode".
   */
  collaborationMode?: CollaborationMode | null;
  /**
   * Override the working directory for subsequent turns.
   */
  cwd?: string | null;
  /**
   * Override the reasoning effort for subsequent turns.
   */
  effort?: ReasoningEffort | null;
  /**
   * Override the model for subsequent turns.
   */
  model?: string | null;
  /**
   * @deprecated Ignored. Use `effort: "ultra"` for proactive multi-agent behavior.
   */
  multiAgentMode?: MultiAgentMode | null;
  /**
   * Select a named permissions profile id for subsequent turns. Cannot be combined with `sandboxPolicy`.
   */
  permissions?: string | null;
  /**
   * Override the personality for subsequent turns.
   */
  personality?: Personality | null;
  /**
   * Override the sandbox policy for subsequent turns.
   */
  sandboxPolicy?: SandboxPolicy | null;
  /**
   * Override the service tier for subsequent turns. `null` clears the current service tier; omission leaves it unchanged.
   */
  serviceTier?: string | null;
  /**
   * Override the reasoning summary for subsequent turns.
   */
  summary?: ReasoningSummary | null;
  threadId: string;
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
/**
 * Collaboration mode for a Codex session.
 */
export interface CollaborationMode {
  mode: ModeKind;
  settings: Settings;
  [k: string]: unknown | undefined;
}
/**
 * Settings for a collaboration mode.
 */
export interface Settings {
  developer_instructions?: string | null;
  model: string;
  reasoning_effort?: ReasoningEffort | null;
  [k: string]: unknown | undefined;
}
export interface CustomMultiAgentMode {
  custom: string;
}
export interface DangerFullAccessSandboxPolicy {
  type: DangerFullAccessSandboxPolicyType;
  [k: string]: unknown | undefined;
}
export interface ReadOnlySandboxPolicy {
  networkAccess?: boolean;
  type: ReadOnlySandboxPolicyType;
  [k: string]: unknown | undefined;
}
export interface ExternalSandboxSandboxPolicy {
  networkAccess?: NetworkAccess & string;
  type: ExternalSandboxSandboxPolicyType;
  [k: string]: unknown | undefined;
}
export interface WorkspaceWriteSandboxPolicy {
  excludeSlashTmp?: boolean;
  excludeTmpdirEnvVar?: boolean;
  networkAccess?: boolean;
  type: WorkspaceWriteSandboxPolicyType;
  writableRoots?: AbsolutePathBuf[];
  [k: string]: unknown | undefined;
}
