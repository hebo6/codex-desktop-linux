import type { ThreadListResponse } from "../protocol/generated";
import type { TurnStatus } from "../protocol/generated/types/ThreadTurnsListResponse";

export type SubAgentStatus =
  | "running"
  | "waitingOnApproval"
  | "waitingOnUserInput"
  | "idle"
  | "completed"
  | "interrupted"
  | "errored"
  | "notLoaded";

export interface SubAgentSummary {
  readonly threadId: string;
  readonly name: string;
  readonly role: string | null;
  readonly status: SubAgentStatus;
}

export interface ObservedSubAgent {
  readonly thread: ThreadListResponse["data"][number];
  readonly lastTurnStatus: TurnStatus | null;
}

export function subAgentSummary(agent: ObservedSubAgent): SubAgentSummary {
  const { thread, lastTurnStatus } = agent;
  const source = thread.source;
  const spawn = typeof source === "object" && "subAgent" in source &&
    typeof source.subAgent === "object" && "thread_spawn" in source.subAgent
    ? source.subAgent.thread_spawn
    : null;
  // 路径和昵称都是可选元数据，缺失时使用协议中必有的线程标识
  const name = spawn?.agent_path ?? thread.agentNickname ?? thread.id;
  let status: SubAgentStatus;
  switch (thread.status.type) {
    case "active":
      status = thread.status.activeFlags.includes("waitingOnApproval")
        ? "waitingOnApproval"
        : thread.status.activeFlags.includes("waitingOnUserInput")
          ? "waitingOnUserInput"
          : "running";
      break;
    case "systemError":
      status = "errored";
      break;
    case "notLoaded":
      status = "notLoaded";
      break;
    case "idle":
      status = lastTurnStatus === "failed"
        ? "errored"
        : lastTurnStatus === "completed" || lastTurnStatus === "interrupted"
          ? lastTurnStatus
          : "idle";
      break;
  }
  return { threadId: thread.id, name, role: thread.agentRole ?? null, status };
}
