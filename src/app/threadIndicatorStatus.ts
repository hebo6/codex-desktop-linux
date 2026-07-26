import type { ThreadSummary } from "./useServerThreads";

export type ThreadStatusKind =
  | "running"
  | "approval"
  | "input"
  | "resultReady"
  | "error";

export function threadIndicatorStatus(
  thread: Pick<ThreadSummary, "status"> | undefined,
  options: {
    readonly approvalPending?: boolean;
    readonly resultPending?: boolean;
  } = {},
): ThreadStatusKind | null {
  if (thread?.status.type === "systemError") {
    return "error";
  }
  if (
    options.approvalPending
    || (
      thread?.status.type === "active"
      && thread.status.activeFlags.includes("waitingOnApproval")
    )
  ) {
    return "approval";
  }
  if (
    thread?.status.type === "active"
    && thread.status.activeFlags.includes("waitingOnUserInput")
  ) {
    return "input";
  }
  if (options.resultPending) {
    return "resultReady";
  }
  return thread?.status.type === "active" ? "running" : null;
}
