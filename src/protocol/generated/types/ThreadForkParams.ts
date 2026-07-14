// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type AskForApproval = ("untrusted" | "on-request" | "never") | GranularAskForApproval;
/**
 * Configures who approval requests are routed to for review. Examples include sandbox escapes, blocked network access, MCP approval prompts, and ARC escalations. Defaults to `user`. `auto_review` uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request. The legacy value `guardian_subagent` is accepted for compatibility.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
/**
 * A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).
 *
 * IMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.
 */
export type AbsolutePathBuf = string;
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ThreadSource = string;

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
