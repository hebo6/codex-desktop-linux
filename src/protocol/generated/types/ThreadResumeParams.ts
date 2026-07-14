// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
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
export type Personality = "none" | "friendly" | "pragmatic";
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

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
