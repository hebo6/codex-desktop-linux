import { useState } from "react";

import type { SubAgentStatus, SubAgentSummary } from "../app/subAgentState";
import { ComposerAccessoryDisclosure } from "./ComposerAccessoryPanel";
import styles from "./SubAgentPanel.module.css";

const STATUS_LABELS = {
  waitingOnApproval: "等待审批",
  waitingOnUserInput: "等待输入",
  errored: "出错",
  running: "运行中",
  idle: "空闲",
  completed: "已完成",
  interrupted: "已中断",
  notLoaded: "未加载",
} satisfies Record<SubAgentStatus, string>;

export function SubAgentPanel({
  agents,
  error,
  onRetry,
}: {
  readonly agents: readonly SubAgentSummary[];
  readonly error: string | null;
  readonly onRetry: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibleAgents = agents.filter((agent) => agent.status !== "completed" && agent.status !== "notLoaded");

  if (visibleAgents.length === 0 && error === null) {
    return null;
  }

  const statusCounts = Object.entries(STATUS_LABELS).map(([status, label]) => ({
    count: visibleAgents.filter((agent) => agent.status === status).length,
    label,
    status,
  })).filter(({ count }) => count > 0);
  const summary = [
    "子 agent",
    ...(error === null ? [] : ["状态同步失败"]),
    ...statusCounts.map(({ count, label }) => `${count} 个${label}`),
  ].join(" · ");

  return (
    <ComposerAccessoryDisclosure
      expanded={expanded}
      icon={<AgentsIcon />}
      label="子 agent"
      live="polite"
      onExpandedChange={setExpanded}
      summary={(
        <span
          className={styles.status}
          data-status={error === null ? statusCounts[0]?.status : "errored"}
        >
          {summary}
        </span>
      )}
    >
      <div className={styles.content}>
        {visibleAgents.length === 0 ? null : (
          <ul className={styles.agents}>
            {visibleAgents.map((agent) => (
              <li key={agent.threadId}>
                <div className={styles.identity}>
                  <span className={styles.name}>{agent.name}</span>
                  {agent.role === null ? null : (
                    <span className={styles.role}>{agent.role}</span>
                  )}
                </div>
                <span className={styles.status} data-status={agent.status}>
                  {STATUS_LABELS[agent.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error === null ? null : (
          <div className={styles.error}>
            <p role="status">{error}</p>
            <button onClick={onRetry} type="button">重试</button>
          </div>
        )}
      </div>
    </ComposerAccessoryDisclosure>
  );
}

function AgentsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="9" cy="7" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2" />
      <path d="M16 4a3 3 0 0 1 0 6" />
      <path d="M18 13a5 5 0 0 1 3 5v2" />
    </svg>
  );
}
