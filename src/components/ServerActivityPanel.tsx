import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useServerEvents } from "../app/useServerEvents";
import type { ThreadTurn } from "../app/useServerThreads";
import type { ServerEventRecord, ServerEventSnapshot, ServerEventStore } from "../appServer/serverEventState";
import { parseTurnDiff } from "../content/turnDiff";
import type { ThreadGoal, ThreadRealtimeAudioChunk, ThreadTokenUsage } from "../protocol/generated/types/ServerNotification";
import { ComposerAccessoryDisclosure } from "./ComposerAccessoryPanel";
import { commandActivityTitle } from "./commandDisplay";
import { formatTokenCount } from "./formatTokenCount";
import { formatTerminalInput } from "./formatTerminalInput";
import styles from "./ServerActivityPanel.module.css";

interface RequestFailure {
  readonly key: string;
  readonly message: string;
  readonly threadId: string | null;
}

const EMPTY_FAILURES: readonly RequestFailure[] = [];
const EMPTY_TURNS: readonly ThreadTurn[] = [];
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
  "thread/realtime/transcript/delta", "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta",
]);

export function ServerActivityPanel({ store, threadId, turns = EMPTY_TURNS, failures = EMPTY_FAILURES, onOpenDiff }: {
  readonly store: ServerEventStore | null;
  readonly threadId: string | null;
  readonly turns?: readonly ThreadTurn[];
  readonly failures?: readonly RequestFailure[];
  readonly onOpenDiff?: (path: string, diff: string) => void;
}) {
  const snapshot = useServerEvents(store);
  const [expanded, setExpanded] = useState(false);

  if (threadId === null) return null;

  const threadRecords = snapshot?.records.filter((record) => record.threadId === threadId && record.status !== "completed" && !SPECIALIZED_METHODS.has(record.method)) ?? [];
  const threadFailures = failures.filter((failure) => failure.threadId === threadId);
  const usage = snapshot?.tokenUsageByThread[threadId];
  const goal = snapshot?.goalsByThread[threadId];
  const diffs = Object.values(snapshot?.diffsByTurn ?? {}).filter((diff) => diff.threadId === threadId);
  const realtime = snapshot?.realtimeByThread[threadId];
  const hasGoal = goal?.goal != null && goal.goal.status !== "complete";
  const hasRealtime = realtime !== undefined && (realtime.status !== "completed" || realtime.transcripts.length > 0 || realtime.chunks.length > 0);
  const attention = threadRecords.filter((record) => record.status === "warning" || record.status === "failed").length
    + threadFailures.length;
  const hasThread = threadRecords.length > 0 || threadFailures.length > 0 || usage !== undefined || hasGoal || diffs.length > 0 || hasRealtime;

  if (!hasThread) return null;

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
        <section aria-label="当前会话状态" className={styles.scope}>
          <h3>当前会话</h3>
          {usage === undefined ? null : <TokenUsage usage={usage.tokenUsage} stale={usage.stale} />}
          {hasGoal ? <GoalStatus goal={goal.goal} stale={goal.stale} /> : null}
          {diffs.map((diff) => <TurnDiffSummary diff={diff} key={`${threadId}:${diff.turnId}`} {...(onOpenDiff === undefined ? {} : { onOpenDiff })} />)}
          {hasRealtime ? <RealtimeStatus key={threadId} realtime={realtime} /> : null}
          <Failures failures={threadFailures} />
          <Records records={threadRecords} turns={turns} />
        </section>
      </div>
    </ComposerAccessoryDisclosure>
  );
}

function TurnDiffSummary({ diff, onOpenDiff }: {
  readonly diff: ServerEventSnapshot["diffsByTurn"][string];
  readonly onOpenDiff?: (path: string, diff: string) => void;
}) {
  const parsed = useMemo(() => parseTurnDiff(diff.diff), [diff.diff]);
  const partial = diff.truncated || parsed.incomplete;
  const totals = parsed.files.reduce((sum, file) => ({
    additions: sum.additions + file.additions,
    deletions: sum.deletions + file.deletions,
  }), { additions: 0, deletions: 0 });
  const kinds = { add: "新增", update: "修改", delete: "删除", rename: "重命名" };

  return <Detail title={<span className={styles.diffSummary}>
    <span>本轮汇总变更 · {partial ? "已识别 " : ""}{parsed.files.length} 个文件</span>
    {parsed.files.length > 0 ? <DiffStats {...totals} /> : null}
  </span>}>
    {diff.stale ? <p className={styles.muted}>连接已断开，显示最后收到的变更</p> : null}
    {partial ? <p className={styles.muted}>{diff.truncated ? "内容已截断，仅统计可识别文件" : "部分变更无法识别，仅统计可识别文件"}</p> : null}
    {parsed.files.length === 0 && !partial ? <p className={styles.muted}>暂无文件变更</p> : null}
    <ul aria-label="变更文件" className={styles.diffFiles}>
      {parsed.files.map((file) => {
        const path = file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`;
        const label = `${kinds[file.kind]} ${path}，新增 ${file.additions} 行，删除 ${file.deletions} 行`;
        const content = <>
          <span className={styles.diffKind}>{kinds[file.kind]}</span>
          <code className={styles.diffPath} title={path}>{path}</code>
          <DiffStats additions={file.additions} deletions={file.deletions} />
        </>;
        return <li key={file.path}>{onOpenDiff === undefined
          ? <div className={styles.diffFile} aria-label={label}>{content}</div>
          : <button aria-label={label} className={styles.diffFile} onClick={() => onOpenDiff(file.path, file.diff)} type="button">{content}</button>}
        </li>;
      })}
    </ul>
    {partial ? <Detail title="查看保留的原始补丁"><pre className={styles.output}>{diff.diff}</pre></Detail> : null}
  </Detail>;
}

function DiffStats({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
  return <span aria-label={`新增 ${additions} 行，删除 ${deletions} 行`} className={styles.diffStats}>
    <span>+{additions}</span><span>−{deletions}</span>
  </span>;
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
      : <p className={styles.muted}>已使用 {formatTokenCount(goal.tokensUsed)} Token · 未设置 Token 预算</p>}
    <p className={styles.muted}>已运行 {number(Math.round(goal.timeUsedSeconds))} 秒</p>
  </article>;
}

function Remaining({ label, used, total }: { readonly label: string; readonly used: number; readonly total: number }) {
  const remaining = Math.min(total, Math.max(0, total - used));
  const percent = Math.round(remainingRatio(used, total) * 100);
  return <div className={styles.remaining}>
    <span>{label}剩余 {formatTokenCount(remaining)} / {formatTokenCount(total)} Token · {percent}%</span>
    <div aria-label={`${label}剩余`} aria-valuemax={total} aria-valuemin={0} aria-valuenow={remaining} className={styles.track} role="meter">
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return <div><dt>{label}</dt><dd>{formatTokenCount(value)}</dd></div>;
}

function RealtimeStatus({ realtime }: { readonly realtime: ServerEventSnapshot["realtimeByThread"][string] }) {
  return <article className={styles.card}>
    <header><h4>实时会话</h4>{realtime.status === "completed" ? null : <span>{STATUS_LABELS[realtime.status]}</span>}</header>
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

function Records({ records, turns }: { readonly records: readonly ServerEventRecord[]; readonly turns: readonly ThreadTurn[] }) {
  // 终端输入可以发生在后续回合，itemId 始终指向最初启动的命令
  const commands = useMemo(() => new Map(turns.flatMap((turn) => turn.items.flatMap((item) =>
    item.type === "commandExecution" ? [[item.id, item] as const] : [],
  ))), [turns]);
  return <ul className={styles.records}>{[...records].reverse().map((record) => {
    const command = record.terminalInput === undefined ? undefined : commands.get(record.terminalInput.itemId);
    return <li className={styles.card} data-status={record.status} key={record.id}>
      <header><h4>{record.title}</h4><span>{record.terminalInput === undefined ? STATUS_LABELS[record.status] : "已发送"}</span></header>
      {record.terminalInput === undefined ? <>
        {record.detail ? <p>{record.detail}</p> : null}
        {record.text || record.params !== undefined ? <Detail title="查看详情">{() => <>
          {record.text ? <pre className={styles.output}>{record.text}</pre> : null}
          {record.params === undefined ? null : <pre className={styles.output}>{formatDetails(record.params)}</pre>}
        </>}</Detail> : null}
      </> : <>
        {command === undefined
          ? <p className={styles.muted}>命令记录未加载</p>
          : <p aria-label="对应命令" className={styles.terminalCommand} data-status={command.status}>{commandActivityTitle(command)}</p>}
        <p className={styles.muted}>进程 {record.terminalInput.processId}</p>
        <pre aria-label="已发送的终端输入" className={styles.output}>{formatTerminalInput(record.text ?? "")}</pre>
      </>}
      {record.truncated ? <Truncated /> : null}
    </li>;
  })}</ul>;
}

function Failures({ failures }: { readonly failures: readonly RequestFailure[] }) {
  return <ul className={styles.records}>{failures.map((failure) => <li className={styles.card} data-status="failed" key={failure.key}>
    <h4>客户端请求未完成</h4><p>{failure.message}</p>
  </li>)}</ul>;
}

function Detail({ title, children }: { readonly title: ReactNode; readonly children: ReactNode | (() => ReactNode) }) {
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
