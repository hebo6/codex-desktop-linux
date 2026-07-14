// 此文件由 scripts/generate-protocol-code.mjs 自动生成，请勿手动修改
// Codex app-server 上游提交：ac3da4fb1a2ad0ee2f0c867bfa81a5a3a3737f9c

export type ReviewDelivery = "inline" | "detached";
export type ReviewTarget =
  UncommittedChangesReviewTarget | BaseBranchReviewTarget | CommitReviewTarget | CustomReviewTarget;
export type UncommittedChangesReviewTargetType = "uncommittedChanges";
export type BaseBranchReviewTargetType = "baseBranch";
export type CommitReviewTargetType = "commit";
export type CustomReviewTargetType = "custom";

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
