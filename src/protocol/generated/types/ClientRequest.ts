// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * Request from the client to the server.
 */
export type ClientRequest =
  | InitializeRequest
  | ThreadStartRequest
  | ThreadResumeRequest
  | ThreadForkRequest
  | ThreadArchiveRequest
  | ThreadDeleteRequest
  | ThreadUnsubscribeRequest
  | ThreadIncrementElicitationRequest
  | ThreadDecrementElicitationRequest
  | ThreadNameSetRequest
  | ThreadGoalSetRequest
  | ThreadGoalGetRequest
  | ThreadGoalClearRequest
  | ThreadMetadataUpdateRequest
  | ThreadSettingsUpdateRequest
  | ThreadMemoryModeSetRequest
  | MemoryResetRequest
  | ThreadUnarchiveRequest
  | ThreadCompactStartRequest
  | ThreadShellCommandRequest
  | ThreadApproveGuardianDeniedActionRequest
  | ThreadBackgroundTerminalsCleanRequest
  | ThreadBackgroundTerminalsListRequest
  | ThreadBackgroundTerminalsTerminateRequest
  | ThreadRollbackRequest
  | ThreadListRequest
  | ThreadSearchRequest
  | ThreadLoadedListRequest
  | ThreadReadRequest
  | ThreadTurnsListRequest
  | ThreadItemsListRequest
  | ThreadInjectItemsRequest
  | SkillsListRequest
  | SkillsExtraRootsSetRequest
  | HooksListRequest
  | MarketplaceAddRequest
  | MarketplaceRemoveRequest
  | MarketplaceUpgradeRequest
  | PluginListRequest
  | PluginInstalledRequest
  | PluginReadRequest
  | PluginSkillReadRequest
  | PluginShareSaveRequest
  | PluginShareUpdateTargetsRequest
  | PluginShareListRequest
  | PluginShareCheckoutRequest
  | PluginShareDeleteRequest
  | AppListRequest
  | FsReadFileRequest
  | FsWriteFileRequest
  | FsCreateDirectoryRequest
  | FsGetMetadataRequest
  | FsReadDirectoryRequest
  | FsRemoveRequest
  | FsCopyRequest
  | FsWatchRequest
  | FsUnwatchRequest
  | SkillsConfigWriteRequest
  | PluginInstallRequest
  | PluginUninstallRequest
  | TurnStartRequest
  | TurnSteerRequest
  | TurnInterruptRequest
  | ThreadRealtimeStartRequest
  | ThreadRealtimeAppendAudioRequest
  | ThreadRealtimeAppendTextRequest
  | ThreadRealtimeAppendSpeechRequest
  | ThreadRealtimeStopRequest
  | ThreadRealtimeListVoicesRequest
  | ReviewStartRequest
  | ModelListRequest
  | ModelProviderCapabilitiesReadRequest
  | ExperimentalFeatureListRequest
  | PermissionProfileListRequest
  | ExperimentalFeatureEnablementSetRequest
  | RemoteControlEnableRequest
  | RemoteControlDisableRequest
  | RemoteControlStatusReadRequest
  | RemoteControlPairingStartRequest
  | RemoteControlPairingStatusRequest
  | RemoteControlClientListRequest
  | RemoteControlClientRevokeRequest
  | CollaborationModeListRequest
  | MockExperimentalMethodRequest
  | EnvironmentAddRequest
  | EnvironmentInfoRequest
  | McpServerOauthLoginRequest
  | ConfigMcpServerReloadRequest
  | McpServerStatusListRequest
  | McpServerResourceReadRequest
  | McpServerToolCallRequest
  | WindowsSandboxSetupStartRequest
  | WindowsSandboxReadinessRequest
  | AccountLoginStartRequest
  | AccountLoginCancelRequest
  | AccountLogoutRequest
  | AccountRateLimitsReadRequest
  | AccountRateLimitResetCreditConsumeRequest
  | AccountUsageReadRequest
  | AccountWorkspaceMessagesReadRequest
  | AccountSendAddCreditsNudgeEmailRequest
  | FeedbackUploadRequest
  | CommandExecRequest
  | CommandExecWriteRequest
  | CommandExecTerminateRequest
  | CommandExecResizeRequest
  | ProcessSpawnRequest
  | ProcessWriteStdinRequest
  | ProcessKillRequest
  | ProcessResizePtyRequest
  | ConfigReadRequest
  | ExternalAgentConfigDetectRequest
  | ExternalAgentConfigImportRequest
  | ExternalAgentConfigImportReadHistoriesRequest
  | ConfigValueWriteRequest
  | ConfigBatchWriteRequest
  | ConfigRequirementsReadRequest
  | AccountReadRequest
  | FuzzyFileSearchRequest
  | FuzzyFileSearchSessionStartRequest
  | FuzzyFileSearchSessionUpdateRequest
  | FuzzyFileSearchSessionStopRequest;
export type RequestId = string | number;
export type InitializeRequestMethod = "initialize";
export type ThreadStartRequestMethod = "thread/start";
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
export type ThreadResumeRequestMethod = "thread/resume";
export type ResponseItem =
  | MessageResponseItem
  | AgentMessageResponseItem
  | ReasoningResponseItem
  | LocalShellCallResponseItem
  | FunctionCallResponseItem
  | ToolSearchCallResponseItem
  | FunctionCallOutputResponseItem
  | CustomToolCallResponseItem
  | CustomToolCallOutputResponseItem
  | ToolSearchOutputResponseItem
  | WebSearchCallResponseItem
  | ImageGenerationCallResponseItem
  | CompactionResponseItem
  | CompactionTriggerResponseItem
  | ContextCompactionResponseItem
  | OtherResponseItem;
export type ContentItem = InputTextContentItem | InputImageContentItem | OutputTextContentItem;
export type InputTextContentItemType = "input_text";
export type ImageDetail = "auto" | "low" | "high" | "original";
export type InputImageContentItemType = "input_image";
export type OutputTextContentItemType = "output_text";
/**
 * Classifies an assistant message as interim commentary or final answer text.
 *
 * Providers do not emit this consistently, so callers must treat `None` as "phase unknown" and keep compatibility behavior for legacy models.
 */
export type MessagePhase = "commentary" | "final_answer";
export type MessageResponseItemType = "message";
export type AgentMessageInputContent =
  InputTextAgentMessageInputContent | EncryptedContentAgentMessageInputContent;
export type InputTextAgentMessageInputContentType = "input_text";
export type EncryptedContentAgentMessageInputContentType = "encrypted_content";
export type AgentMessageResponseItemType = "agent_message";
export type ReasoningItemContent = ReasoningTextReasoningItemContent | TextReasoningItemContent;
export type ReasoningTextReasoningItemContentType = "reasoning_text";
export type TextReasoningItemContentType = "text";
export type ReasoningItemReasoningSummary = SummaryTextReasoningItemReasoningSummary;
export type SummaryTextReasoningItemReasoningSummaryType = "summary_text";
export type ReasoningResponseItemType = "reasoning";
export type LocalShellAction = ExecLocalShellAction;
export type ExecLocalShellActionType = "exec";
export type LocalShellStatus = "completed" | "in_progress" | "incomplete";
export type LocalShellCallResponseItemType = "local_shell_call";
export type FunctionCallResponseItemType = "function_call";
export type ToolSearchCallResponseItemType = "tool_search_call";
export type FunctionCallOutputBody = string | FunctionCallOutputContentItem[];
/**
 * Responses API compatible content items that can be returned by a tool call. This is a subset of ContentItem with the types we support as function call outputs.
 */
export type FunctionCallOutputContentItem =
  | InputTextFunctionCallOutputContentItem
  | InputImageFunctionCallOutputContentItem
  | EncryptedContentFunctionCallOutputContentItem;
export type InputTextFunctionCallOutputContentItemType = "input_text";
export type InputImageFunctionCallOutputContentItemType = "input_image";
export type EncryptedContentFunctionCallOutputContentItemType = "encrypted_content";
export type FunctionCallOutputResponseItemType = "function_call_output";
export type CustomToolCallResponseItemType = "custom_tool_call";
export type CustomToolCallOutputResponseItemType = "custom_tool_call_output";
export type ToolSearchOutputResponseItemType = "tool_search_output";
export type ResponsesApiWebSearchAction =
  | SearchResponsesApiWebSearchAction
  | OpenPageResponsesApiWebSearchAction
  | FindInPageResponsesApiWebSearchAction
  | OtherResponsesApiWebSearchAction;
export type SearchResponsesApiWebSearchActionType = "search";
export type OpenPageResponsesApiWebSearchActionType = "open_page";
export type FindInPageResponsesApiWebSearchActionType = "find_in_page";
export type OtherResponsesApiWebSearchActionType = "other";
export type WebSearchCallResponseItemType = "web_search_call";
export type ImageGenerationCallResponseItemType = "image_generation_call";
export type CompactionResponseItemType = "compaction";
export type CompactionTriggerResponseItemType = "compaction_trigger";
export type ContextCompactionResponseItemType = "context_compaction";
export type OtherResponseItemType = "other";
export type TurnItemsView = "notLoaded" | "summary" | "full";
export type SortDirection = "asc" | "desc";
export type ThreadForkRequestMethod = "thread/fork";
export type ThreadArchiveRequestMethod = "thread/archive";
export type ThreadDeleteRequestMethod = "thread/delete";
export type ThreadUnsubscribeRequestMethod = "thread/unsubscribe";
export type ThreadIncrementElicitationRequestMethod = "thread/increment_elicitation";
export type ThreadDecrementElicitationRequestMethod = "thread/decrement_elicitation";
export type ThreadNameSetRequestMethod = "thread/name/set";
export type ThreadGoalSetRequestMethod = "thread/goal/set";
export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export type ThreadGoalGetRequestMethod = "thread/goal/get";
export type ThreadGoalClearRequestMethod = "thread/goal/clear";
export type ThreadMetadataUpdateRequestMethod = "thread/metadata/update";
export type ThreadSettingsUpdateRequestMethod = "thread/settings/update";
/**
 * Initial collaboration mode to use when the TUI starts.
 */
export type ModeKind = "plan" | "default";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
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
 * A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
 */
export type ReasoningSummary = ("auto" | "concise" | "detailed") | "none";
export type ThreadMemoryModeSetRequestMethod = "thread/memoryMode/set";
export type ThreadMemoryMode = "enabled" | "disabled";
export type MemoryResetRequestMethod = "memory/reset";
export type ThreadUnarchiveRequestMethod = "thread/unarchive";
export type ThreadCompactStartRequestMethod = "thread/compact/start";
export type ThreadShellCommandRequestMethod = "thread/shellCommand";
export type ThreadApproveGuardianDeniedActionRequestMethod = "thread/approveGuardianDeniedAction";
export type ThreadBackgroundTerminalsCleanRequestMethod = "thread/backgroundTerminals/clean";
export type ThreadBackgroundTerminalsListRequestMethod = "thread/backgroundTerminals/list";
export type ThreadBackgroundTerminalsTerminateRequestMethod =
  "thread/backgroundTerminals/terminate";
export type ThreadRollbackRequestMethod = "thread/rollback";
export type ThreadListRequestMethod = "thread/list";
export type ThreadListCwdFilter = string | string[];
export type ThreadSortKey = "created_at" | "updated_at" | "recency_at";
export type ThreadSourceKind =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";
export type ThreadSearchRequestMethod = "thread/search";
export type ThreadLoadedListRequestMethod = "thread/loaded/list";
export type ThreadReadRequestMethod = "thread/read";
export type ThreadTurnsListRequestMethod = "thread/turns/list";
export type ThreadItemsListRequestMethod = "thread/items/list";
export type ThreadInjectItemsRequestMethod = "thread/inject_items";
export type SkillsListRequestMethod = "skills/list";
export type SkillsExtraRootsSetRequestMethod = "skills/extraRoots/set";
export type HooksListRequestMethod = "hooks/list";
export type MarketplaceAddRequestMethod = "marketplace/add";
export type MarketplaceRemoveRequestMethod = "marketplace/remove";
export type MarketplaceUpgradeRequestMethod = "marketplace/upgrade";
export type PluginListRequestMethod = "plugin/list";
export type PluginListMarketplaceKind =
  "local" | "vertical" | "workspace-directory" | "shared-with-me" | "created-by-me-remote";
export type PluginInstalledRequestMethod = "plugin/installed";
export type PluginReadRequestMethod = "plugin/read";
export type PluginSkillReadRequestMethod = "plugin/skill/read";
export type PluginShareSaveRequestMethod = "plugin/share/save";
export type PluginShareDiscoverability = "LISTED" | "UNLISTED" | "PRIVATE";
export type PluginSharePrincipalType = "user" | "group" | "workspace";
export type PluginShareTargetRole = "reader" | "editor";
export type PluginShareUpdateTargetsRequestMethod = "plugin/share/updateTargets";
export type PluginShareUpdateDiscoverability = "UNLISTED" | "PRIVATE";
export type PluginShareListRequestMethod = "plugin/share/list";
export type PluginShareCheckoutRequestMethod = "plugin/share/checkout";
export type PluginShareDeleteRequestMethod = "plugin/share/delete";
export type AppListRequestMethod = "app/list";
export type FsReadFileRequestMethod = "fs/readFile";
export type FsWriteFileRequestMethod = "fs/writeFile";
export type FsCreateDirectoryRequestMethod = "fs/createDirectory";
export type FsGetMetadataRequestMethod = "fs/getMetadata";
export type FsReadDirectoryRequestMethod = "fs/readDirectory";
export type FsRemoveRequestMethod = "fs/remove";
export type FsCopyRequestMethod = "fs/copy";
export type FsWatchRequestMethod = "fs/watch";
export type FsUnwatchRequestMethod = "fs/unwatch";
export type SkillsConfigWriteRequestMethod = "skills/config/write";
export type PluginInstallRequestMethod = "plugin/install";
export type PluginUninstallRequestMethod = "plugin/uninstall";
export type TurnStartRequestMethod = "turn/start";
export type AdditionalContextKind = "untrusted" | "application";
export type UserInput =
  TextUserInput | ImageUserInput | LocalImageUserInput | SkillUserInput | MentionUserInput;
export type TextUserInputType = "text";
export type ImageUserInputType = "image";
export type LocalImageUserInputType = "localImage";
export type SkillUserInputType = "skill";
export type MentionUserInputType = "mention";
export type TurnSteerRequestMethod = "turn/steer";
export type TurnInterruptRequestMethod = "turn/interrupt";
export type ThreadRealtimeStartRequestMethod = "thread/realtime/start";
export type RealtimeOutputModality = "text" | "audio";
/**
 * EXPERIMENTAL - transport used by thread realtime.
 */
export type ThreadRealtimeStartTransport =
  WebsocketThreadRealtimeStartTransport | WebrtcThreadRealtimeStartTransport;
export type WebsocketThreadRealtimeStartTransportType = "websocket";
export type WebrtcThreadRealtimeStartTransportType = "webrtc";
export type RealtimeConversationVersion = "v1" | "v2";
export type RealtimeVoice =
  | "alloy"
  | "arbor"
  | "ash"
  | "ballad"
  | "breeze"
  | "cedar"
  | "coral"
  | "cove"
  | "echo"
  | "ember"
  | "juniper"
  | "maple"
  | "marin"
  | "sage"
  | "shimmer"
  | "sol"
  | "spruce"
  | "vale"
  | "verse";
export type ThreadRealtimeAppendAudioRequestMethod = "thread/realtime/appendAudio";
export type ThreadRealtimeAppendTextRequestMethod = "thread/realtime/appendText";
export type ConversationTextRole = "user" | "developer" | "assistant";
export type ThreadRealtimeAppendSpeechRequestMethod = "thread/realtime/appendSpeech";
export type ThreadRealtimeStopRequestMethod = "thread/realtime/stop";
export type ThreadRealtimeListVoicesRequestMethod = "thread/realtime/listVoices";
export type ReviewStartRequestMethod = "review/start";
export type ReviewDelivery = "inline" | "detached";
export type ReviewTarget =
  UncommittedChangesReviewTarget | BaseBranchReviewTarget | CommitReviewTarget | CustomReviewTarget;
export type UncommittedChangesReviewTargetType = "uncommittedChanges";
export type BaseBranchReviewTargetType = "baseBranch";
export type CommitReviewTargetType = "commit";
export type CustomReviewTargetType = "custom";
export type ModelListRequestMethod = "model/list";
export type ModelProviderCapabilitiesReadRequestMethod = "modelProvider/capabilities/read";
export type ExperimentalFeatureListRequestMethod = "experimentalFeature/list";
export type PermissionProfileListRequestMethod = "permissionProfile/list";
export type ExperimentalFeatureEnablementSetRequestMethod = "experimentalFeature/enablement/set";
export type RemoteControlEnableRequestMethod = "remoteControl/enable";
export type RemoteControlDisableRequestMethod = "remoteControl/disable";
export type RemoteControlStatusReadRequestMethod = "remoteControl/status/read";
export type RemoteControlPairingStartRequestMethod = "remoteControl/pairing/start";
export type RemoteControlPairingStatusRequestMethod = "remoteControl/pairing/status";
export type RemoteControlClientListRequestMethod = "remoteControl/client/list";
export type RemoteControlClientsListOrder = "asc" | "desc";
export type RemoteControlClientRevokeRequestMethod = "remoteControl/client/revoke";
export type CollaborationModeListRequestMethod = "collaborationMode/list";
export type MockExperimentalMethodRequestMethod = "mock/experimentalMethod";
export type EnvironmentAddRequestMethod = "environment/add";
export type EnvironmentInfoRequestMethod = "environment/info";
export type McpServerOauthLoginRequestMethod = "mcpServer/oauth/login";
export type ConfigMcpServerReloadRequestMethod = "config/mcpServer/reload";
export type McpServerStatusListRequestMethod = "mcpServerStatus/list";
export type McpServerStatusDetail = "full" | "toolsAndAuthOnly";
export type McpServerResourceReadRequestMethod = "mcpServer/resource/read";
export type McpServerToolCallRequestMethod = "mcpServer/tool/call";
export type WindowsSandboxSetupStartRequestMethod = "windowsSandbox/setupStart";
export type WindowsSandboxSetupMode = "elevated" | "unelevated";
export type WindowsSandboxReadinessRequestMethod = "windowsSandbox/readiness";
export type AccountLoginStartRequestMethod = "account/login/start";
export type LoginAccountParams =
  | ApiKeyLoginAccountParams
  | ChatgptLoginAccountParams
  | ChatgptDeviceCodeLoginAccountParams
  | ChatgptAuthTokensLoginAccountParams;
export type ApiKeyLoginAccountParamsType = "apiKey";
export type LoginAppBrand = "codex" | "chatgpt";
export type ChatgptLoginAccountParamsType = "chatgpt";
export type ChatgptDeviceCodeLoginAccountParamsType = "chatgptDeviceCode";
export type ChatgptAuthTokensLoginAccountParamsType = "chatgptAuthTokens";
export type AccountLoginCancelRequestMethod = "account/login/cancel";
export type AccountLogoutRequestMethod = "account/logout";
export type AccountRateLimitsReadRequestMethod = "account/rateLimits/read";
export type AccountRateLimitResetCreditConsumeRequestMethod =
  "account/rateLimitResetCredit/consume";
export type AccountUsageReadRequestMethod = "account/usage/read";
export type AccountWorkspaceMessagesReadRequestMethod = "account/workspaceMessages/read";
export type AccountSendAddCreditsNudgeEmailRequestMethod = "account/sendAddCreditsNudgeEmail";
export type AddCreditsNudgeCreditType = "credits" | "usage_limit";
export type FeedbackUploadRequestMethod = "feedback/upload";
export type CommandExecRequestMethod = "command/exec";
export type CommandExecWriteRequestMethod = "command/exec/write";
export type CommandExecTerminateRequestMethod = "command/exec/terminate";
export type CommandExecResizeRequestMethod = "command/exec/resize";
export type ProcessSpawnRequestMethod = "process/spawn";
export type ProcessWriteStdinRequestMethod = "process/writeStdin";
export type ProcessKillRequestMethod = "process/kill";
export type ProcessResizePtyRequestMethod = "process/resizePty";
export type ConfigReadRequestMethod = "config/read";
export type ExternalAgentConfigDetectRequestMethod = "externalAgentConfig/detect";
export type ExternalAgentConfigImportRequestMethod = "externalAgentConfig/import";
export type ExternalAgentConfigMigrationItemType =
  | "AGENTS_MD"
  | "CONFIG"
  | "SKILLS"
  | "PLUGINS"
  | "MCP_SERVER_CONFIG"
  | "SUBAGENTS"
  | "HOOKS"
  | "COMMANDS"
  | "SESSIONS";
export type ExternalAgentConfigImportReadHistoriesRequestMethod =
  "externalAgentConfig/import/readHistories";
export type ConfigValueWriteRequestMethod = "config/value/write";
export type MergeStrategy = "replace" | "upsert";
export type ConfigBatchWriteRequestMethod = "config/batchWrite";
export type ConfigRequirementsReadRequestMethod = "configRequirements/read";
export type AccountReadRequestMethod = "account/read";
export type FuzzyFileSearchRequestMethod = "fuzzyFileSearch";
export type FuzzyFileSearchSessionStartRequestMethod = "fuzzyFileSearch/sessionStart";
export type FuzzyFileSearchSessionUpdateRequestMethod = "fuzzyFileSearch/sessionUpdate";
export type FuzzyFileSearchSessionStopRequestMethod = "fuzzyFileSearch/sessionStop";

export interface InitializeRequest {
  id: RequestId;
  method: InitializeRequestMethod;
  params: InitializeParams;
  [k: string]: unknown | undefined;
}
export interface InitializeParams {
  capabilities?: InitializeCapabilities | null;
  clientInfo: ClientInfo;
  [k: string]: unknown | undefined;
}
/**
 * Client-declared capabilities negotiated during initialize.
 */
export interface InitializeCapabilities {
  /**
   * Opt into receiving experimental API methods and fields.
   */
  experimentalApi?: boolean;
  /**
   * Allow downstream MCP servers to request OpenAI extended form elicitations.
   */
  mcpServerOpenaiFormElicitation?: boolean;
  /**
   * Exact notification method names that should be suppressed for this connection (for example `thread/started`).
   */
  optOutNotificationMethods?: string[] | null;
  /**
   * Opt into `attestation/generate` requests for upstream `x-oai-attestation`.
   */
  requestAttestation?: boolean;
  [k: string]: unknown | undefined;
}
export interface ClientInfo {
  name: string;
  title?: string | null;
  version: string;
  [k: string]: unknown | undefined;
}
/**
 * NEW APIs
 */
export interface ThreadStartRequest {
  id: RequestId;
  method: ThreadStartRequestMethod;
  params: ThreadStartParams;
  [k: string]: unknown | undefined;
}
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
export interface ThreadResumeRequest {
  id: RequestId;
  method: ThreadResumeRequestMethod;
  params: ThreadResumeParams;
  [k: string]: unknown | undefined;
}
/**
 * There are three ways to resume a thread: 1. By thread_id: load the thread from disk by thread_id and resume it. 2. By history: instantiate the thread from memory and resume it. 3. By path: load the thread from disk by path and resume it.
 *
 * For non-running threads, the precedence is: history > non-empty path > thread_id. If using history or a non-empty path for a non-running thread, the thread_id param will be ignored.
 *
 * If thread_id identifies a running thread, app-server rejoins that thread and treats a non-empty path as a consistency check against the active rollout path. Empty string path values are treated as absent.
 *
 * Prefer using thread_id whenever possible.
 */
export interface ThreadResumeParams {
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
  /**
   * When true, return only thread metadata and live-resume state without populating `thread.turns`. This is useful when the client plans to call `thread/turns/list` immediately after resuming.
   */
  excludeTurns?: boolean;
  /**
   * [UNSTABLE] FOR CODEX CLOUD - DO NOT USE. If specified, the thread will be resumed with the provided history instead of loaded from disk.
   */
  history?: ResponseItem[] | null;
  /**
   * When present, include a `thread/turns/list` page in the resume response so clients can bootstrap recent turns without a second request.
   */
  initialTurnsPage?: ThreadResumeInitialTurnsPageParams | null;
  /**
   * Configuration overrides for the resumed thread, if any.
   */
  model?: string | null;
  modelProvider?: string | null;
  /**
   * [UNSTABLE] Specify the rollout path to resume from. If specified for a non-running thread, the thread_id param will be ignored. If thread_id identifies a running thread, the path must match the active rollout path.
   */
  path?: string | null;
  /**
   * Named profile id for the resumed thread. Cannot be combined with `sandbox`.
   */
  permissions?: string | null;
  personality?: Personality | null;
  /**
   * Replace the thread's runtime workspace roots. Paths must be absolute.
   */
  runtimeWorkspaceRoots?: AbsolutePathBuf[] | null;
  sandbox?: SandboxMode | null;
  serviceTier?: string | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface MessageResponseItem {
  content: ContentItem[];
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  phase?: MessagePhase | null;
  role: string;
  type: MessageResponseItemType;
  [k: string]: unknown | undefined;
}
export interface InputTextContentItem {
  text: string;
  type: InputTextContentItemType;
  [k: string]: unknown | undefined;
}
export interface InputImageContentItem {
  detail?: ImageDetail | null;
  image_url: string;
  type: InputImageContentItemType;
  [k: string]: unknown | undefined;
}
export interface OutputTextContentItem {
  text: string;
  type: OutputTextContentItemType;
  [k: string]: unknown | undefined;
}
/**
 * Internal Responses API passthrough metadata copied into underlying chat messages.
 *
 * Responses API strongly types this payload. Do not modify it without first getting API approval and making the corresponding Responses API change.
 */
export interface InternalChatMessageMetadataPassthrough {
  turn_id?: string | null;
  [k: string]: unknown | undefined;
}
export interface AgentMessageResponseItem {
  author: string;
  content: AgentMessageInputContent[];
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  recipient: string;
  type: AgentMessageResponseItemType;
  [k: string]: unknown | undefined;
}
export interface InputTextAgentMessageInputContent {
  text: string;
  type: InputTextAgentMessageInputContentType;
  [k: string]: unknown | undefined;
}
export interface EncryptedContentAgentMessageInputContent {
  encrypted_content: string;
  type: EncryptedContentAgentMessageInputContentType;
  [k: string]: unknown | undefined;
}
export interface ReasoningResponseItem {
  content?: ReasoningItemContent[] | null;
  encrypted_content?: string | null;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  summary: ReasoningItemReasoningSummary[];
  type: ReasoningResponseItemType;
  [k: string]: unknown | undefined;
}
export interface ReasoningTextReasoningItemContent {
  text: string;
  type: ReasoningTextReasoningItemContentType;
  [k: string]: unknown | undefined;
}
export interface TextReasoningItemContent {
  text: string;
  type: TextReasoningItemContentType;
  [k: string]: unknown | undefined;
}
export interface SummaryTextReasoningItemReasoningSummary {
  text: string;
  type: SummaryTextReasoningItemReasoningSummaryType;
  [k: string]: unknown | undefined;
}
export interface LocalShellCallResponseItem {
  action: LocalShellAction;
  /**
   * Set when using the Responses API.
   */
  call_id?: string | null;
  /**
   * Legacy id field retained for compatibility with older payloads.
   */
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  status: LocalShellStatus;
  type: LocalShellCallResponseItemType;
  [k: string]: unknown | undefined;
}
export interface ExecLocalShellAction {
  command: string[];
  env?: {
    [k: string]: string | undefined;
  } | null;
  timeout_ms?: number | null;
  type: ExecLocalShellActionType;
  user?: string | null;
  working_directory?: string | null;
  [k: string]: unknown | undefined;
}
export interface FunctionCallResponseItem {
  arguments: string;
  call_id: string;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  name: string;
  namespace?: string | null;
  type: FunctionCallResponseItemType;
  [k: string]: unknown | undefined;
}
export interface ToolSearchCallResponseItem {
  arguments: unknown;
  call_id?: string | null;
  execution: string;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  status?: string | null;
  type: ToolSearchCallResponseItemType;
  [k: string]: unknown | undefined;
}
export interface FunctionCallOutputResponseItem {
  call_id: string;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  output: FunctionCallOutputBody;
  type: FunctionCallOutputResponseItemType;
  [k: string]: unknown | undefined;
}
export interface InputTextFunctionCallOutputContentItem {
  text: string;
  type: InputTextFunctionCallOutputContentItemType;
  [k: string]: unknown | undefined;
}
export interface InputImageFunctionCallOutputContentItem {
  detail?: ImageDetail | null;
  image_url: string;
  type: InputImageFunctionCallOutputContentItemType;
  [k: string]: unknown | undefined;
}
export interface EncryptedContentFunctionCallOutputContentItem {
  encrypted_content: string;
  type: EncryptedContentFunctionCallOutputContentItemType;
  [k: string]: unknown | undefined;
}
export interface CustomToolCallResponseItem {
  call_id: string;
  id?: string | null;
  input: string;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  name: string;
  namespace?: string | null;
  status?: string | null;
  type: CustomToolCallResponseItemType;
  [k: string]: unknown | undefined;
}
export interface CustomToolCallOutputResponseItem {
  call_id: string;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  name?: string | null;
  output: FunctionCallOutputBody;
  type: CustomToolCallOutputResponseItemType;
  [k: string]: unknown | undefined;
}
export interface ToolSearchOutputResponseItem {
  call_id?: string | null;
  execution: string;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  status: string;
  tools: unknown[];
  type: ToolSearchOutputResponseItemType;
  [k: string]: unknown | undefined;
}
export interface WebSearchCallResponseItem {
  action?: ResponsesApiWebSearchAction | null;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  status?: string | null;
  type: WebSearchCallResponseItemType;
  [k: string]: unknown | undefined;
}
export interface SearchResponsesApiWebSearchAction {
  queries?: string[] | null;
  query?: string | null;
  type: SearchResponsesApiWebSearchActionType;
  [k: string]: unknown | undefined;
}
export interface OpenPageResponsesApiWebSearchAction {
  type: OpenPageResponsesApiWebSearchActionType;
  url?: string | null;
  [k: string]: unknown | undefined;
}
export interface FindInPageResponsesApiWebSearchAction {
  pattern?: string | null;
  type: FindInPageResponsesApiWebSearchActionType;
  url?: string | null;
  [k: string]: unknown | undefined;
}
export interface OtherResponsesApiWebSearchAction {
  type: OtherResponsesApiWebSearchActionType;
  [k: string]: unknown | undefined;
}
export interface ImageGenerationCallResponseItem {
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  result: string;
  revised_prompt?: string | null;
  status: string;
  type: ImageGenerationCallResponseItemType;
  [k: string]: unknown | undefined;
}
export interface CompactionResponseItem {
  encrypted_content: string;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  type: CompactionResponseItemType;
  [k: string]: unknown | undefined;
}
export interface CompactionTriggerResponseItem {
  type: CompactionTriggerResponseItemType;
  [k: string]: unknown | undefined;
}
export interface ContextCompactionResponseItem {
  encrypted_content?: string | null;
  id?: string | null;
  internal_chat_message_metadata_passthrough?: InternalChatMessageMetadataPassthrough | null;
  type: ContextCompactionResponseItemType;
  [k: string]: unknown | undefined;
}
export interface OtherResponseItem {
  type: OtherResponseItemType;
  [k: string]: unknown | undefined;
}
export interface ThreadResumeInitialTurnsPageParams {
  /**
   * How much item detail to include for each returned turn; defaults to summary.
   */
  itemsView?: TurnItemsView | null;
  /**
   * Optional turn page size.
   */
  limit?: number | null;
  /**
   * Optional turn pagination direction; defaults to descending.
   */
  sortDirection?: SortDirection | null;
  [k: string]: unknown | undefined;
}
export interface ThreadForkRequest {
  id: RequestId;
  method: ThreadForkRequestMethod;
  params: ThreadForkParams;
  [k: string]: unknown | undefined;
}
/**
 * There are two ways to fork a thread: 1. By thread_id: load the thread from disk by thread_id and fork it into a new thread. 2. By path: load the thread from disk by path and fork it into a new thread.
 *
 * If using a non-empty path, the thread_id param will be ignored. Empty string path values are treated as absent.
 *
 * Prefer using thread_id whenever possible.
 */
export interface ThreadForkParams {
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
  ephemeral?: boolean;
  /**
   * When true, return only thread metadata and live fork state without populating `thread.turns`. This is useful when the client plans to call `thread/turns/list` immediately after forking.
   */
  excludeTurns?: boolean;
  /**
   * Optional last turn id to fork through, inclusive.
   *
   * When specified, turns after `last_turn_id` are omitted from the fork. The referenced turn cannot be in progress.
   */
  lastTurnId?: string | null;
  /**
   * Configuration overrides for the forked thread, if any.
   */
  model?: string | null;
  modelProvider?: string | null;
  /**
   * [UNSTABLE] Specify the rollout path to fork from. If specified, the thread_id param will be ignored.
   */
  path?: string | null;
  /**
   * Named profile id for the forked thread. Cannot be combined with `sandbox`.
   */
  permissions?: string | null;
  /**
   * Replace the thread's runtime workspace roots. Paths must be absolute.
   */
  runtimeWorkspaceRoots?: AbsolutePathBuf[] | null;
  sandbox?: SandboxMode | null;
  serviceTier?: string | null;
  threadId: string;
  /**
   * Optional client-supplied analytics source classification for this forked thread.
   */
  threadSource?: ThreadSource | null;
  [k: string]: unknown | undefined;
}
export interface ThreadArchiveRequest {
  id: RequestId;
  method: ThreadArchiveRequestMethod;
  params: ThreadArchiveParams;
  [k: string]: unknown | undefined;
}
export interface ThreadArchiveParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadDeleteRequest {
  id: RequestId;
  method: ThreadDeleteRequestMethod;
  params: ThreadDeleteParams;
  [k: string]: unknown | undefined;
}
export interface ThreadDeleteParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadUnsubscribeRequest {
  id: RequestId;
  method: ThreadUnsubscribeRequestMethod;
  params: ThreadUnsubscribeParams;
  [k: string]: unknown | undefined;
}
export interface ThreadUnsubscribeParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
/**
 * Increment the thread-local out-of-band elicitation counter.
 *
 * This is used by external helpers to pause timeout accounting while a user approval or other elicitation is pending outside the app-server request flow.
 */
export interface ThreadIncrementElicitationRequest {
  id: RequestId;
  method: ThreadIncrementElicitationRequestMethod;
  params: ThreadIncrementElicitationParams;
  [k: string]: unknown | undefined;
}
/**
 * Parameters for `thread/increment_elicitation`.
 */
export interface ThreadIncrementElicitationParams {
  /**
   * Thread whose out-of-band elicitation counter should be incremented.
   */
  threadId: string;
  [k: string]: unknown | undefined;
}
/**
 * Decrement the thread-local out-of-band elicitation counter.
 *
 * When the count reaches zero, timeout accounting resumes for the thread.
 */
export interface ThreadDecrementElicitationRequest {
  id: RequestId;
  method: ThreadDecrementElicitationRequestMethod;
  params: ThreadDecrementElicitationParams;
  [k: string]: unknown | undefined;
}
/**
 * Parameters for `thread/decrement_elicitation`.
 */
export interface ThreadDecrementElicitationParams {
  /**
   * Thread whose out-of-band elicitation counter should be decremented.
   */
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadNameSetRequest {
  id: RequestId;
  method: ThreadNameSetRequestMethod;
  params: ThreadSetNameParams;
  [k: string]: unknown | undefined;
}
export interface ThreadSetNameParams {
  name: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalSetRequest {
  id: RequestId;
  method: ThreadGoalSetRequestMethod;
  params: ThreadGoalSetParams;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalSetParams {
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  threadId: string;
  tokenBudget?: number | null;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalGetRequest {
  id: RequestId;
  method: ThreadGoalGetRequestMethod;
  params: ThreadGoalGetParams;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalGetParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalClearRequest {
  id: RequestId;
  method: ThreadGoalClearRequestMethod;
  params: ThreadGoalClearParams;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalClearParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadMetadataUpdateRequest {
  id: RequestId;
  method: ThreadMetadataUpdateRequestMethod;
  params: ThreadMetadataUpdateParams;
  [k: string]: unknown | undefined;
}
export interface ThreadMetadataUpdateParams {
  /**
   * Patch the stored Git metadata for this thread. Omit a field to leave it unchanged, set it to `null` to clear it, or provide a string to replace the stored value.
   */
  gitInfo?: ThreadMetadataGitInfoUpdateParams | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadMetadataGitInfoUpdateParams {
  /**
   * Omit to leave the stored branch unchanged, set to `null` to clear it, or provide a non-empty string to replace it.
   */
  branch?: string | null;
  /**
   * Omit to leave the stored origin URL unchanged, set to `null` to clear it, or provide a non-empty string to replace it.
   */
  originUrl?: string | null;
  /**
   * Omit to leave the stored commit unchanged, set to `null` to clear it, or provide a non-empty string to replace it.
   */
  sha?: string | null;
  [k: string]: unknown | undefined;
}
export interface ThreadSettingsUpdateRequest {
  id: RequestId;
  method: ThreadSettingsUpdateRequestMethod;
  params: ThreadSettingsUpdateParams;
  [k: string]: unknown | undefined;
}
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
export interface ThreadMemoryModeSetRequest {
  id: RequestId;
  method: ThreadMemoryModeSetRequestMethod;
  params: ThreadMemoryModeSetParams;
  [k: string]: unknown | undefined;
}
export interface ThreadMemoryModeSetParams {
  mode: ThreadMemoryMode;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface MemoryResetRequest {
  id: RequestId;
  method: MemoryResetRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface ThreadUnarchiveRequest {
  id: RequestId;
  method: ThreadUnarchiveRequestMethod;
  params: ThreadUnarchiveParams;
  [k: string]: unknown | undefined;
}
export interface ThreadUnarchiveParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadCompactStartRequest {
  id: RequestId;
  method: ThreadCompactStartRequestMethod;
  params: ThreadCompactStartParams;
  [k: string]: unknown | undefined;
}
export interface ThreadCompactStartParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadShellCommandRequest {
  id: RequestId;
  method: ThreadShellCommandRequestMethod;
  params: ThreadShellCommandParams;
  [k: string]: unknown | undefined;
}
export interface ThreadShellCommandParams {
  /**
   * Shell command string evaluated by the thread's configured shell. Unlike `command/exec`, this intentionally preserves shell syntax such as pipes, redirects, and quoting. This runs unsandboxed with full access rather than inheriting the thread sandbox policy.
   */
  command: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadApproveGuardianDeniedActionRequest {
  id: RequestId;
  method: ThreadApproveGuardianDeniedActionRequestMethod;
  params: ThreadApproveGuardianDeniedActionParams;
  [k: string]: unknown | undefined;
}
export interface ThreadApproveGuardianDeniedActionParams {
  /**
   * Serialized `codex_protocol::protocol::GuardianAssessmentEvent`.
   */
  event: {
    [k: string]: unknown | undefined;
  };
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminalsCleanRequest {
  id: RequestId;
  method: ThreadBackgroundTerminalsCleanRequestMethod;
  params: ThreadBackgroundTerminalsCleanParams;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminalsCleanParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminalsListRequest {
  id: RequestId;
  method: ThreadBackgroundTerminalsListRequestMethod;
  params: ThreadBackgroundTerminalsListParams;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminalsListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional page size.
   */
  limit?: number | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminalsTerminateRequest {
  id: RequestId;
  method: ThreadBackgroundTerminalsTerminateRequestMethod;
  params: ThreadBackgroundTerminalsTerminateParams;
  [k: string]: unknown | undefined;
}
export interface ThreadBackgroundTerminalsTerminateParams {
  processId: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRollbackRequest {
  id: RequestId;
  method: ThreadRollbackRequestMethod;
  params: ThreadRollbackParams;
  [k: string]: unknown | undefined;
}
/**
 * DEPRECATED: `thread/rollback` will be removed soon.
 */
export interface ThreadRollbackParams {
  /**
   * The number of turns to drop from the end of the thread. Must be >= 1.
   *
   * This only modifies the thread's history and does not revert local file changes that have been made by the agent. Clients are responsible for reverting these changes.
   */
  numTurns: number;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadListRequest {
  id: RequestId;
  method: ThreadListRequestMethod;
  params: ThreadListParams;
  [k: string]: unknown | undefined;
}
export interface ThreadListParams {
  /**
   * Optional ancestor thread filter. Returns spawned descendants at any depth, excluding the ancestor itself. Mutually exclusive with `parentThreadId`.
   */
  ancestorThreadId?: string | null;
  /**
   * Optional archived filter; when set to true, only archived threads are returned. If false or null, only non-archived threads are returned.
   */
  archived?: boolean | null;
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional cwd filter or filters; when set, only threads whose session cwd exactly matches one of these paths are returned.
   */
  cwd?: ThreadListCwdFilter | null;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  /**
   * Optional provider filter; when set, only sessions recorded under these providers are returned. When present but empty, includes all providers.
   */
  modelProviders?: string[] | null;
  /**
   * Optional direct parent thread filter. Mutually exclusive with `ancestorThreadId`.
   */
  parentThreadId?: string | null;
  /**
   * Optional substring filter for the extracted thread title.
   */
  searchTerm?: string | null;
  /**
   * Optional sort direction; defaults to descending (newest first).
   */
  sortDirection?: SortDirection | null;
  /**
   * Optional sort key; defaults to created_at.
   */
  sortKey?: ThreadSortKey | null;
  /**
   * Optional source filter; when set, only sessions from these source kinds are returned. When omitted or empty, defaults to interactive sources.
   */
  sourceKinds?: ThreadSourceKind[] | null;
  /**
   * If true, return from the state DB without scanning JSONL rollouts to repair thread metadata. Omitted or false preserves scan-and-repair behavior.
   */
  useStateDbOnly?: boolean;
  [k: string]: unknown | undefined;
}
export interface ThreadSearchRequest {
  id: RequestId;
  method: ThreadSearchRequestMethod;
  params: ThreadSearchParams;
  [k: string]: unknown | undefined;
}
export interface ThreadSearchParams {
  /**
   * Optional archived filter; when set to true, only archived threads are returned. If false or null, only non-archived threads are returned.
   */
  archived?: boolean | null;
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  /**
   * Required substring/full-text query for thread search.
   */
  searchTerm: string;
  /**
   * Optional sort direction; defaults to descending (newest first).
   */
  sortDirection?: SortDirection | null;
  /**
   * Optional sort key; defaults to created_at.
   */
  sortKey?: ThreadSortKey | null;
  /**
   * Optional source filter; when set, only sessions from these source kinds are returned. When omitted or empty, defaults to interactive sources.
   */
  sourceKinds?: ThreadSourceKind[] | null;
  [k: string]: unknown | undefined;
}
export interface ThreadLoadedListRequest {
  id: RequestId;
  method: ThreadLoadedListRequestMethod;
  params: ThreadLoadedListParams;
  [k: string]: unknown | undefined;
}
export interface ThreadLoadedListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional page size; defaults to no limit.
   */
  limit?: number | null;
  [k: string]: unknown | undefined;
}
export interface ThreadReadRequest {
  id: RequestId;
  method: ThreadReadRequestMethod;
  params: ThreadReadParams;
  [k: string]: unknown | undefined;
}
export interface ThreadReadParams {
  /**
   * When true, include turns and their items from rollout history.
   */
  includeTurns?: boolean;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadTurnsListRequest {
  id: RequestId;
  method: ThreadTurnsListRequestMethod;
  params: ThreadTurnsListParams;
  [k: string]: unknown | undefined;
}
export interface ThreadTurnsListParams {
  /**
   * Opaque cursor to pass to the next call to continue after the last turn.
   */
  cursor?: string | null;
  /**
   * How much item detail to include for each returned turn; defaults to summary.
   */
  itemsView?: TurnItemsView | null;
  /**
   * Optional turn page size.
   */
  limit?: number | null;
  /**
   * Optional turn pagination direction; defaults to descending.
   */
  sortDirection?: SortDirection | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadItemsListRequest {
  id: RequestId;
  method: ThreadItemsListRequestMethod;
  params: ThreadItemsListParams;
  [k: string]: unknown | undefined;
}
export interface ThreadItemsListParams {
  /**
   * Opaque cursor to pass to the next call to continue after the last item.
   */
  cursor?: string | null;
  /**
   * Optional item page size.
   */
  limit?: number | null;
  /**
   * Optional item pagination direction; defaults to ascending.
   */
  sortDirection?: SortDirection | null;
  threadId: string;
  /**
   * Optional turn id to filter by. When omitted, returns items across the thread.
   */
  turnId?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * Append raw Responses API items to the thread history without starting a user turn.
 */
export interface ThreadInjectItemsRequest {
  id: RequestId;
  method: ThreadInjectItemsRequestMethod;
  params: ThreadInjectItemsParams;
  [k: string]: unknown | undefined;
}
export interface ThreadInjectItemsParams {
  /**
   * Raw Responses API items to append to the thread's model-visible history.
   */
  items: unknown[];
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface SkillsListRequest {
  id: RequestId;
  method: SkillsListRequestMethod;
  params: SkillsListParams;
  [k: string]: unknown | undefined;
}
export interface SkillsListParams {
  /**
   * When empty, defaults to the current session working directory.
   */
  cwds?: string[];
  /**
   * When true, bypass the skills cache and re-scan skills from disk.
   */
  forceReload?: boolean;
  [k: string]: unknown | undefined;
}
export interface SkillsExtraRootsSetRequest {
  id: RequestId;
  method: SkillsExtraRootsSetRequestMethod;
  params: SkillsExtraRootsSetParams;
  [k: string]: unknown | undefined;
}
export interface SkillsExtraRootsSetParams {
  extraRoots: AbsolutePathBuf[];
  [k: string]: unknown | undefined;
}
export interface HooksListRequest {
  id: RequestId;
  method: HooksListRequestMethod;
  params: HooksListParams;
  [k: string]: unknown | undefined;
}
export interface HooksListParams {
  /**
   * When empty, defaults to the current session working directory.
   */
  cwds?: string[];
  [k: string]: unknown | undefined;
}
export interface MarketplaceAddRequest {
  id: RequestId;
  method: MarketplaceAddRequestMethod;
  params: MarketplaceAddParams;
  [k: string]: unknown | undefined;
}
export interface MarketplaceAddParams {
  refName?: string | null;
  source: string;
  sparsePaths?: string[] | null;
  [k: string]: unknown | undefined;
}
export interface MarketplaceRemoveRequest {
  id: RequestId;
  method: MarketplaceRemoveRequestMethod;
  params: MarketplaceRemoveParams;
  [k: string]: unknown | undefined;
}
export interface MarketplaceRemoveParams {
  marketplaceName: string;
  [k: string]: unknown | undefined;
}
export interface MarketplaceUpgradeRequest {
  id: RequestId;
  method: MarketplaceUpgradeRequestMethod;
  params: MarketplaceUpgradeParams;
  [k: string]: unknown | undefined;
}
export interface MarketplaceUpgradeParams {
  marketplaceName?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginListRequest {
  id: RequestId;
  method: PluginListRequestMethod;
  params: PluginListParams;
  [k: string]: unknown | undefined;
}
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
export interface PluginInstalledRequest {
  id: RequestId;
  method: PluginInstalledRequestMethod;
  params: PluginInstalledParams;
  [k: string]: unknown | undefined;
}
export interface PluginInstalledParams {
  /**
   * Optional working directories used to discover repo marketplaces.
   */
  cwds?: AbsolutePathBuf[] | null;
  /**
   * Additional uninstalled plugin names that should be returned when present locally. This is used by mention surfaces that intentionally expose install entrypoints.
   */
  installSuggestionPluginNames?: string[] | null;
  [k: string]: unknown | undefined;
}
export interface PluginReadRequest {
  id: RequestId;
  method: PluginReadRequestMethod;
  params: PluginReadParams;
  [k: string]: unknown | undefined;
}
export interface PluginReadParams {
  marketplacePath?: AbsolutePathBuf | null;
  pluginName: string;
  remoteMarketplaceName?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginSkillReadRequest {
  id: RequestId;
  method: PluginSkillReadRequestMethod;
  params: PluginSkillReadParams;
  [k: string]: unknown | undefined;
}
export interface PluginSkillReadParams {
  remoteMarketplaceName: string;
  remotePluginId: string;
  skillName: string;
  [k: string]: unknown | undefined;
}
export interface PluginShareSaveRequest {
  id: RequestId;
  method: PluginShareSaveRequestMethod;
  params: PluginShareSaveParams;
  [k: string]: unknown | undefined;
}
export interface PluginShareSaveParams {
  discoverability?: PluginShareDiscoverability | null;
  pluginPath: AbsolutePathBuf;
  remotePluginId?: string | null;
  shareTargets?: PluginShareTarget[] | null;
  [k: string]: unknown | undefined;
}
export interface PluginShareTarget {
  principalId: string;
  principalType: PluginSharePrincipalType;
  role: PluginShareTargetRole;
  [k: string]: unknown | undefined;
}
export interface PluginShareUpdateTargetsRequest {
  id: RequestId;
  method: PluginShareUpdateTargetsRequestMethod;
  params: PluginShareUpdateTargetsParams;
  [k: string]: unknown | undefined;
}
export interface PluginShareUpdateTargetsParams {
  discoverability: PluginShareUpdateDiscoverability;
  remotePluginId: string;
  shareTargets: PluginShareTarget[];
  [k: string]: unknown | undefined;
}
export interface PluginShareListRequest {
  id: RequestId;
  method: PluginShareListRequestMethod;
  params: PluginShareListParams;
  [k: string]: unknown | undefined;
}
export interface PluginShareListParams {
  [k: string]: unknown | undefined;
}
export interface PluginShareCheckoutRequest {
  id: RequestId;
  method: PluginShareCheckoutRequestMethod;
  params: PluginShareCheckoutParams;
  [k: string]: unknown | undefined;
}
export interface PluginShareCheckoutParams {
  remotePluginId: string;
  [k: string]: unknown | undefined;
}
export interface PluginShareDeleteRequest {
  id: RequestId;
  method: PluginShareDeleteRequestMethod;
  params: PluginShareDeleteParams;
  [k: string]: unknown | undefined;
}
export interface PluginShareDeleteParams {
  remotePluginId: string;
  [k: string]: unknown | undefined;
}
export interface AppListRequest {
  id: RequestId;
  method: AppListRequestMethod;
  params: AppsListParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - list available apps/connectors.
 */
export interface AppsListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * When true, bypass app caches and fetch the latest data from sources.
   */
  forceRefetch?: boolean;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  /**
   * Optional thread id used to evaluate app feature gating from that thread's config.
   */
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
export interface FsReadFileRequest {
  id: RequestId;
  method: FsReadFileRequestMethod;
  params: FsReadFileParams;
  [k: string]: unknown | undefined;
}
/**
 * Read a file from the host filesystem.
 */
export interface FsReadFileParams {
  /**
   * Absolute path to read.
   */
  path: AbsolutePathBuf;
  [k: string]: unknown | undefined;
}
export interface FsWriteFileRequest {
  id: RequestId;
  method: FsWriteFileRequestMethod;
  params: FsWriteFileParams;
  [k: string]: unknown | undefined;
}
/**
 * Write a file on the host filesystem.
 */
export interface FsWriteFileParams {
  /**
   * File contents encoded as base64.
   */
  dataBase64: string;
  /**
   * Absolute path to write.
   */
  path: AbsolutePathBuf;
  [k: string]: unknown | undefined;
}
export interface FsCreateDirectoryRequest {
  id: RequestId;
  method: FsCreateDirectoryRequestMethod;
  params: FsCreateDirectoryParams;
  [k: string]: unknown | undefined;
}
/**
 * Create a directory on the host filesystem.
 */
export interface FsCreateDirectoryParams {
  /**
   * Absolute directory path to create.
   */
  path: AbsolutePathBuf;
  /**
   * Whether parent directories should also be created. Defaults to `true`.
   */
  recursive?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface FsGetMetadataRequest {
  id: RequestId;
  method: FsGetMetadataRequestMethod;
  params: FsGetMetadataParams;
  [k: string]: unknown | undefined;
}
/**
 * Request metadata for an absolute path.
 */
export interface FsGetMetadataParams {
  /**
   * Absolute path to inspect.
   */
  path: AbsolutePathBuf;
  [k: string]: unknown | undefined;
}
export interface FsReadDirectoryRequest {
  id: RequestId;
  method: FsReadDirectoryRequestMethod;
  params: FsReadDirectoryParams;
  [k: string]: unknown | undefined;
}
/**
 * List direct child names for a directory.
 */
export interface FsReadDirectoryParams {
  /**
   * Absolute directory path to read.
   */
  path: AbsolutePathBuf;
  [k: string]: unknown | undefined;
}
export interface FsRemoveRequest {
  id: RequestId;
  method: FsRemoveRequestMethod;
  params: FsRemoveParams;
  [k: string]: unknown | undefined;
}
/**
 * Remove a file or directory tree from the host filesystem.
 */
export interface FsRemoveParams {
  /**
   * Whether missing paths should be ignored. Defaults to `true`.
   */
  force?: boolean | null;
  /**
   * Absolute path to remove.
   */
  path: AbsolutePathBuf;
  /**
   * Whether directory removal should recurse. Defaults to `true`.
   */
  recursive?: boolean | null;
  [k: string]: unknown | undefined;
}
export interface FsCopyRequest {
  id: RequestId;
  method: FsCopyRequestMethod;
  params: FsCopyParams;
  [k: string]: unknown | undefined;
}
/**
 * Copy a file or directory tree on the host filesystem.
 */
export interface FsCopyParams {
  /**
   * Absolute destination path.
   */
  destinationPath: AbsolutePathBuf;
  /**
   * Required for directory copies; ignored for file copies.
   */
  recursive?: boolean;
  /**
   * Absolute source path.
   */
  sourcePath: AbsolutePathBuf;
  [k: string]: unknown | undefined;
}
export interface FsWatchRequest {
  id: RequestId;
  method: FsWatchRequestMethod;
  params: FsWatchParams;
  [k: string]: unknown | undefined;
}
/**
 * Start filesystem watch notifications for an absolute path.
 */
export interface FsWatchParams {
  /**
   * Absolute file or directory path to watch.
   */
  path: AbsolutePathBuf;
  /**
   * Connection-scoped watch identifier used for `fs/unwatch` and `fs/changed`.
   */
  watchId: string;
  [k: string]: unknown | undefined;
}
export interface FsUnwatchRequest {
  id: RequestId;
  method: FsUnwatchRequestMethod;
  params: FsUnwatchParams;
  [k: string]: unknown | undefined;
}
/**
 * Stop filesystem watch notifications for a prior `fs/watch`.
 */
export interface FsUnwatchParams {
  /**
   * Watch identifier previously provided to `fs/watch`.
   */
  watchId: string;
  [k: string]: unknown | undefined;
}
export interface SkillsConfigWriteRequest {
  id: RequestId;
  method: SkillsConfigWriteRequestMethod;
  params: SkillsConfigWriteParams;
  [k: string]: unknown | undefined;
}
export interface SkillsConfigWriteParams {
  enabled: boolean;
  /**
   * Name-based selector.
   */
  name?: string | null;
  /**
   * Path-based selector.
   */
  path?: AbsolutePathBuf | null;
  [k: string]: unknown | undefined;
}
export interface PluginInstallRequest {
  id: RequestId;
  method: PluginInstallRequestMethod;
  params: PluginInstallParams;
  [k: string]: unknown | undefined;
}
export interface PluginInstallParams {
  marketplacePath?: AbsolutePathBuf | null;
  pluginName: string;
  remoteMarketplaceName?: string | null;
  [k: string]: unknown | undefined;
}
export interface PluginUninstallRequest {
  id: RequestId;
  method: PluginUninstallRequestMethod;
  params: PluginUninstallParams;
  [k: string]: unknown | undefined;
}
export interface PluginUninstallParams {
  pluginId: string;
  [k: string]: unknown | undefined;
}
export interface TurnStartRequest {
  id: RequestId;
  method: TurnStartRequestMethod;
  params: TurnStartParams;
  [k: string]: unknown | undefined;
}
export interface TurnStartParams {
  /**
   * Optional client-provided context fragments keyed by an opaque source identifier.
   */
  additionalContext?: {
    [k: string]: AdditionalContextEntry | undefined;
  } | null;
  /**
   * Override the approval policy for this turn and subsequent turns.
   */
  approvalPolicy?: AskForApproval | null;
  /**
   * Override where approval requests are routed for review on this turn and subsequent turns.
   */
  approvalsReviewer?: ApprovalsReviewer | null;
  clientUserMessageId?: string | null;
  /**
   * EXPERIMENTAL - Set a pre-set collaboration mode. Takes precedence over model, reasoning_effort, and developer instructions if set.
   *
   * For `collaboration_mode.settings.developer_instructions`, `null` means "use the built-in instructions for the selected mode".
   */
  collaborationMode?: CollaborationMode | null;
  /**
   * Override the working directory for this turn and subsequent turns.
   */
  cwd?: string | null;
  /**
   * Override the reasoning effort for this turn and subsequent turns.
   */
  effort?: ReasoningEffort | null;
  /**
   * Optional environments for this turn and subsequent turns.
   *
   * Omitted uses the thread sticky environments. Empty disables environment access for this turn. Non-empty selects the first environment as the current turn environment for this turn.
   */
  environments?: TurnEnvironmentParams[] | null;
  input: UserInput[];
  /**
   * Override the model for this turn and subsequent turns.
   */
  model?: string | null;
  /**
   * @deprecated Ignored. Use `effort: "ultra"` for proactive multi-agent behavior.
   */
  multiAgentMode?: MultiAgentMode | null;
  /**
   * Optional JSON Schema used to constrain the final assistant message for this turn.
   */
  outputSchema?: {
    [k: string]: unknown | undefined;
  };
  /**
   * Select a named permissions profile id for this turn and subsequent turns. Cannot be combined with `sandboxPolicy`.
   */
  permissions?: string | null;
  /**
   * Override the personality for this turn and subsequent turns.
   */
  personality?: Personality | null;
  /**
   * Optional metadata to enrich Codex's ResponsesAPI turn metadata.
   *
   * Entries are flattened into the JSON string sent as `client_metadata["x-codex-turn-metadata"]` on ResponsesAPI HTTP and websocket requests.
   *
   * They are not sent as top-level ResponsesAPI `client_metadata` keys, and reserved keys such as `session_id`, `thread_id`, `turn_id`, and `window_id` cannot be overridden.
   */
  responsesapiClientMetadata?: {
    [k: string]: string | undefined;
  } | null;
  /**
   * Replace the thread's runtime workspace roots for this turn and subsequent turns. Paths must be absolute.
   */
  runtimeWorkspaceRoots?: AbsolutePathBuf[] | null;
  /**
   * Override the sandbox policy for this turn and subsequent turns.
   */
  sandboxPolicy?: SandboxPolicy | null;
  /**
   * Override the service tier for this turn and subsequent turns.
   */
  serviceTier?: string | null;
  /**
   * Override the reasoning summary for this turn and subsequent turns.
   */
  summary?: ReasoningSummary | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface AdditionalContextEntry {
  kind: AdditionalContextKind;
  value: string;
  [k: string]: unknown | undefined;
}
export interface TextUserInput {
  text: string;
  /**
   * UI-defined spans within `text` used to render or persist special elements.
   */
  text_elements?: TextElement[];
  type: TextUserInputType;
  [k: string]: unknown | undefined;
}
export interface TextElement {
  /**
   * Byte range in the parent `text` buffer that this element occupies.
   */
  byteRange: ByteRange;
  /**
   * Optional human-readable placeholder for the element, displayed in the UI.
   */
  placeholder?: string | null;
  [k: string]: unknown | undefined;
}
export interface ByteRange {
  end: number;
  start: number;
  [k: string]: unknown | undefined;
}
export interface ImageUserInput {
  detail?: ImageDetail | null;
  type: ImageUserInputType;
  url: string;
  [k: string]: unknown | undefined;
}
export interface LocalImageUserInput {
  detail?: ImageDetail | null;
  path: string;
  type: LocalImageUserInputType;
  [k: string]: unknown | undefined;
}
export interface SkillUserInput {
  name: string;
  path: string;
  type: SkillUserInputType;
  [k: string]: unknown | undefined;
}
export interface MentionUserInput {
  name: string;
  path: string;
  type: MentionUserInputType;
  [k: string]: unknown | undefined;
}
export interface TurnSteerRequest {
  id: RequestId;
  method: TurnSteerRequestMethod;
  params: TurnSteerParams;
  [k: string]: unknown | undefined;
}
export interface TurnSteerParams {
  /**
   * Optional client-provided context fragments keyed by an opaque source identifier.
   */
  additionalContext?: {
    [k: string]: AdditionalContextEntry | undefined;
  } | null;
  clientUserMessageId?: string | null;
  /**
   * Required active turn id precondition. The request fails when it does not match the currently active turn.
   */
  expectedTurnId: string;
  input: UserInput[];
  /**
   * Optional metadata to enrich Codex's ResponsesAPI turn metadata.
   *
   * Entries are flattened into the JSON string sent as `client_metadata["x-codex-turn-metadata"]` on ResponsesAPI HTTP and websocket requests.
   *
   * They are not sent as top-level ResponsesAPI `client_metadata` keys, and reserved keys such as `session_id`, `thread_id`, `turn_id`, and `window_id` cannot be overridden.
   */
  responsesapiClientMetadata?: {
    [k: string]: string | undefined;
  } | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface TurnInterruptRequest {
  id: RequestId;
  method: TurnInterruptRequestMethod;
  params: TurnInterruptParams;
  [k: string]: unknown | undefined;
}
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeStartRequest {
  id: RequestId;
  method: ThreadRealtimeStartRequestMethod;
  params: ThreadRealtimeStartParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - start a thread-scoped realtime session.
 */
export interface ThreadRealtimeStartParams {
  /**
   * Leaves Codex response handoffs to the client's explicit append calls instead of forwarding them automatically. Defaults to false.
   */
  clientManagedHandoffs?: boolean | null;
  /**
   * Optional prefix added to automatic V1 Codex commentary sent with `conversation.handoff.append` when `codexResponsesAsItems` is not true. Final answers are sent without the prefix.
   */
  codexResponseHandoffPrefix?: string | null;
  /**
   * Optional prefix added to automatic Codex response items when `codexResponsesAsItems` is true.
   */
  codexResponseItemPrefix?: string | null;
  /**
   * Sends automatic Codex responses as realtime conversation items instead of handoff appends.
   */
  codexResponsesAsItems?: boolean | null;
  /**
   * Routes any transcript tail remaining at session end through Codex. Defaults to false. TODO: Remove this rollout knob once transcript-tail flushing is always enabled.
   */
  flushTranscriptTailOnSessionEnd?: boolean | null;
  /**
   * Set to false to start without Codex's startup context. Omitted or null includes it.
   */
  includeStartupContext?: boolean | null;
  /**
   * Overrides the configured realtime model for this session only.
   */
  model?: string | null;
  /**
   * Selects text or audio output for the realtime session. Transport and voice stay independent so clients can choose how they connect separately from what the model emits.
   */
  outputModality: RealtimeOutputModality;
  prompt?: string | null;
  realtimeSessionId?: string | null;
  threadId: string;
  transport?: ThreadRealtimeStartTransport | null;
  /**
   * Overrides the configured realtime protocol version for this session only.
   */
  version?: RealtimeConversationVersion | null;
  voice?: RealtimeVoice | null;
  [k: string]: unknown | undefined;
}
export interface WebsocketThreadRealtimeStartTransport {
  type: WebsocketThreadRealtimeStartTransportType;
  [k: string]: unknown | undefined;
}
export interface WebrtcThreadRealtimeStartTransport {
  /**
   * SDP offer generated by a WebRTC RTCPeerConnection after configuring audio and the realtime events data channel.
   */
  sdp: string;
  type: WebrtcThreadRealtimeStartTransportType;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeAppendAudioRequest {
  id: RequestId;
  method: ThreadRealtimeAppendAudioRequestMethod;
  params: ThreadRealtimeAppendAudioParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - append audio input to thread realtime.
 */
export interface ThreadRealtimeAppendAudioParams {
  audio: ThreadRealtimeAudioChunk;
  threadId: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - thread realtime audio chunk.
 */
export interface ThreadRealtimeAudioChunk {
  data: string;
  itemId?: string | null;
  numChannels: number;
  sampleRate: number;
  samplesPerChannel?: number | null;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeAppendTextRequest {
  id: RequestId;
  method: ThreadRealtimeAppendTextRequestMethod;
  params: ThreadRealtimeAppendTextParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - append text input to thread realtime.
 */
export interface ThreadRealtimeAppendTextParams {
  role?: ConversationTextRole & string;
  text: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeAppendSpeechRequest {
  id: RequestId;
  method: ThreadRealtimeAppendSpeechRequestMethod;
  params: ThreadRealtimeAppendSpeechParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - append speakable text to thread realtime.
 */
export interface ThreadRealtimeAppendSpeechParams {
  text: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeStopRequest {
  id: RequestId;
  method: ThreadRealtimeStopRequestMethod;
  params: ThreadRealtimeStopParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - stop thread realtime.
 */
export interface ThreadRealtimeStopParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeListVoicesRequest {
  id: RequestId;
  method: ThreadRealtimeListVoicesRequestMethod;
  params: ThreadRealtimeListVoicesParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - list voices supported by thread realtime.
 */
export interface ThreadRealtimeListVoicesParams {
  [k: string]: unknown | undefined;
}
export interface ReviewStartRequest {
  id: RequestId;
  method: ReviewStartRequestMethod;
  params: ReviewStartParams;
  [k: string]: unknown | undefined;
}
export interface ReviewStartParams {
  /**
   * Where to run the review: inline (default) on the current thread or detached on a new thread (returned in `reviewThreadId`).
   */
  delivery?: ReviewDelivery | null;
  target: ReviewTarget;
  threadId: string;
  [k: string]: unknown | undefined;
}
/**
 * Review the working tree: staged, unstaged, and untracked files.
 */
export interface UncommittedChangesReviewTarget {
  type: UncommittedChangesReviewTargetType;
  [k: string]: unknown | undefined;
}
/**
 * Review changes between the current branch and the given base branch.
 */
export interface BaseBranchReviewTarget {
  branch: string;
  type: BaseBranchReviewTargetType;
  [k: string]: unknown | undefined;
}
/**
 * Review the changes introduced by a specific commit.
 */
export interface CommitReviewTarget {
  sha: string;
  /**
   * Optional human-readable label (e.g., commit subject) for UIs.
   */
  title?: string | null;
  type: CommitReviewTargetType;
  [k: string]: unknown | undefined;
}
/**
 * Arbitrary instructions, equivalent to the old free-form prompt.
 */
export interface CustomReviewTarget {
  instructions: string;
  type: CustomReviewTargetType;
  [k: string]: unknown | undefined;
}
export interface ModelListRequest {
  id: RequestId;
  method: ModelListRequestMethod;
  params: ModelListParams;
  [k: string]: unknown | undefined;
}
export interface ModelListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * When true, include models that are hidden from the default picker list.
   */
  includeHidden?: boolean | null;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  [k: string]: unknown | undefined;
}
export interface ModelProviderCapabilitiesReadRequest {
  id: RequestId;
  method: ModelProviderCapabilitiesReadRequestMethod;
  params: ModelProviderCapabilitiesReadParams;
  [k: string]: unknown | undefined;
}
export interface ModelProviderCapabilitiesReadParams {
  [k: string]: unknown | undefined;
}
export interface ExperimentalFeatureListRequest {
  id: RequestId;
  method: ExperimentalFeatureListRequestMethod;
  params: ExperimentalFeatureListParams;
  [k: string]: unknown | undefined;
}
export interface ExperimentalFeatureListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional page size; defaults to a reasonable server-side value.
   */
  limit?: number | null;
  /**
   * Optional loaded thread id. Pass this when showing feature state for an existing thread so enablement is computed from that thread's refreshed config, including project-local config for the thread's cwd.
   */
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
export interface PermissionProfileListRequest {
  id: RequestId;
  method: PermissionProfileListRequestMethod;
  params: PermissionProfileListParams;
  [k: string]: unknown | undefined;
}
export interface PermissionProfileListParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Optional working directory to resolve project config layers.
   */
  cwd?: string | null;
  /**
   * Optional page size; defaults to the full result set.
   */
  limit?: number | null;
  [k: string]: unknown | undefined;
}
export interface ExperimentalFeatureEnablementSetRequest {
  id: RequestId;
  method: ExperimentalFeatureEnablementSetRequestMethod;
  params: ExperimentalFeatureEnablementSetParams;
  [k: string]: unknown | undefined;
}
export interface ExperimentalFeatureEnablementSetParams {
  /**
   * Process-wide runtime feature enablement keyed by canonical feature name.
   *
   * Only named features are updated. Omitted features are left unchanged. Send an empty map for a no-op.
   */
  enablement: {
    [k: string]: boolean | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface RemoteControlEnableRequest {
  id: RequestId;
  method: RemoteControlEnableRequestMethod;
  params?: RemoteControlEnableParams | null;
  [k: string]: unknown | undefined;
}
export interface RemoteControlEnableParams {
  ephemeral?: boolean;
  [k: string]: unknown | undefined;
}
export interface RemoteControlDisableRequest {
  id: RequestId;
  method: RemoteControlDisableRequestMethod;
  params?: RemoteControlDisableParams | null;
  [k: string]: unknown | undefined;
}
export interface RemoteControlDisableParams {
  ephemeral?: boolean;
  [k: string]: unknown | undefined;
}
export interface RemoteControlStatusReadRequest {
  id: RequestId;
  method: RemoteControlStatusReadRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface RemoteControlPairingStartRequest {
  id: RequestId;
  method: RemoteControlPairingStartRequestMethod;
  params: RemoteControlPairingStartParams;
  [k: string]: unknown | undefined;
}
export interface RemoteControlPairingStartParams {
  manualCode?: boolean;
  [k: string]: unknown | undefined;
}
export interface RemoteControlPairingStatusRequest {
  id: RequestId;
  method: RemoteControlPairingStatusRequestMethod;
  params: RemoteControlPairingStatusParams;
  [k: string]: unknown | undefined;
}
export interface RemoteControlPairingStatusParams {
  manualPairingCode?: string | null;
  pairingCode?: string | null;
  [k: string]: unknown | undefined;
}
export interface RemoteControlClientListRequest {
  id: RequestId;
  method: RemoteControlClientListRequestMethod;
  params: RemoteControlClientsListParams;
  [k: string]: unknown | undefined;
}
export interface RemoteControlClientsListParams {
  cursor?: string | null;
  environmentId: string;
  limit?: number | null;
  order?: RemoteControlClientsListOrder | null;
  [k: string]: unknown | undefined;
}
export interface RemoteControlClientRevokeRequest {
  id: RequestId;
  method: RemoteControlClientRevokeRequestMethod;
  params: RemoteControlClientsRevokeParams;
  [k: string]: unknown | undefined;
}
export interface RemoteControlClientsRevokeParams {
  clientId: string;
  environmentId: string;
  [k: string]: unknown | undefined;
}
/**
 * Lists collaboration mode presets.
 */
export interface CollaborationModeListRequest {
  id: RequestId;
  method: CollaborationModeListRequestMethod;
  params: CollaborationModeListParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - list collaboration mode presets.
 */
export interface CollaborationModeListParams {
  [k: string]: unknown | undefined;
}
/**
 * Test-only method used to validate experimental gating.
 */
export interface MockExperimentalMethodRequest {
  id: RequestId;
  method: MockExperimentalMethodRequestMethod;
  params: MockExperimentalMethodParams;
  [k: string]: unknown | undefined;
}
export interface MockExperimentalMethodParams {
  /**
   * Test-only payload field.
   */
  value?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * Adds or replaces a remote environment by id for later selection.
 */
export interface EnvironmentAddRequest {
  id: RequestId;
  method: EnvironmentAddRequestMethod;
  params: EnvironmentAddParams;
  [k: string]: unknown | undefined;
}
export interface EnvironmentAddParams {
  /**
   * Optional WebSocket connection timeout. The server default applies when omitted.
   */
  connectTimeoutMs?: number | null;
  environmentId: string;
  execServerUrl: string;
  [k: string]: unknown | undefined;
}
/**
 * Reads information from a configured execution environment.
 */
export interface EnvironmentInfoRequest {
  id: RequestId;
  method: EnvironmentInfoRequestMethod;
  params: EnvironmentInfoParams;
  [k: string]: unknown | undefined;
}
export interface EnvironmentInfoParams {
  environmentId: string;
  [k: string]: unknown | undefined;
}
export interface McpServerOauthLoginRequest {
  id: RequestId;
  method: McpServerOauthLoginRequestMethod;
  params: McpServerOauthLoginParams;
  [k: string]: unknown | undefined;
}
export interface McpServerOauthLoginParams {
  name: string;
  scopes?: string[] | null;
  threadId?: string | null;
  timeoutSecs?: number | null;
  [k: string]: unknown | undefined;
}
export interface ConfigMcpServerReloadRequest {
  id: RequestId;
  method: ConfigMcpServerReloadRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface McpServerStatusListRequest {
  id: RequestId;
  method: McpServerStatusListRequestMethod;
  params: ListMcpServerStatusParams;
  [k: string]: unknown | undefined;
}
export interface ListMcpServerStatusParams {
  /**
   * Opaque pagination cursor returned by a previous call.
   */
  cursor?: string | null;
  /**
   * Controls how much MCP inventory data to fetch for each server. Defaults to `Full` when omitted.
   */
  detail?: McpServerStatusDetail | null;
  /**
   * Optional page size; defaults to a server-defined value.
   */
  limit?: number | null;
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
export interface McpServerResourceReadRequest {
  id: RequestId;
  method: McpServerResourceReadRequestMethod;
  params: McpResourceReadParams;
  [k: string]: unknown | undefined;
}
export interface McpResourceReadParams {
  server: string;
  threadId?: string | null;
  uri: string;
  [k: string]: unknown | undefined;
}
export interface McpServerToolCallRequest {
  id: RequestId;
  method: McpServerToolCallRequestMethod;
  params: McpServerToolCallParams;
  [k: string]: unknown | undefined;
}
export interface McpServerToolCallParams {
  _meta?: unknown;
  arguments?: unknown;
  server: string;
  threadId: string;
  tool: string;
  [k: string]: unknown | undefined;
}
export interface WindowsSandboxSetupStartRequest {
  id: RequestId;
  method: WindowsSandboxSetupStartRequestMethod;
  params: WindowsSandboxSetupStartParams;
  [k: string]: unknown | undefined;
}
export interface WindowsSandboxSetupStartParams {
  cwd?: AbsolutePathBuf | null;
  mode: WindowsSandboxSetupMode;
  [k: string]: unknown | undefined;
}
export interface WindowsSandboxReadinessRequest {
  id: RequestId;
  method: WindowsSandboxReadinessRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface AccountLoginStartRequest {
  id: RequestId;
  method: AccountLoginStartRequestMethod;
  params: LoginAccountParams;
  [k: string]: unknown | undefined;
}
export interface ApiKeyLoginAccountParams {
  apiKey: string;
  type: ApiKeyLoginAccountParamsType;
  [k: string]: unknown | undefined;
}
export interface ChatgptLoginAccountParams {
  appBrand?: LoginAppBrand | null;
  codexStreamlinedLogin?: boolean;
  type: ChatgptLoginAccountParamsType;
  useHostedLoginSuccessPage?: boolean;
  [k: string]: unknown | undefined;
}
export interface ChatgptDeviceCodeLoginAccountParams {
  type: ChatgptDeviceCodeLoginAccountParamsType;
  [k: string]: unknown | undefined;
}
/**
 * [UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE. The access token must contain the same scopes that Codex-managed ChatGPT auth tokens have.
 */
export interface ChatgptAuthTokensLoginAccountParams {
  /**
   * Access token (JWT) supplied by the client. This token is used for backend API requests and email extraction.
   */
  accessToken: string;
  /**
   * Workspace/account identifier supplied by the client.
   */
  chatgptAccountId: string;
  /**
   * Optional plan type supplied by the client.
   *
   * When `null`, Codex attempts to derive the plan type from access-token claims. If unavailable, the plan defaults to `unknown`.
   */
  chatgptPlanType?: string | null;
  type: ChatgptAuthTokensLoginAccountParamsType;
  [k: string]: unknown | undefined;
}
export interface AccountLoginCancelRequest {
  id: RequestId;
  method: AccountLoginCancelRequestMethod;
  params: CancelLoginAccountParams;
  [k: string]: unknown | undefined;
}
export interface CancelLoginAccountParams {
  loginId: string;
  [k: string]: unknown | undefined;
}
export interface AccountLogoutRequest {
  id: RequestId;
  method: AccountLogoutRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface AccountRateLimitsReadRequest {
  id: RequestId;
  method: AccountRateLimitsReadRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface AccountRateLimitResetCreditConsumeRequest {
  id: RequestId;
  method: AccountRateLimitResetCreditConsumeRequestMethod;
  params: ConsumeAccountRateLimitResetCreditParams;
  [k: string]: unknown | undefined;
}
export interface ConsumeAccountRateLimitResetCreditParams {
  /**
   * Opaque reset-credit identifier to redeem. When omitted, the backend selects the next available credit.
   */
  creditId?: string | null;
  /**
   * Identifies one logical reset attempt. A UUID is recommended; reuse the same value when retrying that attempt.
   */
  idempotencyKey: string;
  [k: string]: unknown | undefined;
}
export interface AccountUsageReadRequest {
  id: RequestId;
  method: AccountUsageReadRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface AccountWorkspaceMessagesReadRequest {
  id: RequestId;
  method: AccountWorkspaceMessagesReadRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface AccountSendAddCreditsNudgeEmailRequest {
  id: RequestId;
  method: AccountSendAddCreditsNudgeEmailRequestMethod;
  params: SendAddCreditsNudgeEmailParams;
  [k: string]: unknown | undefined;
}
export interface SendAddCreditsNudgeEmailParams {
  creditType: AddCreditsNudgeCreditType;
  [k: string]: unknown | undefined;
}
export interface FeedbackUploadRequest {
  id: RequestId;
  method: FeedbackUploadRequestMethod;
  params: FeedbackUploadParams;
  [k: string]: unknown | undefined;
}
export interface FeedbackUploadParams {
  classification: string;
  extraLogFiles?: string[] | null;
  includeLogs?: boolean;
  reason?: string | null;
  tags?: {
    [k: string]: string | undefined;
  } | null;
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
/**
 * Execute a standalone command (argv vector) under the server's sandbox.
 */
export interface CommandExecRequest {
  id: RequestId;
  method: CommandExecRequestMethod;
  params: CommandExecParams;
  [k: string]: unknown | undefined;
}
/**
 * Run a standalone command (argv vector) in the server sandbox without creating a thread or turn.
 *
 * The final `command/exec` response is deferred until the process exits and is sent only after all `command/exec/outputDelta` notifications for that connection have been emitted.
 */
export interface CommandExecParams {
  /**
   * Command argv vector. Empty arrays are rejected.
   */
  command: string[];
  /**
   * Optional working directory. Defaults to the server cwd.
   */
  cwd?: string | null;
  /**
   * Disable stdout/stderr capture truncation for this request.
   *
   * Cannot be combined with `outputBytesCap`.
   */
  disableOutputCap?: boolean;
  /**
   * Disable the timeout entirely for this request.
   *
   * Cannot be combined with `timeoutMs`.
   */
  disableTimeout?: boolean;
  /**
   * Optional environment overrides merged into the server-computed environment.
   *
   * Matching names override inherited values. Set a key to `null` to unset an inherited variable.
   */
  env?: {
    [k: string]: (string | null) | undefined;
  } | null;
  /**
   * Optional per-stream stdout/stderr capture cap in bytes.
   *
   * When omitted, the server default applies. Cannot be combined with `disableOutputCap`.
   */
  outputBytesCap?: number | null;
  /**
   * Optional active permissions profile id for this command.
   *
   * Defaults to the user's configured permissions when omitted. Cannot be combined with `sandboxPolicy`.
   */
  permissionProfile?: string | null;
  /**
   * Optional client-supplied, connection-scoped process id.
   *
   * Required for `tty`, `streamStdin`, `streamStdoutStderr`, and follow-up `command/exec/write`, `command/exec/resize`, and `command/exec/terminate` calls. When omitted, buffered execution gets an internal id that is not exposed to the client.
   */
  processId?: string | null;
  /**
   * Optional sandbox policy for this command.
   *
   * Uses the same shape as thread/turn execution sandbox configuration and defaults to the user's configured policy when omitted. Cannot be combined with `permissionProfile`.
   */
  sandboxPolicy?: SandboxPolicy | null;
  /**
   * Optional initial PTY size in character cells. Only valid when `tty` is true.
   */
  size?: CommandExecTerminalSize | null;
  /**
   * Allow follow-up `command/exec/write` requests to write stdin bytes.
   *
   * Requires a client-supplied `processId`.
   */
  streamStdin?: boolean;
  /**
   * Stream stdout/stderr via `command/exec/outputDelta` notifications.
   *
   * Streamed bytes are not duplicated into the final response and require a client-supplied `processId`.
   */
  streamStdoutStderr?: boolean;
  /**
   * Optional timeout in milliseconds.
   *
   * When omitted, the server default applies. Cannot be combined with `disableTimeout`.
   */
  timeoutMs?: number | null;
  /**
   * Enable PTY mode.
   *
   * This implies `streamStdin` and `streamStdoutStderr`.
   */
  tty?: boolean;
  [k: string]: unknown | undefined;
}
/**
 * PTY size in character cells for `command/exec` PTY sessions.
 */
export interface CommandExecTerminalSize {
  /**
   * Terminal width in character cells.
   */
  cols: number;
  /**
   * Terminal height in character cells.
   */
  rows: number;
  [k: string]: unknown | undefined;
}
/**
 * Write stdin bytes to a running `command/exec` session or close stdin.
 */
export interface CommandExecWriteRequest {
  id: RequestId;
  method: CommandExecWriteRequestMethod;
  params: CommandExecWriteParams;
  [k: string]: unknown | undefined;
}
/**
 * Write stdin bytes to a running `command/exec` session, close stdin, or both.
 */
export interface CommandExecWriteParams {
  /**
   * Close stdin after writing `deltaBase64`, if present.
   */
  closeStdin?: boolean;
  /**
   * Optional base64-encoded stdin bytes to write.
   */
  deltaBase64?: string | null;
  /**
   * Client-supplied, connection-scoped `processId` from the original `command/exec` request.
   */
  processId: string;
  [k: string]: unknown | undefined;
}
/**
 * Terminate a running `command/exec` session by client-supplied `processId`.
 */
export interface CommandExecTerminateRequest {
  id: RequestId;
  method: CommandExecTerminateRequestMethod;
  params: CommandExecTerminateParams;
  [k: string]: unknown | undefined;
}
/**
 * Terminate a running `command/exec` session.
 */
export interface CommandExecTerminateParams {
  /**
   * Client-supplied, connection-scoped `processId` from the original `command/exec` request.
   */
  processId: string;
  [k: string]: unknown | undefined;
}
/**
 * Resize a running PTY-backed `command/exec` session by client-supplied `processId`.
 */
export interface CommandExecResizeRequest {
  id: RequestId;
  method: CommandExecResizeRequestMethod;
  params: CommandExecResizeParams;
  [k: string]: unknown | undefined;
}
/**
 * Resize a running PTY-backed `command/exec` session.
 */
export interface CommandExecResizeParams {
  /**
   * Client-supplied, connection-scoped `processId` from the original `command/exec` request.
   */
  processId: string;
  /**
   * New PTY size in character cells.
   */
  size: CommandExecTerminalSize;
  [k: string]: unknown | undefined;
}
/**
 * Spawn a standalone process (argv vector) without a Codex sandbox.
 */
export interface ProcessSpawnRequest {
  id: RequestId;
  method: ProcessSpawnRequestMethod;
  params: ProcessSpawnParams;
  [k: string]: unknown | undefined;
}
/**
 * Spawn a standalone process (argv vector) without a Codex sandbox on the host where the app server is running.
 *
 * `process/spawn` returns after the process has started and the connection-scoped `processHandle` has been registered. Process output and exit are reported via `process/outputDelta` and `process/exited` notifications.
 */
export interface ProcessSpawnParams {
  /**
   * Command argv vector. Empty arrays are rejected.
   */
  command: string[];
  /**
   * Absolute working directory for the process.
   */
  cwd: AbsolutePathBuf;
  /**
   * Optional environment overrides merged into the app-server process environment.
   *
   * Matching names override inherited values. Set a key to `null` to unset an inherited variable.
   */
  env?: {
    [k: string]: (string | null) | undefined;
  } | null;
  /**
   * Optional per-stream stdout/stderr capture cap in bytes.
   *
   * When omitted, the server default applies. Set to `null` to disable the cap.
   */
  outputBytesCap?: number | null;
  /**
   * Client-supplied, connection-scoped process handle.
   *
   * Duplicate active handles are rejected on the same connection. The same handle can be reused after the prior process exits.
   */
  processHandle: string;
  /**
   * Optional initial PTY size in character cells. Only valid when `tty` is true.
   */
  size?: ProcessTerminalSize | null;
  /**
   * Allow follow-up `process/writeStdin` requests to write stdin bytes.
   */
  streamStdin?: boolean;
  /**
   * Stream stdout/stderr via `process/outputDelta` notifications.
   *
   * Streamed bytes are not duplicated into the `process/exited` notification.
   */
  streamStdoutStderr?: boolean;
  /**
   * Optional timeout in milliseconds.
   *
   * When omitted, the server default applies. Set to `null` to disable the timeout.
   */
  timeoutMs?: number | null;
  /**
   * Enable PTY mode.
   *
   * This implies `streamStdin` and `streamStdoutStderr`.
   */
  tty?: boolean;
  [k: string]: unknown | undefined;
}
/**
 * PTY size in character cells for `process/spawn` PTY sessions.
 */
export interface ProcessTerminalSize {
  /**
   * Terminal width in character cells.
   */
  cols: number;
  /**
   * Terminal height in character cells.
   */
  rows: number;
  [k: string]: unknown | undefined;
}
/**
 * Write stdin bytes to a running `process/spawn` session or close stdin.
 */
export interface ProcessWriteStdinRequest {
  id: RequestId;
  method: ProcessWriteStdinRequestMethod;
  params: ProcessWriteStdinParams;
  [k: string]: unknown | undefined;
}
/**
 * Write stdin bytes to a running `process/spawn` session, close stdin, or both.
 */
export interface ProcessWriteStdinParams {
  /**
   * Close stdin after writing `deltaBase64`, if present.
   */
  closeStdin?: boolean;
  /**
   * Optional base64-encoded stdin bytes to write.
   */
  deltaBase64?: string | null;
  /**
   * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
   */
  processHandle: string;
  [k: string]: unknown | undefined;
}
/**
 * Terminate a running `process/spawn` session by client-supplied `processHandle`.
 */
export interface ProcessKillRequest {
  id: RequestId;
  method: ProcessKillRequestMethod;
  params: ProcessKillParams;
  [k: string]: unknown | undefined;
}
/**
 * Terminate a running `process/spawn` session.
 */
export interface ProcessKillParams {
  /**
   * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
   */
  processHandle: string;
  [k: string]: unknown | undefined;
}
/**
 * Resize a running PTY-backed `process/spawn` session by client-supplied `processHandle`.
 */
export interface ProcessResizePtyRequest {
  id: RequestId;
  method: ProcessResizePtyRequestMethod;
  params: ProcessResizePtyParams;
  [k: string]: unknown | undefined;
}
/**
 * Resize a running PTY-backed `process/spawn` session.
 */
export interface ProcessResizePtyParams {
  /**
   * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
   */
  processHandle: string;
  /**
   * New PTY size in character cells.
   */
  size: ProcessTerminalSize;
  [k: string]: unknown | undefined;
}
export interface ConfigReadRequest {
  id: RequestId;
  method: ConfigReadRequestMethod;
  params: ConfigReadParams;
  [k: string]: unknown | undefined;
}
export interface ConfigReadParams {
  /**
   * Optional working directory to resolve project config layers. If specified, return the effective config as seen from that directory (i.e., including any project layers between `cwd` and the project/repo root).
   */
  cwd?: string | null;
  includeLayers?: boolean;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigDetectRequest {
  id: RequestId;
  method: ExternalAgentConfigDetectRequestMethod;
  params: ExternalAgentConfigDetectParams;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigDetectParams {
  /**
   * Zero or more working directories to include for repo-scoped detection.
   */
  cwds?: string[] | null;
  /**
   * If true, include detection under the user's home directory.
   */
  includeHome?: boolean;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportRequest {
  id: RequestId;
  method: ExternalAgentConfigImportRequestMethod;
  params: ExternalAgentConfigImportParams;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportParams {
  migrationItems: ExternalAgentConfigMigrationItem[];
  /**
   * Source product that produced the migration items. Missing means unspecified.
   */
  source?: string | null;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigMigrationItem {
  /**
   * Null or empty means home-scoped migration; non-empty means repo-scoped migration.
   */
  cwd?: string | null;
  description: string;
  details?: MigrationDetails | null;
  itemType: ExternalAgentConfigMigrationItemType;
  [k: string]: unknown | undefined;
}
export interface MigrationDetails {
  commands?: CommandMigration[];
  hooks?: HookMigration[];
  mcpServers?: McpServerMigration[];
  plugins?: PluginsMigration[];
  sessions?: SessionMigration[];
  skills?: SkillMigration[];
  subagents?: SubagentMigration[];
  [k: string]: unknown | undefined;
}
export interface CommandMigration {
  name: string;
  [k: string]: unknown | undefined;
}
export interface HookMigration {
  name: string;
  [k: string]: unknown | undefined;
}
export interface McpServerMigration {
  name: string;
  [k: string]: unknown | undefined;
}
export interface PluginsMigration {
  marketplaceName: string;
  pluginNames: string[];
  [k: string]: unknown | undefined;
}
export interface SessionMigration {
  cwd: string;
  path: string;
  title?: string | null;
  [k: string]: unknown | undefined;
}
export interface SkillMigration {
  name: string;
  [k: string]: unknown | undefined;
}
export interface SubagentMigration {
  name: string;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportReadHistoriesRequest {
  id: RequestId;
  method: ExternalAgentConfigImportReadHistoriesRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface ConfigValueWriteRequest {
  id: RequestId;
  method: ConfigValueWriteRequestMethod;
  params: ConfigValueWriteParams;
  [k: string]: unknown | undefined;
}
export interface ConfigValueWriteParams {
  expectedVersion?: string | null;
  /**
   * Path to the config file to write; defaults to the user's `config.toml` when omitted.
   */
  filePath?: string | null;
  keyPath: string;
  mergeStrategy: MergeStrategy;
  value: unknown;
  [k: string]: unknown | undefined;
}
export interface ConfigBatchWriteRequest {
  id: RequestId;
  method: ConfigBatchWriteRequestMethod;
  params: ConfigBatchWriteParams;
  [k: string]: unknown | undefined;
}
export interface ConfigBatchWriteParams {
  edits: ConfigEdit[];
  expectedVersion?: string | null;
  /**
   * Path to the config file to write; defaults to the user's `config.toml` when omitted.
   */
  filePath?: string | null;
  /**
   * When true, hot-reload the updated user config into all loaded threads after writing.
   */
  reloadUserConfig?: boolean;
  [k: string]: unknown | undefined;
}
export interface ConfigEdit {
  keyPath: string;
  mergeStrategy: MergeStrategy;
  value: unknown;
  [k: string]: unknown | undefined;
}
export interface ConfigRequirementsReadRequest {
  id: RequestId;
  method: ConfigRequirementsReadRequestMethod;
  params?: null;
  [k: string]: unknown | undefined;
}
export interface AccountReadRequest {
  id: RequestId;
  method: AccountReadRequestMethod;
  params: GetAccountParams;
  [k: string]: unknown | undefined;
}
export interface GetAccountParams {
  /**
   * When `true`, requests a proactive token refresh before returning.
   *
   * In managed auth mode this triggers the normal refresh-token flow. In external auth mode this flag is ignored. Clients should refresh tokens themselves and call `account/login/start` with `chatgptAuthTokens`.
   */
  refreshToken?: boolean;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchRequest {
  id: RequestId;
  method: FuzzyFileSearchRequestMethod;
  params: FuzzyFileSearchParams;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchParams {
  cancellationToken?: string | null;
  query: string;
  roots: string[];
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionStartRequest {
  id: RequestId;
  method: FuzzyFileSearchSessionStartRequestMethod;
  params: FuzzyFileSearchSessionStartParams;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionStartParams {
  roots: string[];
  sessionId: string;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionUpdateRequest {
  id: RequestId;
  method: FuzzyFileSearchSessionUpdateRequestMethod;
  params: FuzzyFileSearchSessionUpdateParams;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionUpdateParams {
  query: string;
  sessionId: string;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionStopRequest {
  id: RequestId;
  method: FuzzyFileSearchSessionStopRequestMethod;
  params: FuzzyFileSearchSessionStopParams;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionStopParams {
  sessionId: string;
  [k: string]: unknown | undefined;
}
