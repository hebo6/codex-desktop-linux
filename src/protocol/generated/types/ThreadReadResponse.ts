// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

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

export interface ThreadReadResponse {
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
