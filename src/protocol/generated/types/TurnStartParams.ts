// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AdditionalContextKind = "untrusted" | "application";
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
export type LegacyAppPathString = string;
export type UserInput =
  TextUserInput | ImageUserInput | LocalImageUserInput | SkillUserInput | MentionUserInput;
export type TextUserInputType = "text";
export type ImageDetail = "auto" | "low" | "high" | "original";
export type ImageUserInputType = "image";
export type LocalImageUserInputType = "localImage";
export type SkillUserInputType = "skill";
export type MentionUserInputType = "mention";
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
export interface TurnEnvironmentParams {
  cwd: LegacyAppPathString;
  environmentId: string;
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
