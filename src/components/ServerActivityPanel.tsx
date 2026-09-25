import { useEffect, useState, type ReactNode } from "react";

import { useServerEvents } from "../app/useServerEvents";
import type { QueueInputPreview, ServerEventRecord, ServerEventSnapshot, ServerEventStore } from "../appServer/serverEventState";
import type { ThreadGoal, ThreadRealtimeAudioChunk, ThreadTokenUsage } from "../protocol/generated/types/ServerNotification";
import { ComposerAccessoryDisclosure } from "./ComposerAccessoryPanel";
import styles from "./ServerActivityPanel.module.css";

interface RequestFailure {
  readonly key: string;
  readonly message: string;
  readonly threadId: string | null;
}

const EMPTY_FAILURES: readonly RequestFailure[] = [];
const STATUS_LABELS = {
  running: "进行中", completed: "已完成", failed: "失败", warning: "需注意", unknown: "状态待同步", info: "已更新",
};
const GOAL_LABELS: Record<ThreadGoal["status"], string> = {
  active: "进行中", paused: "已暂停", blocked: "受阻", usageLimited: "用量受限", budgetLimited: "预算已用尽", complete: "已完成",
};
const SPECIALIZED_METHODS = new Set([
  "thread/tokenUsage/updated", "thread/goal/updated", "turn/diff/updated",
  "turn/plan/updated",
  "thread/queue/changed",
  "process/outputDelta", "process/exited", "command/exec/outputDelta",
  "thread/realtime/transcript/delta", "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta",
]);

export function ServerActivityPanel({ store, threadId, failures = EMPTY_FAILURES }: {
  readonly store: ServerEventStore | null;
  readonly threadId: string | null;
  readonly failures?: readonly RequestFailure[];
}) {
  const snapshot = useServerEvents(store);
  const [expanded, setExpanded] = useState(false);
  const records = snapshot?.records.filter((record) => !SPECIALIZED_METHODS.has(record.method)) ?? [];
  const threadRecords = threadId === null ? [] : records.filter((record) => record.threadId === threadId);
  const globalRecords = records.filter((record) => record.threadId == null);
  const threadFailures = threadId === null ? [] : failures.filter((failure) => failure.threadId === threadId);
  const globalFailures = failures.filter((failure) => failure.threadId === null);
  const usage = threadId === null ? undefined : snapshot?.tokenUsageByThread[threadId];
  const goal = threadId === null ? undefined : snapshot?.goalsByThread[threadId];
  const diffs = Object.values(snapshot?.diffsByTurn ?? {}).filter((diff) => diff.threadId === threadId);
  const realtime = threadId === null ? undefined : snapshot?.realtimeByThread[threadId];
  const queue = threadId === null ? undefined : snapshot?.queuesByThread[threadId];
  const projects = snapshot?.projectsSnapshot;
  const hasQueue = queue !== undefined && (queue.entries.length > 0 || queue.status !== "ready");
  const hasProjects = projects !== undefined && (projects.entries.length > 0 || projects.status === "error" || (projects.status === "pending" && projects.version > 0));
  const processes = Object.values(snapshot?.processes ?? {});
  const attention = [...threadRecords, ...globalRecords].filter((record) => record.status === "warning" || record.status === "failed").length
    + threadFailures.length + globalFailures.length + (queue?.status === "error" ? 1 : 0);
  const hasThread = threadRecords.length > 0 || threadFailures.length > 0 || usage !== undefined || goal?.goal != null || diffs.length > 0 || realtime !== undefined || hasQueue;
  const hasGlobal = globalRecords.length > 0 || globalFailures.length > 0 || processes.length > 0 || hasProjects;

  if (!hasThread && !hasGlobal) return null;

  const window = usage?.tokenUsage.modelContextWindow;
  const contextSummary = usage !== undefined && window != null && window > 0
    ? `上下文剩余 ${Math.round(remainingRatio(usage.tokenUsage.last.totalTokens, window) * 100)}%`
    : null;
  const summary = ["运行状态", contextSummary, attention > 0 ? `${attention} 项需注意` : null].filter(Boolean).join(" · ");

  return (
    <ComposerAccessoryDisclosure
      expanded={expanded}
      icon={<ActivityIcon />}
      label="运行状态"
      onExpandedChange={setExpanded}
      summary={summary}
    >
      <div className={styles.content}>
        {hasThread ? (
          <section aria-label="当前会话状态" className={styles.scope}>
            <h3>当前会话</h3>
            {usage === undefined ? null : <TokenUsage usage={usage.tokenUsage} stale={usage.stale} />}
            {goal?.goal == null ? null : <GoalStatus goal={goal.goal} stale={goal.stale} />}
            {hasQueue && queue !== undefined ? <QueueStatus queue={queue} /> : null}
            {diffs.map((diff) => <Detail key={diff.turnId} title={`本轮汇总变更 · ${diff.turnId}`}>
              {diff.stale ? <p className={styles.muted}>连接已断开，显示最后收到的变更</p> : null}
              <pre className={styles.output}>{diff.diff || "暂无文件变更"}</pre>
              {diff.truncated ? <Truncated /> : null}
            </Detail>)}
            {realtime === undefined ? null : <RealtimeStatus key={threadId} realtime={realtime} />}
            <Failures failures={threadFailures} />
            <Records records={threadRecords} />
          </section>
        ) : null}
        {hasGlobal ? (
          <section aria-label="服务器全局状态" className={styles.scope}>
            <h3>服务器</h3>
            {hasProjects && projects !== undefined ? <ProjectsStatus projects={projects} /> : null}
            <Failures failures={globalFailures} />
            {processes.map((process) => <Detail key={`${process.kind}:${process.id}`} title={`${process.kind === "process" ? "进程" : "命令"} ${process.id} · ${STATUS_LABELS[process.status]}`}>
              {process.exitCode === undefined ? null : <p>退出码 {process.exitCode}</p>}
              {process.stdout ? <><h4>标准输出</h4><pre className={styles.output}>{process.stdout}</pre></> : null}
              {process.stderr ? <><h4>错误输出</h4><pre className={styles.output}>{process.stderr}</pre></> : null}
              {process.stdoutTruncated || process.stderrTruncated ? <Truncated /> : null}
            </Detail>)}
            <Records records={globalRecords} />
          </section>
        ) : null}
        {snapshot !== null && snapshot.droppedRecords > 0 ? <p className={styles.muted}>仅保留最近的运行记录，较早的 {number(snapshot.droppedRecords)} 条已移除</p> : null}
      </div>
    </ComposerAccessoryDisclosure>
  );
}

function TokenUsage({ usage, stale }: { readonly usage: ThreadTokenUsage; readonly stale: boolean }) {
  return <article className={styles.card}>
    <h4>上下文与 Token</h4>
    {stale ? <p className={styles.muted}>连接已断开，显示最后收到的用量</p> : null}
    {usage.modelContextWindow != null && usage.modelContextWindow > 0
      ? <Remaining label="上下文" used={usage.last.totalTokens} total={usage.modelContextWindow} />
      : <p className={styles.muted}>服务器未提供上下文窗口大小</p>}
    <dl className={styles.metrics}>
      <Metric label="最近一次输入" value={usage.last.inputTokens} />
      <Metric label="最近一次输出" value={usage.last.outputTokens} />
      <Metric label="缓存输入" value={usage.last.cachedInputTokens} />
      <Metric label="推理输出" value={usage.last.reasoningOutputTokens} />
      <Metric label="累计 Token" value={usage.total.totalTokens} />
    </dl>
  </article>;
}

function GoalStatus({ goal, stale }: { readonly goal: ThreadGoal; readonly stale: boolean }) {
  return <article className={styles.card}>
    <header><h4>会话目标</h4><span>{GOAL_LABELS[goal.status]}</span></header>
    <p>{goal.objective}</p>
    {stale ? <p className={styles.muted}>目标状态待重新同步</p> : null}
    {goal.tokenBudget != null && goal.tokenBudget > 0
      ? <Remaining label="目标预算" used={goal.tokensUsed} total={goal.tokenBudget} />
      : <p className={styles.muted}>已使用 {number(goal.tokensUsed)} Token · 未设置 Token 预算</p>}
    <p className={styles.muted}>已运行 {number(Math.round(goal.timeUsedSeconds))} 秒</p>
  </article>;
}

function Remaining({ label, used, total }: { readonly label: string; readonly used: number; readonly total: number }) {
  const remaining = Math.min(total, Math.max(0, total - used));
  const percent = Math.round(remainingRatio(used, total) * 100);
  return <div className={styles.remaining}>
    <span>{label}剩余 {number(remaining)} / {number(total)} Token · {percent}%</span>
    <div aria-label={`${label}剩余`} aria-valuemax={total} aria-valuemin={0} aria-valuenow={remaining} className={styles.track} role="meter">
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return <div><dt>{label}</dt><dd>{number(value)}</dd></div>;
}

function QueueStatus({ queue }: { readonly queue: ServerEventSnapshot["queuesByThread"][string] }) {
  return <article className={styles.card}>
    <h4>待处理输入 · {queue.entries.length} 条</h4>
    {queue.status === "pending" ? <p className={styles.muted}>正在刷新输入队列</p> : null}
    {queue.status === "unknown" ? <p className={styles.muted}>连接已断开，队列状态待同步</p> : null}
    {queue.status === "error" ? <p>{queue.error}</p> : null}
    <ol className={styles.queue}>{queue.entries.map((entry, index) => <li key={entry.id}>
      <Detail title={`待处理输入 ${index + 1} · ${entry.inputs.map(inputLabel).join("、")}`}>
        {entry.inputs.map((input, inputIndex) => <p className={styles.input} key={inputIndex}>{inputDescription(input)}</p>)}
        {entry.truncated ? <Truncated /> : null}
      </Detail>
    </li>)}</ol>
  </article>;
}

function ProjectsStatus({ projects }: { readonly projects: ServerEventSnapshot["projectsSnapshot"] }) {
  return <article className={styles.card}>
    <Detail title={`项目 · ${projects.entries.length} 个`}>
      <ul className={styles.records}>{projects.entries.map((project) => <li key={project.id}>
        <strong>{project.name}</strong>
        {project.roots.map((root) => <p className={styles.muted} key={root.path}>{root.path}</p>)}
      </li>)}</ul>
    </Detail>
    {projects.status === "pending" ? <p className={styles.muted}>正在刷新项目列表</p> : null}
    {projects.status === "unknown" ? <p className={styles.muted}>连接已断开，显示最后收到的项目</p> : null}
    {projects.status === "error" ? <p>{projects.error}</p> : null}
    {projects.truncated ? <Truncated /> : null}
  </article>;
}

function inputLabel(input: QueueInputPreview): string {
  switch (input.type) {
    case "text": return "文字";
    case "image": case "localImage": return "图片";
    case "audio": case "localAudio": return "音频";
    case "skill": return `技能 ${input.name}`;
    case "mention": return `引用 ${input.name}`;
  }
}

function inputDescription(input: QueueInputPreview): ReactNode {
  switch (input.type) {
    case "text": return input.text;
    case "image": return "已附加图片";
    case "audio": return "已附加音频";
    case "localImage": return `本地图片 · ${input.path}`;
    case "localAudio": return `本地音频 · ${input.path}`;
    case "skill": return `技能 ${input.name} · ${input.path}`;
    case "mention": return `引用 ${input.name} · ${input.path}`;
  }
}

function RealtimeStatus({ realtime }: { readonly realtime: ServerEventSnapshot["realtimeByThread"][string] }) {
  return <article className={styles.card}>
    <header><h4>实时会话</h4><span>{STATUS_LABELS[realtime.status]}</span></header>
    {realtime.transcripts.map((transcript, index) => <div className={styles.transcript} key={index}>
      <span>{transcript.role === "user" ? "用户" : transcript.role === "assistant" ? "助手" : transcript.role}{transcript.completed ? "" : " · 转写中"}</span>
      <p>{transcript.text}</p>
      {transcript.truncated ? <Truncated /> : null}
    </div>)}
    {realtime.audioChunks > 0 ? <p className={styles.muted}>已接收 {number(realtime.audioChunks)} 个音频片段 · {number(realtime.audioBytes)} 字节</p> : null}
    {realtime.audioTruncated ? <p className={styles.muted}>音频缓存已达到上限，仅保留最近片段</p> : null}
    {realtime.chunks.length > 0 ? <AudioPlayback chunks={realtime.chunks} /> : null}
    {realtime.sdp ? <p className={styles.muted}>实时音频连接参数已收到</p> : null}
  </article>;
}

function AudioPlayback({ chunks }: { readonly chunks: readonly ThreadRealtimeAudioChunk[] }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { if (url !== null) URL.revokeObjectURL(url); }, [url]);
  const prepare = () => {
    try {
      setUrl(URL.createObjectURL(pcmWave(chunks)));
      setError(null);
    } catch {
      setError("音频片段格式无效，无法播放");
    }
  };
  return <div className={styles.audio}>
    <button onClick={prepare} type="button">{url === null ? "加载已接收音频" : "更新音频片段"}</button>
    {url === null ? null : <audio aria-label="已接收音频" controls preload="none" src={url} />}
    {error === null ? null : <p role="status">{error}</p>}
  </div>;
}

// The upstream realtime transport uses audio/pcm: signed 16-bit little-endian samples.
function pcmWave(chunks: readonly ThreadRealtimeAudioChunk[]): Blob {
  const first = chunks[0];
  if (first === undefined || !Number.isInteger(first.sampleRate) || first.sampleRate < 1 || first.sampleRate > 192_000
    || !Number.isInteger(first.numChannels) || first.numChannels < 1 || first.numChannels > 8) throw new Error("Invalid PCM format");
  const payloads = chunks.map((chunk) => {
    if (chunk.sampleRate !== first.sampleRate || chunk.numChannels !== first.numChannels) throw new Error("Mixed PCM formats");
    return atob(chunk.data);
  });
  const length = payloads.reduce((total, chunk) => total + chunk.length, 0);
  if (length === 0 || length > 1_048_576 || length % (first.numChannels * 2) !== 0) throw new Error("Invalid PCM length");
  const bytes = new Uint8Array(44 + length);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  label(0, "RIFF"); view.setUint32(4, 36 + length, true); label(8, "WAVE");
  label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, first.numChannels, true); view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.sampleRate * first.numChannels * 2, true);
  view.setUint16(32, first.numChannels * 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, length, true);
  let offset = 44;
  for (const payload of payloads) {
    for (let index = 0; index < payload.length; index += 1) bytes[offset++] = payload.charCodeAt(index);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

function Records({ records }: { readonly records: readonly ServerEventRecord[] }) {
  return <ul className={styles.records}>{[...records].reverse().map((record) => <li className={styles.card} data-status={record.status} key={record.id}>
    <header><h4>{record.title}</h4><span>{STATUS_LABELS[record.status]}</span></header>
    {record.detail ? <p>{record.detail}</p> : null}
    {record.text || record.params !== undefined ? <Detail title="查看详情">{() => <>
      {record.text ? <pre className={styles.output}>{record.text}</pre> : null}
      {record.params === undefined ? null : <pre className={styles.output}>{formatDetails(record.params)}</pre>}
    </>}</Detail> : null}
    {record.truncated ? <Truncated /> : null}
  </li>)}</ul>;
}

function Failures({ failures }: { readonly failures: readonly RequestFailure[] }) {
  return <ul className={styles.records}>{failures.map((failure) => <li className={styles.card} data-status="failed" key={failure.key}>
    <h4>客户端请求未完成</h4><p>{failure.message}</p>
  </li>)}</ul>;
}

function Detail({ title, children }: { readonly title: string; readonly children: ReactNode | (() => ReactNode) }) {
  const [open, setOpen] = useState(false);
  return <details className={styles.detail} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>{open ? <div>{typeof children === "function" ? children() : children}</div> : null}
  </details>;
}

function Truncated() {
  return <p className={styles.muted}>内容较长，仅展示保留的片段</p>;
}

function remainingRatio(used: number, total: number): number {
  return Math.min(1, Math.max(0, (total - used) / total));
}

function number(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatDetails(value: unknown): string {
  if (typeof value === "string") {
    try { return JSON.stringify(redactSensitive(JSON.parse(value)), null, 2); }
    catch { return "详情已截断，无法显示完整结构"; }
  }
  return JSON.stringify(redactSensitive(value), null, 2) ?? "";
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, /token|password|secret|authorization|cookie|private.?key|api.?key|credential/iu.test(key) ? "••••••" : redactSensitive(item),
  ]));
}

function ActivityIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>;
}
