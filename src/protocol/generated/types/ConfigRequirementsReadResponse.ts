// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type WindowsSandboxSetupMode = "elevated" | "unelevated";
export type ResidencyRequirement = "us";
export type ConfiguredHookHandler =
  CommandConfiguredHookHandler | PromptConfiguredHookHandler | AgentConfiguredHookHandler;
export type CommandConfiguredHookHandlerType = "command";
export type PromptConfiguredHookHandlerType = "prompt";
export type AgentConfiguredHookHandlerType = "agent";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
export type NetworkDomainPermission = ("allow" | "deny") | undefined;
export type NetworkUnixSocketPermission = ("allow" | "deny") | undefined;

export interface ConfigRequirementsReadResponse {
  /**
   * Null if no requirements are configured (e.g. no requirements.toml/MDM entries).
   */
  requirements?: ConfigRequirements | null;
  [k: string]: unknown | undefined;
}
export interface ConfigRequirements {
  allowAppshots?: boolean | null;
  allowManagedHooksOnly?: boolean | null;
  allowRemoteControl?: boolean | null;
  allowedApprovalPolicies?: AskForApproval[] | null;
  allowedApprovalsReviewers?: ApprovalsReviewer[] | null;
  allowedPermissionProfiles?: {
    [k: string]: boolean | undefined;
  } | null;
  allowedSandboxModes?: SandboxMode[] | null;
  allowedWebSearchModes?: WebSearchMode[] | null;
  allowedWindowsSandboxImplementations?: WindowsSandboxSetupMode[] | null;
  computerUse?: ComputerUseRequirements | null;
  defaultPermissions?: string | null;
  enforceResidency?: ResidencyRequirement | null;
  featureRequirements?: {
    [k: string]: boolean | undefined;
  } | null;
  hooks?: ManagedHooksRequirements | null;
  models?: ModelsRequirements | null;
  network?: NetworkRequirements | null;
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
export interface ComputerUseRequirements {
  allowLockedComputerUse?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface ManagedHooksRequirements {
  PermissionRequest: ConfiguredHookMatcherGroup[];
  PostCompact: ConfiguredHookMatcherGroup[];
  PostToolUse: ConfiguredHookMatcherGroup[];
  PreCompact: ConfiguredHookMatcherGroup[];
  PreToolUse: ConfiguredHookMatcherGroup[];
  SessionStart: ConfiguredHookMatcherGroup[];
  Stop: ConfiguredHookMatcherGroup[];
  SubagentStart: ConfiguredHookMatcherGroup[];
  SubagentStop: ConfiguredHookMatcherGroup[];
  UserPromptSubmit: ConfiguredHookMatcherGroup[];
  managedDir?: string | null;
  windowsManagedDir?: string | null;
  [k: string]: unknown | undefined;
}
export interface ConfiguredHookMatcherGroup {
  hooks: ConfiguredHookHandler[];
  matcher?: string | null;
  [k: string]: unknown | undefined;
}
export interface CommandConfiguredHookHandler {
  async: boolean;
  command: string;
  commandWindows?: string | null;
  statusMessage?: string | null;
  timeoutSec?: number | null;
  type: CommandConfiguredHookHandlerType;
  [k: string]: unknown | undefined;
}
export interface PromptConfiguredHookHandler {
  type: PromptConfiguredHookHandlerType;
  [k: string]: unknown | undefined;
}
export interface AgentConfiguredHookHandler {
  type: AgentConfiguredHookHandlerType;
  [k: string]: unknown | undefined;
}
export interface ModelsRequirements {
  newThread?: NewThreadModelDefaults | null;
  [k: string]: unknown | undefined;
}
export interface NewThreadModelDefaults {
  model?: string | null;
  modelReasoningEffort?: ReasoningEffort | null;
  serviceTier?: string | null;
  [k: string]: unknown | undefined;
}
export interface NetworkRequirements {
  allowLocalBinding?: boolean | null;
  /**
   * Legacy compatibility view derived from `unix_sockets`.
   */
  allowUnixSockets?: string[] | null;
  allowUpstreamProxy?: boolean | null;
  /**
   * Legacy compatibility view derived from `domains`.
   */
  allowedDomains?: string[] | null;
  dangerouslyAllowAllUnixSockets?: boolean | null;
  dangerouslyAllowNonLoopbackProxy?: boolean | null;
  /**
   * Legacy compatibility view derived from `domains`.
   */
  deniedDomains?: string[] | null;
  /**
   * Canonical network permission map for `experimental_network`.
   */
  domains?: {
    [k: string]: NetworkDomainPermission | undefined;
  } | null;
  enabled?: boolean | null;
  httpPort?: number | null;
  /**
   * When true, only managed allowlist entries are respected while managed network enforcement is active.
   */
  managedAllowedDomainsOnly?: boolean | null;
  socksPort?: number | null;
  /**
   * Canonical unix socket permission map for `experimental_network`.
   */
  unixSockets?: {
    [k: string]: NetworkUnixSocketPermission | undefined;
  } | null;
  [k: string]: unknown | undefined;
}
