// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * Notification sent from the server to the client.
 */
export type ServerNotification =
  | ErrorNotification
  | ThreadStartedNotification
  | ThreadStatusChangedNotification
  | ThreadArchivedNotification
  | ThreadDeletedNotification
  | ThreadUnarchivedNotification
  | ThreadClosedNotification
  | SkillsChangedNotification
  | ThreadNameUpdatedNotification
  | ThreadGoalUpdatedNotification
  | ThreadGoalClearedNotification
  | ThreadSettingsUpdatedNotification
  | ThreadTokenUsageUpdatedNotification
  | TurnStartedNotification
  | HookStartedNotification
  | TurnCompletedNotification
  | HookCompletedNotification
  | TurnDiffUpdatedNotification
  | TurnPlanUpdatedNotification
  | ItemStartedNotification
  | ItemAutoApprovalReviewStartedNotification
  | ItemAutoApprovalReviewCompletedNotification
  | ItemCompletedNotification
  | ItemAgentMessageDeltaNotification
  | ItemPlanDeltaNotification
  | CommandExecOutputDeltaNotification
  | ProcessOutputDeltaNotification
  | ProcessExitedNotification
  | ItemCommandExecutionOutputDeltaNotification
  | ItemCommandExecutionTerminalInteractionNotification
  | ItemFileChangeOutputDeltaNotification
  | ItemFileChangePatchUpdatedNotification
  | ServerRequestResolvedNotification
  | ItemMcpToolCallProgressNotification
  | McpServerOauthLoginCompletedNotification
  | McpServerStartupStatusUpdatedNotification
  | AccountUpdatedNotification
  | AccountRateLimitsUpdatedNotification
  | AppListUpdatedNotification
  | RemoteControlStatusChangedNotification
  | ExternalAgentConfigImportProgressNotification
  | ExternalAgentConfigImportCompletedNotification
  | FsChangedNotification
  | ItemReasoningSummaryTextDeltaNotification
  | ItemReasoningSummaryPartAddedNotification
  | ItemReasoningTextDeltaNotification
  | ThreadCompactedNotification
  | ModelReroutedNotification
  | ModelVerificationNotification
  | TurnModerationMetadataNotification
  | ModelSafetyBufferingUpdatedNotification
  | WarningNotification
  | GuardianWarningNotification
  | DeprecationNoticeNotification
  | ConfigWarningNotification
  | FuzzyFileSearchSessionUpdatedNotification
  | FuzzyFileSearchSessionCompletedNotification
  | ThreadRealtimeStartedNotification
  | ThreadRealtimeItemAddedNotification
  | ThreadRealtimeTranscriptDeltaNotification
  | ThreadRealtimeTranscriptDoneNotification
  | ThreadRealtimeOutputAudioDeltaNotification
  | ThreadRealtimeSdpNotification
  | ThreadRealtimeErrorNotification
  | ThreadRealtimeClosedNotification
  | WindowsWorldWritableWarningNotification
  | WindowsSandboxSetupCompletedNotification
  | AccountLoginCompletedNotification;
export type ErrorNotificationMethod = "error";
/**
 * This translation layer make sure that we expose codex error code in camel case.
 *
 * When an upstream HTTP status is available (for example, from the Responses API or a provider), it is forwarded in `httpStatusCode` on the relevant `codexErrorInfo` variant.
 */
export type CodexErrorInfo =
  | (
      | "contextWindowExceeded"
      | "sessionBudgetExceeded"
      | "usageLimitExceeded"
      | "serverOverloaded"
      | "cyberPolicy"
      | "internalServerError"
      | "unauthorized"
      | "badRequest"
      | "threadRollbackFailed"
      | "sandboxError"
      | "other"
    )
  | HttpConnectionFailedCodexErrorInfo
  | ResponseStreamConnectionFailedCodexErrorInfo
  | ResponseStreamDisconnectedCodexErrorInfo
  | ResponseTooManyFailedAttemptsCodexErrorInfo
  | ActiveTurnNotSteerableCodexErrorInfo;
export type NonSteerableTurnKind = "review" | "compact";
export type ThreadStartedNotificationMethod = "thread/started";
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type ThreadHistoryMode = "legacy" | "paginated";
export type SessionSource =
  | ("cli" | "vscode" | "exec" | "appServer" | "unknown")
  | CustomSessionSource
  | SubAgentSessionSource;
export type SubAgentSource =
  ("review" | "compact" | "memory_consolidation") | ThreadSpawnSubAgentSource | OtherSubAgentSource;
export type AgentPath = string;
export type ThreadId = string;
export type ThreadStatus =
  NotLoadedThreadStatus | IdleThreadStatus | SystemErrorThreadStatus | ActiveThreadStatus;
export type NotLoadedThreadStatusType = "notLoaded";
export type IdleThreadStatusType = "idle";
export type SystemErrorThreadStatusType = "systemError";
export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type ActiveThreadStatusType = "active";
export type ThreadSource = string;
export type ThreadItem =
  | UserMessageThreadItem
  | HookPromptThreadItem
  | AgentMessageThreadItem
  | PlanThreadItem
  | ReasoningThreadItem
  | CommandExecutionThreadItem
  | FileChangeThreadItem
  | McpToolCallThreadItem
  | DynamicToolCallThreadItem
  | CollabAgentToolCallThreadItem
  | SubAgentActivityThreadItem
  | WebSearchThreadItem
  | ImageViewThreadItem
  | SleepThreadItem
  | ImageGenerationThreadItem
  | EnteredReviewModeThreadItem
  | ExitedReviewModeThreadItem
  | ContextCompactionThreadItem;
export type UserInput =
  TextUserInput | ImageUserInput | LocalImageUserInput | SkillUserInput | MentionUserInput;
export type TextUserInputType = "text";
export type ImageDetail = "auto" | "low" | "high" | "original";
export type ImageUserInputType = "image";
export type LocalImageUserInputType = "localImage";
export type SkillUserInputType = "skill";
export type MentionUserInputType = "mention";
export type UserMessageThreadItemType = "userMessage";
export type HookPromptThreadItemType = "hookPrompt";
/**
 * Classifies an assistant message as interim commentary or final answer text.
 *
 * Providers do not emit this consistently, so callers must treat `None` as "phase unknown" and keep compatibility behavior for legacy models.
 */
export type MessagePhase = "commentary" | "final_answer";
export type AgentMessageThreadItemType = "agentMessage";
export type PlanThreadItemType = "plan";
export type ReasoningThreadItemType = "reasoning";
export type CommandAction =
  ReadCommandAction | ListFilesCommandAction | SearchCommandAction | UnknownCommandAction;
export type ReadCommandActionType = "read";
export type ListFilesCommandActionType = "listFiles";
export type SearchCommandActionType = "search";
export type UnknownCommandActionType = "unknown";
export type LegacyAppPathString = string;
export type CommandExecutionSource =
  "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";
export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";
export type CommandExecutionThreadItemType = "commandExecution";
export type PatchChangeKind = AddPatchChangeKind | DeletePatchChangeKind | UpdatePatchChangeKind;
export type AddPatchChangeKindType = "add";
export type DeletePatchChangeKindType = "delete";
export type UpdatePatchChangeKindType = "update";
export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";
export type FileChangeThreadItemType = "fileChange";
export type McpToolCallStatus = "inProgress" | "completed" | "failed";
export type McpToolCallThreadItemType = "mcpToolCall";
export type DynamicToolCallOutputContentItem =
  InputTextDynamicToolCallOutputContentItem | InputImageDynamicToolCallOutputContentItem;
export type InputTextDynamicToolCallOutputContentItemType = "inputText";
export type InputImageDynamicToolCallOutputContentItemType = "inputImage";
export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";
export type DynamicToolCallThreadItemType = "dynamicToolCall";
export type CollabAgentStatus =
  "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";
/**
 * A non-empty reasoning effort value advertised by the model.
 */
export type ReasoningEffort = string;
export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed";
export type CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
export type CollabAgentToolCallThreadItemType = "collabAgentToolCall";
export type SubAgentActivityKind = "started" | "interacted" | "interrupted";
export type SubAgentActivityThreadItemType = "subAgentActivity";
export type WebSearchAction =
  | SearchWebSearchAction
  | OpenPageWebSearchAction
  | FindInPageWebSearchAction
  | OtherWebSearchAction;
export type SearchWebSearchActionType = "search";
export type OpenPageWebSearchActionType = "openPage";
export type FindInPageWebSearchActionType = "findInPage";
export type OtherWebSearchActionType = "other";
export type WebSearchThreadItemType = "webSearch";
export type ImageViewThreadItemType = "imageView";
export type SleepThreadItemType = "sleep";
export type ImageGenerationThreadItemType = "imageGeneration";
export type EnteredReviewModeThreadItemType = "enteredReviewMode";
export type ExitedReviewModeThreadItemType = "exitedReviewMode";
export type ContextCompactionThreadItemType = "contextCompaction";
export type TurnItemsView = "notLoaded" | "summary" | "full";
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type ThreadStatusChangedNotificationMethod = "thread/status/changed";
export type ThreadArchivedNotificationMethod = "thread/archived";
export type ThreadDeletedNotificationMethod = "thread/deleted";
export type ThreadUnarchivedNotificationMethod = "thread/unarchived";
export type ThreadClosedNotificationMethod = "thread/closed";
export type SkillsChangedNotificationMethod = "skills/changed";
export type ThreadNameUpdatedNotificationMethod = "thread/name/updated";
export type ThreadGoalUpdatedNotificationMethod = "thread/goal/updated";
export type ThreadGoalStatus =
  "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export type ThreadGoalClearedNotificationMethod = "thread/goal/cleared";
export type ThreadSettingsUpdatedNotificationMethod = "thread/settings/updated";
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
 * A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process. See https://platform.openai.com/docs/guides/reasoning?api-mode=responses#reasoning-summaries
 */
export type ReasoningSummary = ("auto" | "concise" | "detailed") | "none";
export type ThreadTokenUsageUpdatedNotificationMethod = "thread/tokenUsage/updated";
export type TurnStartedNotificationMethod = "turn/started";
export type HookStartedNotificationMethod = "hook/started";
export type HookOutputEntryKind = "warning" | "stop" | "feedback" | "context" | "error";
export type HookEventName =
  | "preToolUse"
  | "permissionRequest"
  | "postToolUse"
  | "preCompact"
  | "postCompact"
  | "sessionStart"
  | "userPromptSubmit"
  | "subagentStart"
  | "subagentStop"
  | "stop";
export type HookExecutionMode = "sync" | "async";
export type HookHandlerType = "command" | "prompt" | "agent";
export type HookScope = "thread" | "turn";
export type HookSource =
  | "system"
  | "user"
  | "project"
  | "mdm"
  | "sessionFlags"
  | "plugin"
  | "cloudRequirements"
  | "cloudManagedConfig"
  | "legacyManagedConfigFile"
  | "legacyManagedConfigMdm"
  | "unknown";
export type HookRunStatus = "running" | "completed" | "failed" | "blocked" | "stopped";
export type TurnCompletedNotificationMethod = "turn/completed";
export type HookCompletedNotificationMethod = "hook/completed";
export type TurnDiffUpdatedNotificationMethod = "turn/diff/updated";
export type TurnPlanUpdatedNotificationMethod = "turn/plan/updated";
export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";
export type ItemStartedNotificationMethod = "item/started";
export type ItemAutoApprovalReviewStartedNotificationMethod = "item/autoApprovalReview/started";
export type GuardianApprovalReviewAction =
  | CommandGuardianApprovalReviewAction
  | ExecveGuardianApprovalReviewAction
  | ApplyPatchGuardianApprovalReviewAction
  | NetworkAccessGuardianApprovalReviewAction
  | McpToolCallGuardianApprovalReviewAction
  | RequestPermissionsGuardianApprovalReviewAction;
export type GuardianCommandSource = "shell" | "unifiedExec";
export type CommandGuardianApprovalReviewActionType = "command";
export type ExecveGuardianApprovalReviewActionType = "execve";
export type ApplyPatchGuardianApprovalReviewActionType = "applyPatch";
export type NetworkApprovalProtocol = "http" | "https" | "socks5Tcp" | "socks5Udp";
export type NetworkAccessGuardianApprovalReviewActionType = "networkAccess";
export type McpToolCallGuardianApprovalReviewActionType = "mcpToolCall";
export type FileSystemAccessMode = "read" | "write" | "deny";
export type FileSystemPath = PathFileSystemPath | GlobPatternFileSystemPath | SpecialFileSystemPath;
export type PathFileSystemPathType = "path";
export type GlobPatternFileSystemPathType = "glob_pattern";
export type SpecialFileSystemPathType = "special";
export type FileSystemSpecialPath =
  | RootFileSystemSpecialPath
  | MinimalFileSystemSpecialPath
  | KindFileSystemSpecialPath
  | TmpdirFileSystemSpecialPath
  | SlashTmpFileSystemSpecialPath
  | {
      kind: "unknown";
      path: string;
      subpath?: string | null;
      [k: string]: unknown | undefined;
    };
export type RequestPermissionsGuardianApprovalReviewActionType = "requestPermissions";
/**
 * [UNSTABLE] Risk level assigned by approval auto-review.
 */
export type GuardianRiskLevel = "low" | "medium" | "high" | "critical";
/**
 * [UNSTABLE] Lifecycle state for an approval auto-review.
 */
export type GuardianApprovalReviewStatus =
  "inProgress" | "approved" | "denied" | "timedOut" | "aborted";
/**
 * [UNSTABLE] Authorization level assigned by approval auto-review.
 */
export type GuardianUserAuthorization = "unknown" | "low" | "medium" | "high";
export type ItemAutoApprovalReviewCompletedNotificationMethod = "item/autoApprovalReview/completed";
/**
 * [UNSTABLE] Source that produced a terminal approval auto-review decision.
 */
export type AutoReviewDecisionSource = "agent";
export type ItemCompletedNotificationMethod = "item/completed";
export type ItemAgentMessageDeltaNotificationMethod = "item/agentMessage/delta";
export type ItemPlanDeltaNotificationMethod = "item/plan/delta";
export type CommandExecOutputDeltaNotificationMethod = "command/exec/outputDelta";
/**
 * Stream label for `command/exec/outputDelta` notifications.
 */
export type CommandExecOutputStream = "stdout" | "stderr";
export type ProcessOutputDeltaNotificationMethod = "process/outputDelta";
/**
 * Stream label for `process/outputDelta` notifications.
 */
export type ProcessOutputStream = "stdout" | "stderr";
export type ProcessExitedNotificationMethod = "process/exited";
export type ItemCommandExecutionOutputDeltaNotificationMethod = "item/commandExecution/outputDelta";
export type ItemCommandExecutionTerminalInteractionNotificationMethod =
  "item/commandExecution/terminalInteraction";
export type ItemFileChangeOutputDeltaNotificationMethod = "item/fileChange/outputDelta";
export type ItemFileChangePatchUpdatedNotificationMethod = "item/fileChange/patchUpdated";
export type ServerRequestResolvedNotificationMethod = "serverRequest/resolved";
export type RequestId = string | number;
export type ItemMcpToolCallProgressNotificationMethod = "item/mcpToolCall/progress";
export type McpServerOauthLoginCompletedNotificationMethod = "mcpServer/oauthLogin/completed";
export type McpServerStartupStatusUpdatedNotificationMethod = "mcpServer/startupStatus/updated";
export type McpServerStartupFailureReason = "reauthenticationRequired";
export type McpServerStartupState = "starting" | "ready" | "failed" | "cancelled";
export type AccountUpdatedNotificationMethod = "account/updated";
/**
 * Authentication mode for OpenAI-backed providers.
 */
export type AuthMode =
  | "apikey"
  | "chatgpt"
  | "chatgptAuthTokens"
  | "headers"
  | "agentIdentity"
  | "personalAccessToken"
  | "bedrockApiKey";
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";
export type AccountRateLimitsUpdatedNotificationMethod = "account/rateLimits/updated";
export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";
export type AppListUpdatedNotificationMethod = "app/list/updated";
export type RemoteControlStatusChangedNotificationMethod = "remoteControl/status/changed";
export type RemoteControlConnectionStatus = "disabled" | "connecting" | "connected" | "errored";
export type ExternalAgentConfigImportProgressNotificationMethod =
  "externalAgentConfig/import/progress";
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
export type ExternalAgentConfigImportCompletedNotificationMethod =
  "externalAgentConfig/import/completed";
export type FsChangedNotificationMethod = "fs/changed";
export type ItemReasoningSummaryTextDeltaNotificationMethod = "item/reasoning/summaryTextDelta";
export type ItemReasoningSummaryPartAddedNotificationMethod = "item/reasoning/summaryPartAdded";
export type ItemReasoningTextDeltaNotificationMethod = "item/reasoning/textDelta";
export type ThreadCompactedNotificationMethod = "thread/compacted";
export type ModelReroutedNotificationMethod = "model/rerouted";
export type ModelRerouteReason = "highRiskCyberActivity";
export type ModelVerificationNotificationMethod = "model/verification";
export type ModelVerification = "trustedAccessForCyber";
export type TurnModerationMetadataNotificationMethod = "turn/moderationMetadata";
export type ModelSafetyBufferingUpdatedNotificationMethod = "model/safetyBuffering/updated";
export type WarningNotificationMethod = "warning";
export type GuardianWarningNotificationMethod = "guardianWarning";
export type DeprecationNoticeNotificationMethod = "deprecationNotice";
export type ConfigWarningNotificationMethod = "configWarning";
export type FuzzyFileSearchSessionUpdatedNotificationMethod = "fuzzyFileSearch/sessionUpdated";
export type FuzzyFileSearchMatchType = "file" | "directory";
export type FuzzyFileSearchSessionCompletedNotificationMethod = "fuzzyFileSearch/sessionCompleted";
export type ThreadRealtimeStartedNotificationMethod = "thread/realtime/started";
export type RealtimeConversationVersion = "v1" | "v2";
export type ThreadRealtimeItemAddedNotificationMethod = "thread/realtime/itemAdded";
export type ThreadRealtimeTranscriptDeltaNotificationMethod = "thread/realtime/transcript/delta";
export type ThreadRealtimeTranscriptDoneNotificationMethod = "thread/realtime/transcript/done";
export type ThreadRealtimeOutputAudioDeltaNotificationMethod = "thread/realtime/outputAudio/delta";
export type ThreadRealtimeSdpNotificationMethod = "thread/realtime/sdp";
export type ThreadRealtimeErrorNotificationMethod = "thread/realtime/error";
export type ThreadRealtimeClosedNotificationMethod = "thread/realtime/closed";
export type WindowsWorldWritableWarningNotificationMethod = "windows/worldWritableWarning";
export type WindowsSandboxSetupCompletedNotificationMethod = "windowsSandbox/setupCompleted";
export type WindowsSandboxSetupMode = "elevated" | "unelevated";
export type AccountLoginCompletedNotificationMethod = "account/login/completed";

/**
 * NEW NOTIFICATIONS
 */
export interface ErrorNotification {
  method: ErrorNotificationMethod;
  params: ErrorNotification1;
  [k: string]: unknown | undefined;
}
export interface ErrorNotification1 {
  error: TurnError;
  threadId: string;
  turnId: string;
  willRetry: boolean;
  [k: string]: unknown | undefined;
}
export interface TurnError {
  additionalDetails?: string | null;
  codexErrorInfo?: CodexErrorInfo | null;
  message: string;
  [k: string]: unknown | undefined;
}
export interface HttpConnectionFailedCodexErrorInfo {
  httpConnectionFailed: {
    httpStatusCode?: number | null;
    [k: string]: unknown | undefined;
  };
}
/**
 * Failed to connect to the response SSE stream.
 */
export interface ResponseStreamConnectionFailedCodexErrorInfo {
  responseStreamConnectionFailed: {
    httpStatusCode?: number | null;
    [k: string]: unknown | undefined;
  };
}
/**
 * The response SSE stream disconnected in the middle of a turn before completion.
 */
export interface ResponseStreamDisconnectedCodexErrorInfo {
  responseStreamDisconnected: {
    httpStatusCode?: number | null;
    [k: string]: unknown | undefined;
  };
}
/**
 * Reached the retry limit for responses.
 */
export interface ResponseTooManyFailedAttemptsCodexErrorInfo {
  responseTooManyFailedAttempts: {
    httpStatusCode?: number | null;
    [k: string]: unknown | undefined;
  };
}
/**
 * Returned when `turn/start` or `turn/steer` is submitted while the current active turn cannot accept same-turn steering, for example `/review` or manual `/compact`.
 */
export interface ActiveTurnNotSteerableCodexErrorInfo {
  activeTurnNotSteerable: {
    turnKind: NonSteerableTurnKind;
    [k: string]: unknown | undefined;
  };
}
export interface ThreadStartedNotification {
  method: ThreadStartedNotificationMethod;
  params: ThreadStartedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadStartedNotification1 {
  thread: Thread;
  [k: string]: unknown | undefined;
}
export interface Thread {
  /**
   * Optional random unique nickname assigned to an AgentControl-spawned sub-agent.
   */
  agentNickname?: string | null;
  /**
   * Optional role (agent_role) assigned to an AgentControl-spawned sub-agent.
   */
  agentRole?: string | null;
  /**
   * Version of the CLI that created the thread.
   */
  cliVersion: string;
  /**
   * Unix timestamp (in seconds) when the thread was created.
   */
  createdAt: number;
  /**
   * Working directory captured for the thread.
   */
  cwd: AbsolutePathBuf;
  /**
   * Whether the thread is ephemeral and should not be materialized on disk.
   */
  ephemeral: boolean;
  /**
   * Optional implementation-specific thread data.
   */
  extra?: ThreadExtra | null;
  /**
   * Source thread id when this thread was created by forking another thread.
   */
  forkedFromId?: string | null;
  /**
   * Optional Git metadata captured when the thread was created.
   */
  gitInfo?: GitInfo | null;
  /**
   * Persisted thread history contract selected when this thread was created.
   */
  historyMode?: ThreadHistoryMode & string;
  /**
   * Identifier for this thread. Codex-generated thread IDs are UUIDv7.
   */
  id: string;
  /**
   * Model provider used for this thread (for example, 'openai').
   */
  modelProvider: string;
  /**
   * Optional user-facing thread title.
   */
  name?: string | null;
  /**
   * The ID of the parent thread. This will only be set if this thread is a subagent.
   */
  parentThreadId?: string | null;
  /**
   * [UNSTABLE] Path to the thread on disk.
   */
  path?: string | null;
  /**
   * Usually the first user message in the thread, if available.
   */
  preview: string;
  /**
   * Unix timestamp (in seconds) used for thread recency ordering.
   */
  recencyAt?: number | null;
  /**
   * Session id shared by threads that belong to the same session tree.
   */
  sessionId: string;
  /**
   * Origin of the thread (CLI, VSCode, codex exec, codex app-server, etc.).
   */
  source: SessionSource;
  /**
   * Current runtime status for the thread.
   */
  status: ThreadStatus;
  /**
   * Optional analytics source classification for this thread.
   */
  threadSource?: ThreadSource | null;
  /**
   * Only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` (when `includeTurns` is true) responses. For all other responses and notifications returning a Thread, the turns field will be an empty list.
   */
  turns: Turn[];
  /**
   * Unix timestamp (in seconds) when the thread was last updated.
   */
  updatedAt: number;
  [k: string]: unknown | undefined;
}
/**
 * Extra app-server data for a thread.
 */
export interface ThreadExtra {
  [k: string]: unknown | undefined;
}
export interface GitInfo {
  branch?: string | null;
  originUrl?: string | null;
  sha?: string | null;
  [k: string]: unknown | undefined;
}
export interface CustomSessionSource {
  custom: string;
}
export interface SubAgentSessionSource {
  subAgent: SubAgentSource;
}
export interface ThreadSpawnSubAgentSource {
  thread_spawn: {
    agent_nickname?: string | null;
    agent_path?: AgentPath | null;
    agent_role?: string | null;
    depth: number;
    parent_thread_id: ThreadId;
    [k: string]: unknown | undefined;
  };
}
export interface OtherSubAgentSource {
  other: string;
}
export interface NotLoadedThreadStatus {
  type: NotLoadedThreadStatusType;
  [k: string]: unknown | undefined;
}
export interface IdleThreadStatus {
  type: IdleThreadStatusType;
  [k: string]: unknown | undefined;
}
export interface SystemErrorThreadStatus {
  type: SystemErrorThreadStatusType;
  [k: string]: unknown | undefined;
}
export interface ActiveThreadStatus {
  activeFlags: ThreadActiveFlag[];
  type: ActiveThreadStatusType;
  [k: string]: unknown | undefined;
}
export interface Turn {
  /**
   * Unix timestamp (in seconds) when the turn completed.
   */
  completedAt?: number | null;
  /**
   * Duration between turn start and completion in milliseconds, if known.
   */
  durationMs?: number | null;
  /**
   * Only populated when the Turn's status is failed.
   */
  error?: TurnError | null;
  /**
   * Identifier for this turn. Codex-generated turn IDs are UUIDv7.
   */
  id: string;
  /**
   * Thread items currently included in this turn payload.
   */
  items: ThreadItem[];
  /**
   * Describes how much of `items` has been loaded for this turn.
   */
  itemsView?: TurnItemsView & string;
  /**
   * Unix timestamp (in seconds) when the turn started.
   */
  startedAt?: number | null;
  status: TurnStatus;
  [k: string]: unknown | undefined;
}
export interface UserMessageThreadItem {
  clientId?: string | null;
  content: UserInput[];
  id: string;
  type: UserMessageThreadItemType;
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
export interface HookPromptThreadItem {
  fragments: HookPromptFragment[];
  id: string;
  type: HookPromptThreadItemType;
  [k: string]: unknown | undefined;
}
export interface HookPromptFragment {
  hookRunId: string;
  text: string;
  [k: string]: unknown | undefined;
}
export interface AgentMessageThreadItem {
  id: string;
  memoryCitation?: MemoryCitation | null;
  phase?: MessagePhase | null;
  text: string;
  type: AgentMessageThreadItemType;
  [k: string]: unknown | undefined;
}
export interface MemoryCitation {
  entries: MemoryCitationEntry[];
  threadIds: string[];
  [k: string]: unknown | undefined;
}
export interface MemoryCitationEntry {
  lineEnd: number;
  lineStart: number;
  note: string;
  path: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - proposed plan item content. The completed plan item is authoritative and may not match the concatenation of `PlanDelta` text.
 */
export interface PlanThreadItem {
  id: string;
  text: string;
  type: PlanThreadItemType;
  [k: string]: unknown | undefined;
}
export interface ReasoningThreadItem {
  content?: string[];
  id: string;
  summary?: string[];
  type: ReasoningThreadItemType;
  [k: string]: unknown | undefined;
}
export interface CommandExecutionThreadItem {
  /**
   * The command's output, aggregated from stdout and stderr.
   */
  aggregatedOutput?: string | null;
  /**
   * The command to be executed.
   */
  command: string;
  /**
   * A best-effort parsing of the command to understand the action(s) it will perform. This returns a list of CommandAction objects because a single shell command may be composed of many commands piped together.
   */
  commandActions: CommandAction[];
  /**
   * The command's working directory.
   */
  cwd: LegacyAppPathString;
  /**
   * The duration of the command execution in milliseconds.
   */
  durationMs?: number | null;
  /**
   * The command's exit code.
   */
  exitCode?: number | null;
  id: string;
  /**
   * Identifier for the underlying PTY process (when available).
   */
  processId?: string | null;
  source?: CommandExecutionSource & string;
  status: CommandExecutionStatus;
  type: CommandExecutionThreadItemType;
  [k: string]: unknown | undefined;
}
export interface ReadCommandAction {
  command: string;
  name: string;
  path: AbsolutePathBuf;
  type: ReadCommandActionType;
  [k: string]: unknown | undefined;
}
export interface ListFilesCommandAction {
  command: string;
  path?: string | null;
  type: ListFilesCommandActionType;
  [k: string]: unknown | undefined;
}
export interface SearchCommandAction {
  command: string;
  path?: string | null;
  query?: string | null;
  type: SearchCommandActionType;
  [k: string]: unknown | undefined;
}
export interface UnknownCommandAction {
  command: string;
  type: UnknownCommandActionType;
  [k: string]: unknown | undefined;
}
export interface FileChangeThreadItem {
  changes: FileUpdateChange[];
  id: string;
  status: PatchApplyStatus;
  type: FileChangeThreadItemType;
  [k: string]: unknown | undefined;
}
export interface FileUpdateChange {
  diff: string;
  kind: PatchChangeKind;
  path: string;
  [k: string]: unknown | undefined;
}
export interface AddPatchChangeKind {
  type: AddPatchChangeKindType;
  [k: string]: unknown | undefined;
}
export interface DeletePatchChangeKind {
  type: DeletePatchChangeKindType;
  [k: string]: unknown | undefined;
}
export interface UpdatePatchChangeKind {
  move_path?: string | null;
  type: UpdatePatchChangeKindType;
  [k: string]: unknown | undefined;
}
export interface McpToolCallThreadItem {
  appContext?: McpToolCallAppContext | null;
  arguments: unknown;
  /**
   * The duration of the MCP tool call in milliseconds.
   */
  durationMs?: number | null;
  error?: McpToolCallError | null;
  id: string;
  /**
   * Deprecated: use `appContext.resourceUri` instead.
   */
  mcpAppResourceUri?: string | null;
  pluginId?: string | null;
  result?: McpToolCallResult | null;
  server: string;
  status: McpToolCallStatus;
  tool: string;
  type: McpToolCallThreadItemType;
  [k: string]: unknown | undefined;
}
export interface McpToolCallAppContext {
  actionName?: string | null;
  appName?: string | null;
  connectorId: string;
  linkId?: string | null;
  resourceUri?: string | null;
  templateId?: string | null;
  [k: string]: unknown | undefined;
}
export interface McpToolCallError {
  message: string;
  [k: string]: unknown | undefined;
}
export interface McpToolCallResult {
  _meta?: unknown;
  content: unknown[];
  structuredContent?: unknown;
  [k: string]: unknown | undefined;
}
export interface DynamicToolCallThreadItem {
  arguments: unknown;
  contentItems?: DynamicToolCallOutputContentItem[] | null;
  /**
   * The duration of the dynamic tool call in milliseconds.
   */
  durationMs?: number | null;
  id: string;
  namespace?: string | null;
  status: DynamicToolCallStatus;
  success?: boolean | null;
  tool: string;
  type: DynamicToolCallThreadItemType;
  [k: string]: unknown | undefined;
}
export interface InputTextDynamicToolCallOutputContentItem {
  text: string;
  type: InputTextDynamicToolCallOutputContentItemType;
  [k: string]: unknown | undefined;
}
export interface InputImageDynamicToolCallOutputContentItem {
  imageUrl: string;
  type: InputImageDynamicToolCallOutputContentItemType;
  [k: string]: unknown | undefined;
}
export interface CollabAgentToolCallThreadItem {
  /**
   * Last known status of the target agents, when available.
   */
  agentsStates: {
    [k: string]: CollabAgentState | undefined;
  };
  /**
   * Unique identifier for this collab tool call.
   */
  id: string;
  /**
   * Model requested for the spawned agent, when applicable.
   */
  model?: string | null;
  /**
   * Prompt text sent as part of the collab tool call, when available.
   */
  prompt?: string | null;
  /**
   * Reasoning effort requested for the spawned agent, when applicable.
   */
  reasoningEffort?: ReasoningEffort | null;
  /**
   * Thread ID of the receiving agent, when applicable. In case of spawn operation, this corresponds to the newly spawned agent.
   */
  receiverThreadIds: string[];
  /**
   * Thread ID of the agent issuing the collab request.
   */
  senderThreadId: string;
  /**
   * Current status of the collab tool call.
   */
  status: CollabAgentToolCallStatus;
  /**
   * Name of the collab tool that was invoked.
   */
  tool: CollabAgentTool;
  type: CollabAgentToolCallThreadItemType;
  [k: string]: unknown | undefined;
}
export interface CollabAgentState {
  message?: string | null;
  status: CollabAgentStatus;
  [k: string]: unknown | undefined;
}
export interface SubAgentActivityThreadItem {
  agentPath: string;
  agentThreadId: string;
  id: string;
  kind: SubAgentActivityKind;
  type: SubAgentActivityThreadItemType;
  [k: string]: unknown | undefined;
}
export interface WebSearchThreadItem {
  action?: WebSearchAction | null;
  id: string;
  query: string;
  type: WebSearchThreadItemType;
  [k: string]: unknown | undefined;
}
export interface SearchWebSearchAction {
  queries?: string[] | null;
  query?: string | null;
  type: SearchWebSearchActionType;
  [k: string]: unknown | undefined;
}
export interface OpenPageWebSearchAction {
  type: OpenPageWebSearchActionType;
  url?: string | null;
  [k: string]: unknown | undefined;
}
export interface FindInPageWebSearchAction {
  pattern?: string | null;
  type: FindInPageWebSearchActionType;
  url?: string | null;
  [k: string]: unknown | undefined;
}
export interface OtherWebSearchAction {
  type: OtherWebSearchActionType;
  [k: string]: unknown | undefined;
}
export interface ImageViewThreadItem {
  id: string;
  path: LegacyAppPathString;
  type: ImageViewThreadItemType;
  [k: string]: unknown | undefined;
}
export interface SleepThreadItem {
  durationMs: number;
  id: string;
  type: SleepThreadItemType;
  [k: string]: unknown | undefined;
}
export interface ImageGenerationThreadItem {
  id: string;
  result: string;
  revisedPrompt?: string | null;
  savedPath?: AbsolutePathBuf | null;
  status: string;
  type: ImageGenerationThreadItemType;
  [k: string]: unknown | undefined;
}
export interface EnteredReviewModeThreadItem {
  id: string;
  review: string;
  type: EnteredReviewModeThreadItemType;
  [k: string]: unknown | undefined;
}
export interface ExitedReviewModeThreadItem {
  id: string;
  review: string;
  type: ExitedReviewModeThreadItemType;
  [k: string]: unknown | undefined;
}
export interface ContextCompactionThreadItem {
  id: string;
  type: ContextCompactionThreadItemType;
  [k: string]: unknown | undefined;
}
export interface ThreadStatusChangedNotification {
  method: ThreadStatusChangedNotificationMethod;
  params: ThreadStatusChangedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadStatusChangedNotification1 {
  status: ThreadStatus;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadArchivedNotification {
  method: ThreadArchivedNotificationMethod;
  params: ThreadArchivedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadArchivedNotification1 {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadDeletedNotification {
  method: ThreadDeletedNotificationMethod;
  params: ThreadDeletedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadDeletedNotification1 {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadUnarchivedNotification {
  method: ThreadUnarchivedNotificationMethod;
  params: ThreadUnarchivedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadUnarchivedNotification1 {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadClosedNotification {
  method: ThreadClosedNotificationMethod;
  params: ThreadClosedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadClosedNotification1 {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface SkillsChangedNotification {
  method: SkillsChangedNotificationMethod;
  params: SkillsChangedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Notification emitted when watched local skill files change.
 *
 * Treat this as an invalidation signal and re-run `skills/list` with the client's current parameters when refreshed skill metadata is needed.
 */
export interface SkillsChangedNotification1 {
  [k: string]: unknown | undefined;
}
export interface ThreadNameUpdatedNotification {
  method: ThreadNameUpdatedNotificationMethod;
  params: ThreadNameUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadNameUpdatedNotification1 {
  threadId: string;
  threadName?: string | null;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalUpdatedNotification {
  method: ThreadGoalUpdatedNotificationMethod;
  params: ThreadGoalUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalUpdatedNotification1 {
  goal: ThreadGoal;
  threadId: string;
  turnId?: string | null;
  [k: string]: unknown | undefined;
}
export interface ThreadGoal {
  createdAt: number;
  objective: string;
  status: ThreadGoalStatus;
  threadId: string;
  timeUsedSeconds: number;
  tokenBudget?: number | null;
  tokensUsed: number;
  updatedAt: number;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalClearedNotification {
  method: ThreadGoalClearedNotificationMethod;
  params: ThreadGoalClearedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadGoalClearedNotification1 {
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadSettingsUpdatedNotification {
  method: ThreadSettingsUpdatedNotificationMethod;
  params: ThreadSettingsUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadSettingsUpdatedNotification1 {
  threadId: string;
  threadSettings: ThreadSettings;
  [k: string]: unknown | undefined;
}
export interface ThreadSettings {
  activePermissionProfile?: ActivePermissionProfile | null;
  approvalPolicy: AskForApproval;
  approvalsReviewer: ApprovalsReviewer;
  collaborationMode: CollaborationMode;
  cwd: AbsolutePathBuf;
  effort?: ReasoningEffort | null;
  model: string;
  modelProvider: string;
  /**
   * @deprecated Always `explicitRequestOnly`. Use `effort` for Ultra behavior.
   */
  multiAgentMode?: MultiAgentMode & string;
  personality?: Personality | null;
  sandboxPolicy: SandboxPolicy;
  serviceTier?: string | null;
  summary?: ReasoningSummary | null;
  [k: string]: unknown | undefined;
}
export interface ActivePermissionProfile {
  /**
   * Parent profile identifier from the selected permissions profile's `extends` setting, when present.
   */
  extends?: string | null;
  /**
   * Identifier from `default_permissions` or the implicit built-in default, such as `:workspace` or a user-defined `[permissions.<id>]` profile.
   */
  id: string;
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
export interface ThreadTokenUsageUpdatedNotification {
  method: ThreadTokenUsageUpdatedNotificationMethod;
  params: ThreadTokenUsageUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface ThreadTokenUsageUpdatedNotification1 {
  threadId: string;
  tokenUsage: ThreadTokenUsage;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
  total: TokenUsageBreakdown;
  [k: string]: unknown | undefined;
}
export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  [k: string]: unknown | undefined;
}
export interface TurnStartedNotification {
  method: TurnStartedNotificationMethod;
  params: TurnStartedNotification1;
  [k: string]: unknown | undefined;
}
export interface TurnStartedNotification1 {
  threadId: string;
  turn: Turn;
  [k: string]: unknown | undefined;
}
export interface HookStartedNotification {
  method: HookStartedNotificationMethod;
  params: HookStartedNotification1;
  [k: string]: unknown | undefined;
}
export interface HookStartedNotification1 {
  run: HookRunSummary;
  threadId: string;
  turnId?: string | null;
  [k: string]: unknown | undefined;
}
export interface HookRunSummary {
  completedAt?: number | null;
  displayOrder: number;
  durationMs?: number | null;
  entries: HookOutputEntry[];
  eventName: HookEventName;
  executionMode: HookExecutionMode;
  handlerType: HookHandlerType;
  id: string;
  scope: HookScope;
  source?: HookSource & string;
  sourcePath: AbsolutePathBuf;
  startedAt: number;
  status: HookRunStatus;
  statusMessage?: string | null;
  [k: string]: unknown | undefined;
}
export interface HookOutputEntry {
  kind: HookOutputEntryKind;
  text: string;
  [k: string]: unknown | undefined;
}
export interface TurnCompletedNotification {
  method: TurnCompletedNotificationMethod;
  params: TurnCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface TurnCompletedNotification1 {
  threadId: string;
  turn: Turn;
  [k: string]: unknown | undefined;
}
export interface HookCompletedNotification {
  method: HookCompletedNotificationMethod;
  params: HookCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface HookCompletedNotification1 {
  run: HookRunSummary;
  threadId: string;
  turnId?: string | null;
  [k: string]: unknown | undefined;
}
export interface TurnDiffUpdatedNotification {
  method: TurnDiffUpdatedNotificationMethod;
  params: TurnDiffUpdatedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Notification that the turn-level unified diff has changed. Contains the latest aggregated diff across all file changes in the turn.
 */
export interface TurnDiffUpdatedNotification1 {
  diff: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface TurnPlanUpdatedNotification {
  method: TurnPlanUpdatedNotificationMethod;
  params: TurnPlanUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface TurnPlanUpdatedNotification1 {
  explanation?: string | null;
  plan: TurnPlanStep[];
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface TurnPlanStep {
  status: TurnPlanStepStatus;
  step: string;
  [k: string]: unknown | undefined;
}
export interface ItemStartedNotification {
  method: ItemStartedNotificationMethod;
  params: ItemStartedNotification1;
  [k: string]: unknown | undefined;
}
export interface ItemStartedNotification1 {
  item: ThreadItem;
  /**
   * Unix timestamp (in milliseconds) when this item lifecycle started.
   */
  startedAtMs: number;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemAutoApprovalReviewStartedNotification {
  method: ItemAutoApprovalReviewStartedNotificationMethod;
  params: ItemGuardianApprovalReviewStartedNotification;
  [k: string]: unknown | undefined;
}
/**
 * [UNSTABLE] Temporary notification payload for approval auto-review. This shape is expected to change soon.
 */
export interface ItemGuardianApprovalReviewStartedNotification {
  action: GuardianApprovalReviewAction;
  review: GuardianApprovalReview;
  /**
   * Stable identifier for this review.
   */
  reviewId: string;
  /**
   * Unix timestamp (in milliseconds) when this review started.
   */
  startedAtMs: number;
  /**
   * Identifier for the reviewed item or tool call when one exists.
   *
   * In most cases, one review maps to one target item. The exceptions are - execve reviews, where a single command may contain multiple execve calls to review (only possible when using the shell_zsh_fork feature) - network policy reviews, where there is no target item
   *
   * A network call is triggered by a CommandExecution item, so having a target_item_id set to the CommandExecution item would be misleading because the review is about the network call, not the command execution. Therefore, target_item_id is set to None for network policy reviews.
   */
  targetItemId?: string | null;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface CommandGuardianApprovalReviewAction {
  command: string;
  cwd: AbsolutePathBuf;
  source: GuardianCommandSource;
  type: CommandGuardianApprovalReviewActionType;
  [k: string]: unknown | undefined;
}
export interface ExecveGuardianApprovalReviewAction {
  argv: string[];
  cwd: AbsolutePathBuf;
  program: string;
  source: GuardianCommandSource;
  type: ExecveGuardianApprovalReviewActionType;
  [k: string]: unknown | undefined;
}
export interface ApplyPatchGuardianApprovalReviewAction {
  cwd: AbsolutePathBuf;
  files: AbsolutePathBuf[];
  type: ApplyPatchGuardianApprovalReviewActionType;
  [k: string]: unknown | undefined;
}
export interface NetworkAccessGuardianApprovalReviewAction {
  host: string;
  port: number;
  protocol: NetworkApprovalProtocol;
  target: string;
  type: NetworkAccessGuardianApprovalReviewActionType;
  [k: string]: unknown | undefined;
}
export interface McpToolCallGuardianApprovalReviewAction {
  connectorId?: string | null;
  connectorName?: string | null;
  server: string;
  toolName: string;
  toolTitle?: string | null;
  type: McpToolCallGuardianApprovalReviewActionType;
  [k: string]: unknown | undefined;
}
export interface RequestPermissionsGuardianApprovalReviewAction {
  permissions: RequestPermissionProfile;
  reason?: string | null;
  type: RequestPermissionsGuardianApprovalReviewActionType;
  [k: string]: unknown | undefined;
}
export interface RequestPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
}
export interface AdditionalFileSystemPermissions {
  entries?: FileSystemSandboxEntry[] | null;
  globScanMaxDepth?: number | null;
  /**
   * This will be removed in favor of `entries`.
   */
  read?: LegacyAppPathString[] | null;
  /**
   * This will be removed in favor of `entries`.
   */
  write?: LegacyAppPathString[] | null;
  [k: string]: unknown | undefined;
}
export interface FileSystemSandboxEntry {
  access: FileSystemAccessMode;
  path: FileSystemPath;
  [k: string]: unknown | undefined;
}
export interface PathFileSystemPath {
  path: LegacyAppPathString;
  type: PathFileSystemPathType;
  [k: string]: unknown | undefined;
}
export interface GlobPatternFileSystemPath {
  pattern: string;
  type: GlobPatternFileSystemPathType;
  [k: string]: unknown | undefined;
}
export interface SpecialFileSystemPath {
  type: SpecialFileSystemPathType;
  value: FileSystemSpecialPath;
  [k: string]: unknown | undefined;
}
export interface RootFileSystemSpecialPath {
  kind: "root";
  [k: string]: unknown | undefined;
}
export interface MinimalFileSystemSpecialPath {
  kind: "minimal";
  [k: string]: unknown | undefined;
}
export interface KindFileSystemSpecialPath {
  kind: "project_roots";
  subpath?: string | null;
  [k: string]: unknown | undefined;
}
export interface TmpdirFileSystemSpecialPath {
  kind: "tmpdir";
  [k: string]: unknown | undefined;
}
export interface SlashTmpFileSystemSpecialPath {
  kind: "slash_tmp";
  [k: string]: unknown | undefined;
}
export interface AdditionalNetworkPermissions {
  enabled?: boolean | null;
  [k: string]: unknown | undefined;
}
/**
 * [UNSTABLE] Temporary approval auto-review payload used by `item/autoApprovalReview/*` notifications. This shape is expected to change soon.
 */
export interface GuardianApprovalReview {
  rationale?: string | null;
  riskLevel?: GuardianRiskLevel | null;
  status: GuardianApprovalReviewStatus;
  userAuthorization?: GuardianUserAuthorization | null;
  [k: string]: unknown | undefined;
}
export interface ItemAutoApprovalReviewCompletedNotification {
  method: ItemAutoApprovalReviewCompletedNotificationMethod;
  params: ItemGuardianApprovalReviewCompletedNotification;
  [k: string]: unknown | undefined;
}
/**
 * [UNSTABLE] Temporary notification payload for approval auto-review. This shape is expected to change soon.
 */
export interface ItemGuardianApprovalReviewCompletedNotification {
  action: GuardianApprovalReviewAction;
  /**
   * Unix timestamp (in milliseconds) when this review completed.
   */
  completedAtMs: number;
  decisionSource: AutoReviewDecisionSource;
  review: GuardianApprovalReview;
  /**
   * Stable identifier for this review.
   */
  reviewId: string;
  /**
   * Unix timestamp (in milliseconds) when this review started.
   */
  startedAtMs: number;
  /**
   * Identifier for the reviewed item or tool call when one exists.
   *
   * In most cases, one review maps to one target item. The exceptions are - execve reviews, where a single command may contain multiple execve calls to review (only possible when using the shell_zsh_fork feature) - network policy reviews, where there is no target item
   *
   * A network call is triggered by a CommandExecution item, so having a target_item_id set to the CommandExecution item would be misleading because the review is about the network call, not the command execution. Therefore, target_item_id is set to None for network policy reviews.
   */
  targetItemId?: string | null;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemCompletedNotification {
  method: ItemCompletedNotificationMethod;
  params: ItemCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface ItemCompletedNotification1 {
  /**
   * Unix timestamp (in milliseconds) when this item lifecycle completed.
   */
  completedAtMs: number;
  item: ThreadItem;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemAgentMessageDeltaNotification {
  method: ItemAgentMessageDeltaNotificationMethod;
  params: AgentMessageDeltaNotification;
  [k: string]: unknown | undefined;
}
export interface AgentMessageDeltaNotification {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - proposed plan streaming deltas for plan items.
 */
export interface ItemPlanDeltaNotification {
  method: ItemPlanDeltaNotificationMethod;
  params: PlanDeltaNotification;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - proposed plan streaming deltas for plan items. Clients should not assume concatenated deltas match the completed plan item content.
 */
export interface PlanDeltaNotification {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
/**
 * Stream base64-encoded stdout/stderr chunks for a running `command/exec` session.
 */
export interface CommandExecOutputDeltaNotification {
  method: CommandExecOutputDeltaNotificationMethod;
  params: CommandExecOutputDeltaNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Base64-encoded output chunk emitted for a streaming `command/exec` request.
 *
 * These notifications are connection-scoped. If the originating connection closes, the server terminates the process.
 */
export interface CommandExecOutputDeltaNotification1 {
  /**
   * `true` on the final streamed chunk for a stream when `outputBytesCap` truncated later output on that stream.
   */
  capReached: boolean;
  /**
   * Base64-encoded output bytes.
   */
  deltaBase64: string;
  /**
   * Client-supplied, connection-scoped `processId` from the original `command/exec` request.
   */
  processId: string;
  /**
   * Output stream for this chunk.
   */
  stream: CommandExecOutputStream;
  [k: string]: unknown | undefined;
}
/**
 * Stream base64-encoded stdout/stderr chunks for a running `process/spawn` session.
 */
export interface ProcessOutputDeltaNotification {
  method: ProcessOutputDeltaNotificationMethod;
  params: ProcessOutputDeltaNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Base64-encoded output chunk emitted for a streaming `process/spawn` request.
 */
export interface ProcessOutputDeltaNotification1 {
  /**
   * True on the final streamed chunk for this stream when output was truncated by `outputBytesCap`.
   */
  capReached: boolean;
  /**
   * Base64-encoded output bytes.
   */
  deltaBase64: string;
  /**
   * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
   */
  processHandle: string;
  /**
   * Output stream this chunk belongs to.
   */
  stream: ProcessOutputStream;
  [k: string]: unknown | undefined;
}
/**
 * Final exit notification for a `process/spawn` session.
 */
export interface ProcessExitedNotification {
  method: ProcessExitedNotificationMethod;
  params: ProcessExitedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Final process exit notification for `process/spawn`.
 */
export interface ProcessExitedNotification1 {
  /**
   * Process exit code.
   */
  exitCode: number;
  /**
   * Client-supplied, connection-scoped `processHandle` from `process/spawn`.
   */
  processHandle: string;
  /**
   * Buffered stderr capture.
   *
   * Empty when stderr was streamed via `process/outputDelta`.
   */
  stderr: string;
  /**
   * Whether stderr reached `outputBytesCap`.
   *
   * In streaming mode, stderr is empty and cap state is also reported on the final stderr `process/outputDelta` notification.
   */
  stderrCapReached: boolean;
  /**
   * Buffered stdout capture.
   *
   * Empty when stdout was streamed via `process/outputDelta`.
   */
  stdout: string;
  /**
   * Whether stdout reached `outputBytesCap`.
   *
   * In streaming mode, stdout is empty and cap state is also reported on the final stdout `process/outputDelta` notification.
   */
  stdoutCapReached: boolean;
  [k: string]: unknown | undefined;
}
export interface ItemCommandExecutionOutputDeltaNotification {
  method: ItemCommandExecutionOutputDeltaNotificationMethod;
  params: CommandExecutionOutputDeltaNotification;
  [k: string]: unknown | undefined;
}
export interface CommandExecutionOutputDeltaNotification {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemCommandExecutionTerminalInteractionNotification {
  method: ItemCommandExecutionTerminalInteractionNotificationMethod;
  params: TerminalInteractionNotification;
  [k: string]: unknown | undefined;
}
export interface TerminalInteractionNotification {
  itemId: string;
  processId: string;
  stdin: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
/**
 * Deprecated legacy apply_patch output stream notification.
 */
export interface ItemFileChangeOutputDeltaNotification {
  method: ItemFileChangeOutputDeltaNotificationMethod;
  params: FileChangeOutputDeltaNotification;
  [k: string]: unknown | undefined;
}
/**
 * Deprecated legacy notification for `apply_patch` textual output.
 *
 * The server no longer emits this notification.
 */
export interface FileChangeOutputDeltaNotification {
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemFileChangePatchUpdatedNotification {
  method: ItemFileChangePatchUpdatedNotificationMethod;
  params: FileChangePatchUpdatedNotification;
  [k: string]: unknown | undefined;
}
export interface FileChangePatchUpdatedNotification {
  changes: FileUpdateChange[];
  itemId: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ServerRequestResolvedNotification {
  method: ServerRequestResolvedNotificationMethod;
  params: ServerRequestResolvedNotification1;
  [k: string]: unknown | undefined;
}
export interface ServerRequestResolvedNotification1 {
  requestId: RequestId;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ItemMcpToolCallProgressNotification {
  method: ItemMcpToolCallProgressNotificationMethod;
  params: McpToolCallProgressNotification;
  [k: string]: unknown | undefined;
}
export interface McpToolCallProgressNotification {
  itemId: string;
  message: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface McpServerOauthLoginCompletedNotification {
  method: McpServerOauthLoginCompletedNotificationMethod;
  params: McpServerOauthLoginCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface McpServerOauthLoginCompletedNotification1 {
  error?: string | null;
  name: string;
  success: boolean;
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
export interface McpServerStartupStatusUpdatedNotification {
  method: McpServerStartupStatusUpdatedNotificationMethod;
  params: McpServerStatusUpdatedNotification;
  [k: string]: unknown | undefined;
}
export interface McpServerStatusUpdatedNotification {
  error?: string | null;
  failureReason?: McpServerStartupFailureReason | null;
  name: string;
  status: McpServerStartupState;
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
export interface AccountUpdatedNotification {
  method: AccountUpdatedNotificationMethod;
  params: AccountUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface AccountUpdatedNotification1 {
  authMode?: AuthMode | null;
  planType?: PlanType | null;
  [k: string]: unknown | undefined;
}
export interface AccountRateLimitsUpdatedNotification {
  method: AccountRateLimitsUpdatedNotificationMethod;
  params: AccountRateLimitsUpdatedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Sparse rolling rate-limit update.
 *
 * Clients should merge available values into the most recent `account/rateLimits/read` response or refetch that snapshot. Nullable account metadata may be unavailable in a rolling update and does not clear a previously observed value.
 */
export interface AccountRateLimitsUpdatedNotification1 {
  rateLimits: RateLimitSnapshot;
  [k: string]: unknown | undefined;
}
export interface RateLimitSnapshot {
  credits?: CreditsSnapshot | null;
  individualLimit?: SpendControlLimitSnapshot | null;
  limitId?: string | null;
  limitName?: string | null;
  planType?: PlanType | null;
  primary?: RateLimitWindow | null;
  rateLimitReachedType?: RateLimitReachedType | null;
  secondary?: RateLimitWindow | null;
  [k: string]: unknown | undefined;
}
export interface CreditsSnapshot {
  balance?: string | null;
  hasCredits: boolean;
  unlimited: boolean;
  [k: string]: unknown | undefined;
}
export interface SpendControlLimitSnapshot {
  limit: string;
  remainingPercent: number;
  resetsAt: number;
  used: string;
  [k: string]: unknown | undefined;
}
export interface RateLimitWindow {
  resetsAt?: number | null;
  usedPercent: number;
  windowDurationMins?: number | null;
  [k: string]: unknown | undefined;
}
export interface AppListUpdatedNotification {
  method: AppListUpdatedNotificationMethod;
  params: AppListUpdatedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - notification emitted when the app list changes.
 */
export interface AppListUpdatedNotification1 {
  data: AppInfo[];
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
export interface RemoteControlStatusChangedNotification {
  method: RemoteControlStatusChangedNotificationMethod;
  params: RemoteControlStatusChangedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Current remote-control connection status and remote identity exposed to clients.
 */
export interface RemoteControlStatusChangedNotification1 {
  environmentId?: string | null;
  installationId: string;
  serverName: string;
  status: RemoteControlConnectionStatus;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportProgressNotification {
  method: ExternalAgentConfigImportProgressNotificationMethod;
  params: ExternalAgentConfigImportProgressNotification1;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportProgressNotification1 {
  importId: string;
  itemTypeResults: ExternalAgentConfigImportTypeResult[];
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportTypeResult {
  failures: ExternalAgentConfigImportItemTypeFailure[];
  itemType: ExternalAgentConfigMigrationItemType;
  successes: ExternalAgentConfigImportItemTypeSuccess[];
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportItemTypeFailure {
  cwd?: string | null;
  errorType?: string | null;
  failureStage: string;
  itemType: ExternalAgentConfigMigrationItemType;
  message: string;
  source?: string | null;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportItemTypeSuccess {
  cwd?: string | null;
  itemType: ExternalAgentConfigMigrationItemType;
  source?: string | null;
  target?: string | null;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportCompletedNotification {
  method: ExternalAgentConfigImportCompletedNotificationMethod;
  params: ExternalAgentConfigImportCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface ExternalAgentConfigImportCompletedNotification1 {
  importId: string;
  itemTypeResults: ExternalAgentConfigImportTypeResult[];
  [k: string]: unknown | undefined;
}
export interface FsChangedNotification {
  method: FsChangedNotificationMethod;
  params: FsChangedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * Filesystem watch notification emitted for `fs/watch` subscribers.
 */
export interface FsChangedNotification1 {
  /**
   * File or directory paths associated with this event.
   */
  changedPaths: AbsolutePathBuf[];
  /**
   * Watch identifier previously provided to `fs/watch`.
   */
  watchId: string;
  [k: string]: unknown | undefined;
}
export interface ItemReasoningSummaryTextDeltaNotification {
  method: ItemReasoningSummaryTextDeltaNotificationMethod;
  params: ReasoningSummaryTextDeltaNotification;
  [k: string]: unknown | undefined;
}
export interface ReasoningSummaryTextDeltaNotification {
  delta: string;
  itemId: string;
  summaryIndex: number;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemReasoningSummaryPartAddedNotification {
  method: ItemReasoningSummaryPartAddedNotificationMethod;
  params: ReasoningSummaryPartAddedNotification;
  [k: string]: unknown | undefined;
}
export interface ReasoningSummaryPartAddedNotification {
  itemId: string;
  summaryIndex: number;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ItemReasoningTextDeltaNotification {
  method: ItemReasoningTextDeltaNotificationMethod;
  params: ReasoningTextDeltaNotification;
  [k: string]: unknown | undefined;
}
export interface ReasoningTextDeltaNotification {
  contentIndex: number;
  delta: string;
  itemId: string;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
/**
 * Deprecated: Use `ContextCompaction` item type instead.
 */
export interface ThreadCompactedNotification {
  method: ThreadCompactedNotificationMethod;
  params: ContextCompactedNotification;
  [k: string]: unknown | undefined;
}
/**
 * Deprecated: Use `ContextCompaction` item type instead.
 */
export interface ContextCompactedNotification {
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ModelReroutedNotification {
  method: ModelReroutedNotificationMethod;
  params: ModelReroutedNotification1;
  [k: string]: unknown | undefined;
}
export interface ModelReroutedNotification1 {
  fromModel: string;
  reason: ModelRerouteReason;
  threadId: string;
  toModel: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ModelVerificationNotification {
  method: ModelVerificationNotificationMethod;
  params: ModelVerificationNotification1;
  [k: string]: unknown | undefined;
}
export interface ModelVerificationNotification1 {
  threadId: string;
  turnId: string;
  verifications: ModelVerification[];
  [k: string]: unknown | undefined;
}
export interface TurnModerationMetadataNotification {
  method: TurnModerationMetadataNotificationMethod;
  params: TurnModerationMetadataNotification1;
  [k: string]: unknown | undefined;
}
export interface TurnModerationMetadataNotification1 {
  metadata: unknown;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface ModelSafetyBufferingUpdatedNotification {
  method: ModelSafetyBufferingUpdatedNotificationMethod;
  params: ModelSafetyBufferingUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface ModelSafetyBufferingUpdatedNotification1 {
  fasterModel?: string | null;
  model: string;
  reasons: string[];
  showBufferingUi: boolean;
  threadId: string;
  turnId: string;
  useCases: string[];
  [k: string]: unknown | undefined;
}
export interface WarningNotification {
  method: WarningNotificationMethod;
  params: WarningNotification1;
  [k: string]: unknown | undefined;
}
export interface WarningNotification1 {
  /**
   * Concise warning message for the user.
   */
  message: string;
  /**
   * Optional thread target when the warning applies to a specific thread.
   */
  threadId?: string | null;
  [k: string]: unknown | undefined;
}
export interface GuardianWarningNotification {
  method: GuardianWarningNotificationMethod;
  params: GuardianWarningNotification1;
  [k: string]: unknown | undefined;
}
export interface GuardianWarningNotification1 {
  /**
   * Concise guardian warning message for the user.
   */
  message: string;
  /**
   * Thread target for the guardian warning.
   */
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface DeprecationNoticeNotification {
  method: DeprecationNoticeNotificationMethod;
  params: DeprecationNoticeNotification1;
  [k: string]: unknown | undefined;
}
export interface DeprecationNoticeNotification1 {
  /**
   * Optional extra guidance, such as migration steps or rationale.
   */
  details?: string | null;
  /**
   * Concise summary of what is deprecated.
   */
  summary: string;
  [k: string]: unknown | undefined;
}
export interface ConfigWarningNotification {
  method: ConfigWarningNotificationMethod;
  params: ConfigWarningNotification1;
  [k: string]: unknown | undefined;
}
export interface ConfigWarningNotification1 {
  /**
   * Optional extra guidance or error details.
   */
  details?: string | null;
  /**
   * Optional path to the config file that triggered the warning.
   */
  path?: string | null;
  /**
   * Optional range for the error location inside the config file.
   */
  range?: TextRange | null;
  /**
   * Concise summary of the warning.
   */
  summary: string;
  [k: string]: unknown | undefined;
}
export interface TextRange {
  end: TextPosition;
  start: TextPosition;
  [k: string]: unknown | undefined;
}
export interface TextPosition {
  /**
   * 1-based column number (in Unicode scalar values).
   */
  column: number;
  /**
   * 1-based line number.
   */
  line: number;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionUpdatedNotification {
  method: FuzzyFileSearchSessionUpdatedNotificationMethod;
  params: FuzzyFileSearchSessionUpdatedNotification1;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionUpdatedNotification1 {
  files: FuzzyFileSearchResult[];
  query: string;
  sessionId: string;
  [k: string]: unknown | undefined;
}
/**
 * Superset of [`codex_file_search::FileMatch`]
 */
export interface FuzzyFileSearchResult {
  file_name: string;
  indices?: number[] | null;
  match_type: FuzzyFileSearchMatchType;
  path: string;
  root: string;
  score: number;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionCompletedNotification {
  method: FuzzyFileSearchSessionCompletedNotificationMethod;
  params: FuzzyFileSearchSessionCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface FuzzyFileSearchSessionCompletedNotification1 {
  sessionId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeStartedNotification {
  method: ThreadRealtimeStartedNotificationMethod;
  params: ThreadRealtimeStartedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - emitted when thread realtime startup is accepted.
 */
export interface ThreadRealtimeStartedNotification1 {
  realtimeSessionId?: string | null;
  threadId: string;
  version: RealtimeConversationVersion;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeItemAddedNotification {
  method: ThreadRealtimeItemAddedNotificationMethod;
  params: ThreadRealtimeItemAddedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - raw non-audio thread realtime item emitted by the backend.
 */
export interface ThreadRealtimeItemAddedNotification1 {
  item: unknown;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeTranscriptDeltaNotification {
  method: ThreadRealtimeTranscriptDeltaNotificationMethod;
  params: ThreadRealtimeTranscriptDeltaNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - flat transcript delta emitted whenever realtime transcript text changes.
 */
export interface ThreadRealtimeTranscriptDeltaNotification1 {
  /**
   * Live transcript delta from the realtime event.
   */
  delta: string;
  role: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeTranscriptDoneNotification {
  method: ThreadRealtimeTranscriptDoneNotificationMethod;
  params: ThreadRealtimeTranscriptDoneNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - final transcript text emitted when realtime completes a transcript part.
 */
export interface ThreadRealtimeTranscriptDoneNotification1 {
  role: string;
  /**
   * Final complete text for the transcript part.
   */
  text: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeOutputAudioDeltaNotification {
  method: ThreadRealtimeOutputAudioDeltaNotificationMethod;
  params: ThreadRealtimeOutputAudioDeltaNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - streamed output audio emitted by thread realtime.
 */
export interface ThreadRealtimeOutputAudioDeltaNotification1 {
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
export interface ThreadRealtimeSdpNotification {
  method: ThreadRealtimeSdpNotificationMethod;
  params: ThreadRealtimeSdpNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - emitted with the remote SDP for a WebRTC realtime session.
 */
export interface ThreadRealtimeSdpNotification1 {
  sdp: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeErrorNotification {
  method: ThreadRealtimeErrorNotificationMethod;
  params: ThreadRealtimeErrorNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - emitted when thread realtime encounters an error.
 */
export interface ThreadRealtimeErrorNotification1 {
  message: string;
  threadId: string;
  [k: string]: unknown | undefined;
}
export interface ThreadRealtimeClosedNotification {
  method: ThreadRealtimeClosedNotificationMethod;
  params: ThreadRealtimeClosedNotification1;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - emitted when thread realtime transport closes.
 */
export interface ThreadRealtimeClosedNotification1 {
  reason?: string | null;
  threadId: string;
  [k: string]: unknown | undefined;
}
/**
 * Notifies the user of world-writable directories on Windows, which cannot be protected by the sandbox.
 */
export interface WindowsWorldWritableWarningNotification {
  method: WindowsWorldWritableWarningNotificationMethod;
  params: WindowsWorldWritableWarningNotification1;
  [k: string]: unknown | undefined;
}
export interface WindowsWorldWritableWarningNotification1 {
  extraCount: number;
  failedScan: boolean;
  samplePaths: string[];
  [k: string]: unknown | undefined;
}
export interface WindowsSandboxSetupCompletedNotification {
  method: WindowsSandboxSetupCompletedNotificationMethod;
  params: WindowsSandboxSetupCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface WindowsSandboxSetupCompletedNotification1 {
  error?: string | null;
  mode: WindowsSandboxSetupMode;
  success: boolean;
  [k: string]: unknown | undefined;
}
export interface AccountLoginCompletedNotification {
  method: AccountLoginCompletedNotificationMethod;
  params: AccountLoginCompletedNotification1;
  [k: string]: unknown | undefined;
}
export interface AccountLoginCompletedNotification1 {
  error?: string | null;
  loginId?: string | null;
  success: boolean;
  [k: string]: unknown | undefined;
}
