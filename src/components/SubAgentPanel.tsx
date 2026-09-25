import { useId, useState } from "react";

import type { SubAgentStatus, SubAgentSummary } from "../app/subAgentState";
import {
  useSubAgentDetails,
  type SubAgentDetailsClient,
} from "../app/useSubAgentDetails";
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
  client,
  error,
  onRetry,
}: {
  readonly agents: readonly SubAgentSummary[];
  readonly client: SubAgentDetailsClient | null;
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
              <SubAgentRow
                agent={agent}
                client={client}
                key={agent.threadId}
                panelExpanded={expanded}
              />
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

function SubAgentRow({
  agent,
  client,
  panelExpanded,
}: {
  readonly agent: SubAgentSummary;
  readonly client: SubAgentDetailsClient | null;
  readonly panelExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();

  return (
    <li>
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className={styles.agentButton}
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className={styles.identity}>
          <span className={styles.name}>{agent.name}</span>{" "}
          {agent.role === null ? null : (
            <span className={styles.role}>{agent.role}</span>
          )}
        </span>
        <span className={styles.status} data-status={agent.status}>
          {STATUS_LABELS[agent.status]}
        </span>
        <span aria-hidden="true" className={styles.chevron}>›</span>
      </button>
      <div id={detailId}>
        {expanded ? (
          <SubAgentDetail agent={agent} client={client} enabled={panelExpanded} />
        ) : null}
      </div>
    </li>
  );
}

function SubAgentDetail({
  agent,
  client,
  enabled,
}: {
  readonly agent: SubAgentSummary;
  readonly client: SubAgentDetailsClient | null;
  readonly enabled: boolean;
}) {
  const { turn, loading, error, refresh } = useSubAgentDetails(
    client,
    agent.threadId,
    agent.status,
    enabled,
  );
  const output = turn?.items.findLast((item) => item.type === "agentMessage");
  const outputLabel = output?.phase === "final_answer" ? "最终结果" : "最近输出";

  return (
    <section
      aria-busy={loading}
      aria-label={`${agent.name}详情`}
      className={styles.detail}
    >
      <div className={styles.detailHeader}>
        <span>
          最近回合
          {typeof turn?.durationMs === "number"
            ? ` · 耗时 ${formatDuration(turn.durationMs)}`
            : turn?.status === "inProgress" ? " · 正在运行" : ""}
        </span>
        <button disabled={loading || client === null || !enabled} onClick={refresh} type="button">
          {loading ? "读取中…" : error === null ? "刷新" : "重试"}
        </button>
      </div>
      {client === null ? <p>连接后可查看详情</p> : null}
      {error === null ? null : (
        <p className={styles.failure} role="status">{error}</p>
      )}
      {client !== null && turn === null && error === null ? (
        <p role="status">{loading ? "正在读取最近回合…" : "暂无回合"}</p>
      ) : null}
      {turn === null ? null : (
        <>
          {turn.error == null ? null : (
            <div className={styles.failure}>
              <p className={styles.detailLabel}>执行失败</p>
              <p>{turn.error.message}</p>
              {turn.error.additionalDetails?.trim() ? (
                <p>{turn.error.additionalDetails}</p>
              ) : null}
            </div>
          )}
          {output === undefined || output.text.trim().length === 0 ? <p>暂无输出</p> : (
            <div>
              <p className={styles.detailLabel}>{outputLabel}</p>
              <div
                aria-label={outputLabel}
                className={styles.output}
                role="region"
                tabIndex={0}
              >
                {output.text}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs} 毫秒`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) {
    return durationMs < 10_000
      ? `${(durationMs / 1_000).toFixed(1)} 秒`
      : `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
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
