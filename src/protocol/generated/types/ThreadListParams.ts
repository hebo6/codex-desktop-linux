// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type ThreadListCwdFilter = string | string[];
export type SortDirection = "asc" | "desc";
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
