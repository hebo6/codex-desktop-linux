// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type DynamicToolSpec = FunctionDynamicToolSpec | NamespaceDynamicToolSpec;
export type FunctionDynamicToolSpecType = "function";
export type DynamicToolNamespaceTool = FunctionDynamicToolNamespaceTool;
export type FunctionDynamicToolNamespaceToolType = "function";
export type NamespaceDynamicToolSpecType = "namespace";
export type LegacyAppPathString = string;
export type ThreadHistoryMode = "legacy" | "paginated";
/**
 * Controls the effective multi-agent delegation instructions for a turn. `custom` means the configured mode hint defines the policy instead of a built-in policy.
 */
export type MultiAgentMode = ("explicitRequestOnly" | "proactive") | CustomMultiAgentMode;
export type Personality = "none" | "friendly" | "pragmatic";
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
/**
 * Location used to resolve a selected capability root.
 */
export type CapabilityRootLocation = EnvironmentCapabilityRootLocation;
export type EnvironmentCapabilityRootLocationType = "environment";
export type ThreadStartSource = "startup" | "clear";
export type ThreadSource = string;

export interface ThreadStartParams {
  /**
   * Allow a provider with an authoritative static model catalog to replace an unavailable requested model with its default.
   */
  allowProviderModelFallback?: boolean;
  approvalPolicy?: AskForApproval | null;
  /**
   * Override where approval requests are routed for review on this thread and subsequent turns.
   */
  approvalsReviewer?: ApprovalsReviewer | null;
  baseInstructions?: string | null;
  config?: {
    [k: string]: unknown | undefined;
  } | null;
  cwd?: string | null;
  developerInstructions?: string | null;
  dynamicTools?: DynamicToolSpec[] | null;
  /**
   * Optional sticky environments for this thread.
   *
   * Omitted selects the default environment when environment access is enabled. Empty disables environment access for turns that do not provide a turn override. Non-empty selects the first environment as the current turn environment.
   */
  environments?: TurnEnvironmentParams[] | null;
  ephemeral?: boolean | null;
  /**
   * If true, opt into emitting raw Responses API items on the event stream. This is for internal use only (e.g. Codex Cloud).
   */
  experimentalRawEvents?: boolean;
  /**
   * Persisted thread history contract to use for this new thread.
   */
  historyMode?: ThreadHistoryMode | null;
  /**
   * Test-only experimental field used to validate experimental gating and schema filtering behavior in a stable way.
   */
  mockExperimentalField?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  /**
   * @deprecated Ignored. Use Ultra reasoning effort for proactive multi-agent behavior.
   */
  multiAgentMode?: MultiAgentMode | null;
  /**
   * Named profile id for this thread. Cannot be combined with `sandbox`.
   */
  permissions?: string | null;
  personality?: Personality | null;
  /**
   * Replace the thread's runtime workspace roots. Paths must be absolute.
   */
  runtimeWorkspaceRoots?: AbsolutePathBuf[] | null;
  sandbox?: SandboxMode | null;
  /**
   * Capability roots selected for this thread by the hosting platform.
   */
  selectedCapabilityRoots?: SelectedCapabilityRoot[] | null;
  serviceName?: string | null;
  serviceTier?: string | null;
  sessionStartSource?: ThreadStartSource | null;
  /**
   * Optional client-supplied analytics source classification for this thread.
   */
  threadSource?: ThreadSource | null;
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
export interface FunctionDynamicToolSpec {
  deferLoading?: boolean;
  description: string;
  inputSchema: unknown;
  name: string;
  type: FunctionDynamicToolSpecType;
  [k: string]: unknown | undefined;
}
export interface NamespaceDynamicToolSpec {
  description: string;
  name: string;
  tools: DynamicToolNamespaceTool[];
  type: NamespaceDynamicToolSpecType;
  [k: string]: unknown | undefined;
}
export interface FunctionDynamicToolNamespaceTool {
  deferLoading?: boolean;
  description: string;
  inputSchema: unknown;
  name: string;
  type: FunctionDynamicToolNamespaceToolType;
  [k: string]: unknown | undefined;
}
export interface TurnEnvironmentParams {
  cwd: LegacyAppPathString;
  environmentId: string;
  [k: string]: unknown | undefined;
}
export interface CustomMultiAgentMode {
  custom: string;
}
/**
 * A user-selected root that can expose one or more runtime capabilities.
 */
export interface SelectedCapabilityRoot {
  /**
   * Stable identifier supplied by the capability selection platform.
   */
  id: string;
  /**
   * Where the selected root can be resolved.
   */
  location: CapabilityRootLocation;
  [k: string]: unknown | undefined;
}
/**
 * A path owned by an execution environment.
 */
export interface EnvironmentCapabilityRootLocation {
  environmentId: string;
  /**
   * Absolute path for the root in the selected environment.
   */
  path: string;
  type: EnvironmentCapabilityRootLocationType;
  [k: string]: unknown | undefined;
}
