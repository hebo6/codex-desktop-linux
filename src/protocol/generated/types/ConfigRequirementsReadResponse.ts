// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex CLI 版本：codex-cli 0.157.1

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type ForcedLoginMethod = "chatgpt" | "api";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";
export type WindowsSandboxImplementation = "elevated" | "unelevated" | "mxc";
export type NetworkDomainPermission = ("allow" | "deny") | undefined;
export type AllowDenyRequirement = "allow" | "deny";
export type BrowserUseAccessApprovalLifetime = "turn" | "thread";
export type CliAuthCredentialsStoreMode = "file" | "keyring" | "auto" | "ephemeral";
export type ResidencyRequirement = "us";
export type ConfiguredHookHandler =
  | CommandConfiguredHookHandler
  | McpToolConfiguredHookHandler
  | PromptConfiguredHookHandler
  | AgentConfiguredHookHandler;
export type CommandConfiguredHookHandlerType = "command";
export type McpToolConfiguredHookHandlerType = "mcp_tool";
export type PromptConfiguredHookHandlerType = "prompt";
export type AgentConfiguredHookHandlerType = "agent";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
export type NetworkUnixSocketPermission = ("allow" | "deny") | undefined;

export interface ConfigRequirementsReadResponse {
  /**
   * Null if no requirements are configured (e.g. no requirements.toml/MDM entries).
   */
  requirements?: ConfigRequirements | null;
  [k: string]: unknown | undefined;
}
export interface ConfigRequirements {
  additionalDeveloperInstructions?: string | null;
  allowAppshots?: boolean | null;
  allowBrowserAndComputerUse?: boolean | null;
  allowLoginShell?: boolean | null;
  allowManagedHooksOnly?: boolean | null;
  allowRemoteControl?: boolean | null;
  allowedApprovalPolicies?: AskForApproval[] | null;
  allowedApprovalsReviewers?: ApprovalsReviewer[] | null;
  /**
   * Effective login methods after managed, forced-login, and workspace restrictions. An empty list permits no login method. Older servers may omit this field.
   */
  allowedLoginMethods?: ForcedLoginMethod[] | null;
  allowedPermissionProfiles?: {
    [k: string]: boolean | undefined;
  } | null;
  allowedSandboxModes?: SandboxMode[] | null;
  allowedWebSearchModes?: WebSearchMode[] | null;
  allowedWindowsSandboxImplementations?: WindowsSandboxImplementation[] | null;
  application?: ApplicationRequirements | null;
  autoReview?: AutoReviewRequirements | null;
  browserUse?: BrowserUseRequirements | null;
  chatgptBaseUrl?: string | null;
  checkForUpdateOnStartup?: boolean | null;
  cliAuthCredentialsStore?: CliAuthCredentialsStoreMode | null;
  computerUse?: ComputerUseRequirements | null;
  defaultPermissions?: string | null;
  enforceResidency?: ResidencyRequirement | null;
  featureRequirements?: {
    [k: string]: boolean | undefined;
  } | null;
  feedback?: FeedbackRequirements | null;
  hooks?: ManagedHooksRequirements | null;
  inAppBrowser?: InAppBrowserRequirements | null;
  logDir?: string | null;
  modelCatalogJson?: string | null;
  /**
   * Exact provider selection required by managed policy.
   */
  modelProvider?: string | null;
  /**
   * Complete required provider definitions, using config.toml field names.
   */
  modelProviders?: {
    [k: string]: unknown | undefined;
  } | null;
  models?: ModelsRequirements | null;
  network?: NetworkRequirements | null;
  sqliteHome?: string | null;
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
export interface ApplicationRequirements {
  network?: ApplicationNetworkRequirements | null;
  [k: string]: unknown | undefined;
}
export interface ApplicationNetworkRequirements {
  domains: {
    [k: string]: NetworkDomainPermission | undefined;
  };
  /**
   * When enabled, only explicitly allowed exact domains may be contacted.
   */
  enabled: boolean;
  [k: string]: unknown | undefined;
}
export interface AutoReviewRequirements {
  ignoreRules?: string[] | null;
  requiredOnModels?: string[] | null;
  [k: string]: unknown | undefined;
}
export interface BrowserUseRequirements {
  allowGlobalPersistentApproval?: boolean | null;
  allowHistoryAccess?: boolean | null;
  allowWebmcp?: boolean | null;
  defaultOriginPolicy?: BrowserUseOriginPolicy | null;
  disableAutoReview?: boolean | null;
  origins?: {
    [k: string]: BrowserUseOriginPolicy;
  } | null;
  [k: string]: unknown | undefined;
}
export interface BrowserUseOriginPolicy {
  access?: AllowDenyRequirement | null;
  accessApprovalLifetime?: BrowserUseAccessApprovalLifetime | null;
  autoReview?: AllowDenyRequirement | null;
  downloads?: AllowDenyRequirement | null;
  fullCdpAccess?: AllowDenyRequirement | null;
  persistentApproval?: boolean | null;
  uploads?: AllowDenyRequirement | null;
  [k: string]: unknown | undefined;
}
export interface ComputerUseRequirements {
  allowLockedComputerUse?: boolean | null;
  allowPersistentApproval?: boolean | null;
  defaultAppAccess?: AllowDenyRequirement | null;
  macos?: ComputerUseMacosRequirements | null;
  windows?: ComputerUseWindowsRequirements | null;
  [k: string]: unknown | undefined;
}
export interface ComputerUseMacosRequirements {
  bundleIds?: {
    [k: string]: AllowDenyRequirement;
  } | null;
  [k: string]: unknown | undefined;
}
export interface ComputerUseWindowsRequirements {
  aumids?: {
    [k: string]: AllowDenyRequirement;
  } | null;
  exes?: ComputerUseWindowsExeRequirement[] | null;
  [k: string]: unknown | undefined;
}
export interface ComputerUseWindowsExeRequirement {
  access: AllowDenyRequirement;
  binaryName?: string | null;
  productName: string;
  publisherName: string;
  [k: string]: unknown | undefined;
}
export interface FeedbackRequirements {
  enabled?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface ManagedHooksRequirements {
  Interrupt?: ConfiguredHookMatcherGroup[];
  PermissionRequest: ConfiguredHookMatcherGroup[];
  PostCompact: ConfiguredHookMatcherGroup[];
  PostToolUse: ConfiguredHookMatcherGroup[];
  PreCompact: ConfiguredHookMatcherGroup[];
  PreToolUse: ConfiguredHookMatcherGroup[];
  SessionEnd?: ConfiguredHookMatcherGroup[];
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
  /**
   * Approximate token threshold for spilling this hook's `additionalContext` to disk. `null` uses 2,500 tokens; `0` disables spilling for this hook. The threshold is evaluated against the original context; a spilled preview also includes recovery metadata.
   */
  additionalContextLimit?: number | null;
  async: boolean;
  command: string;
  commandWindows?: string | null;
  statusMessage?: string | null;
  timeoutSec?: number | null;
  type: CommandConfiguredHookHandlerType;
  [k: string]: unknown | undefined;
}
export interface McpToolConfiguredHookHandler {
  input: {
    [k: string]: unknown | undefined;
  };
  server: string;
  statusMessage?: string | null;
  timeoutSec?: number | null;
  tool: string;
  type: McpToolConfiguredHookHandlerType;
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
export interface InAppBrowserRequirements {
  allowExternalBrowserSettingsImport?: boolean | null;
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
