// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

/**
 * Request initiated from the server and sent to the client.
 */
export type ServerRequest =
  | ItemCommandExecutionRequestApprovalRequest
  | ItemFileChangeRequestApprovalRequest
  | ItemToolRequestUserInputRequest
  | McpServerElicitationRequestRequest
  | ItemPermissionsRequestApprovalRequest
  | ItemToolCallRequest
  | AccountChatgptAuthTokensRefreshRequest
  | AttestationGenerateRequest
  | CurrentTimeReadRequest
  | ApplyPatchApprovalRequest
  | ExecCommandApprovalRequest;
export type RequestId = string | number;
export type ItemCommandExecutionRequestApprovalRequestMethod =
  "item/commandExecution/requestApproval";
export type FileSystemAccessMode = "read" | "write" | "deny";
export type FileSystemPath = PathFileSystemPath | GlobPatternFileSystemPath | SpecialFileSystemPath;
export type LegacyAppPathString = string;
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
export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | AcceptWithExecpolicyAmendmentCommandExecutionApprovalDecision
  | ApplyNetworkPolicyAmendmentCommandExecutionApprovalDecision
  | "decline"
  | "cancel";
export type NetworkPolicyRuleAction = "allow" | "deny";
export type CommandAction =
  ReadCommandAction | ListFilesCommandAction | SearchCommandAction | UnknownCommandAction;
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type ReadCommandActionType = "read";
export type ListFilesCommandActionType = "listFiles";
export type SearchCommandActionType = "search";
export type UnknownCommandActionType = "unknown";
export type NetworkApprovalProtocol = "http" | "https" | "socks5Tcp" | "socks5Udp";
export type ItemFileChangeRequestApprovalRequestMethod = "item/fileChange/requestApproval";
export type ItemToolRequestUserInputRequestMethod = "item/tool/requestUserInput";
export type McpServerElicitationRequestRequestMethod = "mcpServer/elicitation/request";
export type McpServerElicitationRequestParams = {
  serverName: string;
  threadId: string;
  /**
   * Active Codex turn when this elicitation was observed, if app-server could correlate one.
   *
   * This is nullable because MCP models elicitation as a standalone server-to-client request identified by the MCP server request id. It may be triggered during a turn, but turn context is app-server correlation rather than part of the protocol identity of the elicitation itself.
   */
  turnId?: string | null;
  [k: string]: unknown | undefined;
} & McpServerElicitationRequestParams1;
export type McpServerElicitationRequestParams1 =
  | {
      _meta?: unknown;
      message: string;
      mode: "form";
      requestedSchema: McpElicitationSchema;
      [k: string]: unknown | undefined;
    }
  | {
      _meta?: unknown;
      message: string;
      mode: "openai/form";
      requestedSchema: unknown;
      [k: string]: unknown | undefined;
    }
  | {
      _meta?: unknown;
      elicitationId: string;
      message: string;
      mode: "url";
      url: string;
      [k: string]: unknown | undefined;
    };
export type McpElicitationPrimitiveSchema =
  | (
      | McpElicitationEnumSchema
      | McpElicitationStringSchema
      | McpElicitationNumberSchema
      | McpElicitationBooleanSchema
    )
  | undefined;
export type McpElicitationEnumSchema =
  | McpElicitationSingleSelectEnumSchema
  | McpElicitationMultiSelectEnumSchema
  | McpElicitationLegacyTitledEnumSchema;
export type McpElicitationSingleSelectEnumSchema =
  McpElicitationUntitledSingleSelectEnumSchema | McpElicitationTitledSingleSelectEnumSchema;
export type McpElicitationStringType = "string";
export type McpElicitationMultiSelectEnumSchema =
  McpElicitationUntitledMultiSelectEnumSchema | McpElicitationTitledMultiSelectEnumSchema;
export type McpElicitationArrayType = "array";
export type McpElicitationStringFormat = "email" | "uri" | "date" | "date-time";
export type McpElicitationNumberType = "number" | "integer";
export type McpElicitationBooleanType = "boolean";
export type McpElicitationObjectType = "object";
export type ItemPermissionsRequestApprovalRequestMethod = "item/permissions/requestApproval";
export type ItemToolCallRequestMethod = "item/tool/call";
export type AccountChatgptAuthTokensRefreshRequestMethod = "account/chatgptAuthTokens/refresh";
export type ChatgptAuthTokensRefreshReason = "unauthorized";
export type AttestationGenerateRequestMethod = "attestation/generate";
export type CurrentTimeReadRequestMethod = "currentTime/read";
export type ApplyPatchApprovalRequestMethod = "applyPatchApproval";
export type ThreadId = string;
export type FileChange = (AddFileChange | DeleteFileChange | UpdateFileChange) | undefined;
export type AddFileChangeType = "add";
export type DeleteFileChangeType = "delete";
export type UpdateFileChangeType = "update";
export type ExecCommandApprovalRequestMethod = "execCommandApproval";
export type ParsedCommand =
  ReadParsedCommand | ListFilesParsedCommand | SearchParsedCommand | UnknownParsedCommand;
export type ReadParsedCommandType = "read";
export type ListFilesParsedCommandType = "list_files";
export type SearchParsedCommandType = "search";
export type UnknownParsedCommandType = "unknown";

/**
 * NEW APIs Sent when approval is requested for a specific command execution. This request is used for Turns started via turn/start.
 */
export interface ItemCommandExecutionRequestApprovalRequest {
  id: RequestId;
  method: ItemCommandExecutionRequestApprovalRequestMethod;
  params: CommandExecutionRequestApprovalParams;
  [k: string]: unknown | undefined;
}
export interface CommandExecutionRequestApprovalParams {
  /**
   * Optional additional permissions requested for this command.
   */
  additionalPermissions?: AdditionalPermissionProfile | null;
  /**
   * Unique identifier for this specific approval callback.
   *
   * For regular shell/unified_exec approvals, this is null.
   *
   * For zsh-exec-bridge subcommand approvals, multiple callbacks can belong to one parent `itemId`, so `approvalId` is a distinct opaque callback id (a UUID) used to disambiguate routing.
   */
  approvalId?: string | null;
  /**
   * Ordered list of decisions the client may present for this prompt.
   */
  availableDecisions?: CommandExecutionApprovalDecision[] | null;
  /**
   * The command to be executed.
   */
  command?: string | null;
  /**
   * Best-effort parsed command actions for friendly display.
   */
  commandActions?: CommandAction[] | null;
  /**
   * The command's working directory.
   */
  cwd?: LegacyAppPathString | null;
  /**
   * Environment in which the command will run.
   */
  environmentId?: string | null;
  itemId: string;
  /**
   * Optional context for a managed-network approval prompt.
   */
  networkApprovalContext?: NetworkApprovalContext | null;
  /**
   * Optional proposed execpolicy amendment to allow similar commands without prompting.
   */
  proposedExecpolicyAmendment?: string[] | null;
  /**
   * Optional proposed network policy amendments (allow/deny host) for future requests.
   */
  proposedNetworkPolicyAmendments?: NetworkPolicyAmendment[] | null;
  /**
   * Optional explanatory reason (e.g. request for network access).
   */
  reason?: string | null;
  /**
   * Unix timestamp (in milliseconds) when this approval request started.
   */
  startedAtMs: number;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface AdditionalPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  /**
   * Partial overlay used for per-command permission requests.
   */
  network?: AdditionalNetworkPermissions | null;
  [k: string]: unknown | undefined;
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
 * User approved the command, and wants to apply the proposed execpolicy amendment so future matching commands can run without prompting.
 */
export interface AcceptWithExecpolicyAmendmentCommandExecutionApprovalDecision {
  acceptWithExecpolicyAmendment: {
    execpolicy_amendment: string[];
    [k: string]: unknown | undefined;
  };
}
/**
 * User chose a persistent network policy rule (allow/deny) for this host.
 */
export interface ApplyNetworkPolicyAmendmentCommandExecutionApprovalDecision {
  applyNetworkPolicyAmendment: {
    network_policy_amendment: NetworkPolicyAmendment;
    [k: string]: unknown | undefined;
  };
}
export interface NetworkPolicyAmendment {
  action: NetworkPolicyRuleAction;
  host: string;
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
export interface NetworkApprovalContext {
  host: string;
  protocol: NetworkApprovalProtocol;
  [k: string]: unknown | undefined;
}
/**
 * Sent when approval is requested for a specific file change. This request is used for Turns started via turn/start.
 */
export interface ItemFileChangeRequestApprovalRequest {
  id: RequestId;
  method: ItemFileChangeRequestApprovalRequestMethod;
  params: FileChangeRequestApprovalParams;
  [k: string]: unknown | undefined;
}
export interface FileChangeRequestApprovalParams {
  /**
   * [UNSTABLE] When set, the agent is asking the user to allow writes under this root for the remainder of the session (unclear if this is honored today).
   */
  grantRoot?: string | null;
  itemId: string;
  /**
   * Optional explanatory reason (e.g. request for extra write access).
   */
  reason?: string | null;
  /**
   * Unix timestamp (in milliseconds) when this approval request started.
   */
  startedAtMs: number;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL - Request input from the user for a tool call.
 */
export interface ItemToolRequestUserInputRequest {
  id: RequestId;
  method: ItemToolRequestUserInputRequestMethod;
  params: ToolRequestUserInputParams;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL. Params sent with a request_user_input event.
 */
export interface ToolRequestUserInputParams {
  autoResolutionMs?: number | null;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL. Represents one request_user_input question and its required options.
 */
export interface ToolRequestUserInputQuestion {
  header: string;
  id: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: ToolRequestUserInputOption[] | null;
  question: string;
  [k: string]: unknown | undefined;
}
/**
 * EXPERIMENTAL. Defines a single selectable option for request_user_input.
 */
export interface ToolRequestUserInputOption {
  description: string;
  label: string;
  [k: string]: unknown | undefined;
}
/**
 * Request input for an MCP server elicitation.
 */
export interface McpServerElicitationRequestRequest {
  id: RequestId;
  method: McpServerElicitationRequestRequestMethod;
  params: McpServerElicitationRequestParams;
  [k: string]: unknown | undefined;
}
/**
 * Typed form schema for MCP `elicitation/create` requests.
 *
 * This matches the `requestedSchema` shape from the MCP 2025-11-25 `ElicitRequestFormParams` schema.
 */
export interface McpElicitationSchema {
  $schema?: string | null;
  properties: {
    [k: string]: McpElicitationPrimitiveSchema | undefined;
  };
  required?: string[] | null;
  type: McpElicitationObjectType;
}
export interface McpElicitationUntitledSingleSelectEnumSchema {
  default?: string | null;
  description?: string | null;
  enum: string[];
  title?: string | null;
  type: McpElicitationStringType;
}
export interface McpElicitationTitledSingleSelectEnumSchema {
  default?: string | null;
  description?: string | null;
  oneOf: McpElicitationConstOption[];
  title?: string | null;
  type: McpElicitationStringType;
}
export interface McpElicitationConstOption {
  const: string;
  title: string;
}
export interface McpElicitationUntitledMultiSelectEnumSchema {
  default?: string[] | null;
  description?: string | null;
  items: McpElicitationUntitledEnumItems;
  maxItems?: number | null;
  minItems?: number | null;
  title?: string | null;
  type: McpElicitationArrayType;
}
export interface McpElicitationUntitledEnumItems {
  enum: string[];
  type: McpElicitationStringType;
}
export interface McpElicitationTitledMultiSelectEnumSchema {
  default?: string[] | null;
  description?: string | null;
  items: McpElicitationTitledEnumItems;
  maxItems?: number | null;
  minItems?: number | null;
  title?: string | null;
  type: McpElicitationArrayType;
}
export interface McpElicitationTitledEnumItems {
  anyOf: McpElicitationConstOption[];
}
export interface McpElicitationLegacyTitledEnumSchema {
  default?: string | null;
  description?: string | null;
  enum: string[];
  enumNames?: string[] | null;
  title?: string | null;
  type: McpElicitationStringType;
}
export interface McpElicitationStringSchema {
  default?: string | null;
  description?: string | null;
  format?: McpElicitationStringFormat | null;
  maxLength?: number | null;
  minLength?: number | null;
  title?: string | null;
  type: McpElicitationStringType;
}
export interface McpElicitationNumberSchema {
  default?: number | null;
  description?: string | null;
  maximum?: number | null;
  minimum?: number | null;
  title?: string | null;
  type: McpElicitationNumberType;
}
export interface McpElicitationBooleanSchema {
  default?: boolean | null;
  description?: string | null;
  title?: string | null;
  type: McpElicitationBooleanType;
}
/**
 * Request approval for additional permissions from the user.
 */
export interface ItemPermissionsRequestApprovalRequest {
  id: RequestId;
  method: ItemPermissionsRequestApprovalRequestMethod;
  params: PermissionsRequestApprovalParams;
  [k: string]: unknown | undefined;
}
export interface PermissionsRequestApprovalParams {
  cwd: AbsolutePathBuf;
  environmentId?: string | null;
  itemId: string;
  permissions: RequestPermissionProfile;
  reason?: string | null;
  /**
   * Unix timestamp (in milliseconds) when this approval request started.
   */
  startedAtMs: number;
  threadId: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface RequestPermissionProfile {
  fileSystem?: AdditionalFileSystemPermissions | null;
  network?: AdditionalNetworkPermissions | null;
}
/**
 * Execute a dynamic tool call on the client.
 */
export interface ItemToolCallRequest {
  id: RequestId;
  method: ItemToolCallRequestMethod;
  params: DynamicToolCallParams;
  [k: string]: unknown | undefined;
}
export interface DynamicToolCallParams {
  arguments: unknown;
  callId: string;
  namespace?: string | null;
  threadId: string;
  tool: string;
  turnId: string;
  [k: string]: unknown | undefined;
}
export interface AccountChatgptAuthTokensRefreshRequest {
  id: RequestId;
  method: AccountChatgptAuthTokensRefreshRequestMethod;
  params: ChatgptAuthTokensRefreshParams;
  [k: string]: unknown | undefined;
}
export interface ChatgptAuthTokensRefreshParams {
  /**
   * Workspace/account identifier that Codex was previously using.
   *
   * Clients that manage multiple accounts/workspaces can use this as a hint to refresh the token for the correct workspace.
   *
   * This may be `null` when the prior auth state did not include a workspace identifier (`chatgpt_account_id`).
   */
  previousAccountId?: string | null;
  reason: ChatgptAuthTokensRefreshReason;
  [k: string]: unknown | undefined;
}
/**
 * Generate a fresh upstream attestation result on demand.
 */
export interface AttestationGenerateRequest {
  id: RequestId;
  method: AttestationGenerateRequestMethod;
  params: AttestationGenerateParams;
  [k: string]: unknown | undefined;
}
export interface AttestationGenerateParams {
  [k: string]: unknown | undefined;
}
/**
 * Read the current time from an external clock owned by the client.
 */
export interface CurrentTimeReadRequest {
  id: RequestId;
  method: CurrentTimeReadRequestMethod;
  params: CurrentTimeReadParams;
  [k: string]: unknown | undefined;
}
export interface CurrentTimeReadParams {
  threadId: string;
  [k: string]: unknown | undefined;
}
/**
 * DEPRECATED APIs below Request to approve a patch. This request is used for Turns started via the legacy APIs (i.e. SendUserTurn, SendUserMessage).
 */
export interface ApplyPatchApprovalRequest {
  id: RequestId;
  method: ApplyPatchApprovalRequestMethod;
  params: ApplyPatchApprovalParams;
  [k: string]: unknown | undefined;
}
export interface ApplyPatchApprovalParams {
  /**
   * Use to correlate this with [codex_protocol::protocol::PatchApplyBeginEvent] and [codex_protocol::protocol::PatchApplyEndEvent].
   */
  callId: string;
  conversationId: ThreadId;
  fileChanges: {
    [k: string]: FileChange | undefined;
  };
  /**
   * When set, the agent is asking the user to allow writes under this root for the remainder of the session (unclear if this is honored today).
   */
  grantRoot?: string | null;
  /**
   * Optional explanatory reason (e.g. request for extra write access).
   */
  reason?: string | null;
  [k: string]: unknown | undefined;
}
export interface AddFileChange {
  content: string;
  type: AddFileChangeType;
  [k: string]: unknown | undefined;
}
export interface DeleteFileChange {
  content: string;
  type: DeleteFileChangeType;
  [k: string]: unknown | undefined;
}
export interface UpdateFileChange {
  move_path?: string | null;
  type: UpdateFileChangeType;
  unified_diff: string;
  [k: string]: unknown | undefined;
}
/**
 * Request to exec a command. This request is used for Turns started via the legacy APIs (i.e. SendUserTurn, SendUserMessage).
 */
export interface ExecCommandApprovalRequest {
  id: RequestId;
  method: ExecCommandApprovalRequestMethod;
  params: ExecCommandApprovalParams;
  [k: string]: unknown | undefined;
}
export interface ExecCommandApprovalParams {
  /**
   * Identifier for this specific approval callback.
   */
  approvalId?: string | null;
  /**
   * Use to correlate this with [codex_protocol::protocol::ExecCommandBeginEvent] and [codex_protocol::protocol::ExecCommandEndEvent].
   */
  callId: string;
  command: string[];
  conversationId: ThreadId;
  cwd: string;
  parsedCmd: ParsedCommand[];
  reason?: string | null;
  [k: string]: unknown | undefined;
}
export interface ReadParsedCommand {
  cmd: string;
  name: string;
  /**
   * (Best effort) Path to the file being read by the command. When possible, this is an absolute path, though when relative, it should be resolved against the `cwd`` that will be used to run the command to derive the absolute path.
   */
  path: string;
  type: ReadParsedCommandType;
  [k: string]: unknown | undefined;
}
export interface ListFilesParsedCommand {
  cmd: string;
  path?: string | null;
  type: ListFilesParsedCommandType;
  [k: string]: unknown | undefined;
}
export interface SearchParsedCommand {
  cmd: string;
  path?: string | null;
  query?: string | null;
  type: SearchParsedCommandType;
  [k: string]: unknown | undefined;
}
export interface UnknownParsedCommand {
  cmd: string;
  type: UnknownParsedCommandType;
  [k: string]: unknown | undefined;
}
