import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import syntaxTokenStyles from "../components/SyntaxToken.module.css";
import { WindowControls } from "../components/WindowControls";
import { useVirtualRows } from "../components/useVirtualRows";
import {
  syntaxHighlighter as sharedSyntaxHighlighter,
  type HighlightedLines,
  type SyntaxHighlighter,
} from "../content/syntaxHighlighting";
import {
  clearProtocolTrace,
  subscribeProtocolTrace,
  type ProtocolMessageKind,
  type ProtocolTraceBatch,
  type ProtocolTraceDirection,
  type ProtocolTraceEntry,
  type ProtocolTraceScope,
} from "../transport/protocolTrace";
import styles from "./ProtocolDebugWindow.module.css";

interface TraceSummary {
  readonly retainedCount: number;
  readonly retainedBytes: number;
  readonly evictedCount: number;
}

const EMPTY_SUMMARY: TraceSummary = {
  retainedCount: 0,
  retainedBytes: 0,
  evictedCount: 0,
};

export function ProtocolDebugWindow({
  syntaxHighlighter = sharedSyntaxHighlighter,
}: {
  readonly syntaxHighlighter?: SyntaxHighlighter;
}) {
  const [entries, setEntries] = useState<readonly ProtocolTraceEntry[]>([]);
  const [summary, setSummary] = useState<TraceSummary>(EMPTY_SUMMARY);
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [direction, setDirection] = useState<ProtocolTraceDirection | "all">(
    "all",
  );
  const [kind, setKind] = useState<ProtocolMessageKind | "all">("all");
  const [scope, setScope] = useState<ProtocolTraceScope | "all">("all");
  const [serverId, setServerId] = useState("all");
  const [windowLabel, setWindowLabel] = useState("all");
  const [query, setQuery] = useState("");
  const [autoFollow, setAutoFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const receiveBatch = useCallback((batch: ProtocolTraceBatch) => {
    setEntries((current) => mergeBatch(current, batch));
    setSummary({
      retainedCount: batch.retainedCount,
      retainedBytes: batch.retainedBytes,
      evictedCount: batch.evictedCount,
    });
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeProtocolTrace(receiveBatch).then(
      (release) => {
        if (active) {
          unsubscribe = release;
          setError(null);
        } else {
          release();
        }
      },
      () => {
        if (active) setError("无法订阅协议追踪，请关闭窗口后重试");
      },
    );
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [receiveBatch]);

  const serverOptions = useMemo(
    () => [...new Set(entries.flatMap((entry) =>
      entry.serverId === undefined ? [] : [entry.serverId]
    ))].sort(),
    [entries],
  );
  const windowOptions = useMemo(
    () => [...new Set(entries.flatMap((entry) =>
      entry.windowLabel === undefined ? [] : [entry.windowLabel]
    ))].sort(),
    [entries],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => entries.filter((entry) =>
      (direction === "all" || entry.direction === direction) &&
      (kind === "all" || entry.kind === kind) &&
      (scope === "all" || entry.scope === scope) &&
      (serverId === "all" || entry.serverId === serverId) &&
      (windowLabel === "all" || entry.windowLabel === windowLabel) &&
      (normalizedQuery.length === 0 ||
        searchableText(entry).includes(normalizedQuery))
    ),
    [direction, entries, kind, normalizedQuery, scope, serverId, windowLabel],
  );
  const selected = entries.find(({ sequence }) =>
    sequence === selectedSequence
  ) ?? null;
  const virtual = useVirtualRows({
    count: filtered.length,
    estimateSize: () => 42,
    getKey: (index) => String(filtered[index]?.sequence ?? index),
    scrollerRef: listRef,
    threshold: 80,
    overscan: 420,
  });
  const scrollToBottom = virtual.scrollToBottom;
  const lastFilteredSequence = filtered.at(-1)?.sequence ?? null;

  useEffect(() => {
    if (!autoFollow || filtered.length === 0) return;
    scrollToBottom();
    setSelectedSequence((current) =>
      current ?? lastFilteredSequence
    );
  }, [autoFollow, filtered.length, lastFilteredSequence, scrollToBottom]);

  useEffect(() => {
    if (
      selectedSequence !== null &&
      !entries.some(({ sequence }) => sequence === selectedSequence)
    ) {
      setSelectedSequence(entries.at(-1)?.sequence ?? null);
    }
  }, [entries, selectedSequence]);

  const clear = async () => {
    try {
      await clearProtocolTrace();
      setSelectedSequence(null);
      setEntries([]);
      setSummary(EMPTY_SUMMARY);
      setError(null);
    } catch {
      setError("无法清空协议追踪");
    }
  };

  return (
    <div className={styles.window}>
      <header
        className={styles.titlebar}
        data-tauri-drag-region
        data-window-menu-region="self"
      >
        <WindowControls side="left" />
        <div
          className={styles.title}
          data-tauri-drag-region
          data-window-menu-region="deep"
        >
          <strong data-tauri-drag-region>协议检查器</strong>
          <small data-tauri-drag-region>只读 · 关闭窗口后清空</small>
        </div>
        <span
          className={styles.dragRegion}
          data-tauri-drag-region
          data-window-menu-region="self"
        />
        <WindowControls side="right" />
      </header>

      <section aria-label="协议追踪过滤器" className={styles.toolbar}>
        <select
          aria-label="服务器"
          onChange={(event) => setServerId(event.target.value)}
          value={serverId}
        >
          <option value="all">全部服务器</option>
          {serverOptions.map((id) => (
            <option key={id} value={id}>{shortIdentifier(id)}</option>
          ))}
        </select>
        <select
          aria-label="方向"
          onChange={(event) =>
            setDirection(event.target.value as ProtocolTraceDirection | "all")}
          value={direction}
        >
          <option value="all">全部方向</option>
          <option value="outbound">客户端 → 服务端</option>
          <option value="inbound">服务端 → 客户端</option>
        </select>
        <select
          aria-label="消息类型"
          onChange={(event) =>
            setKind(event.target.value as ProtocolMessageKind | "all")}
          value={kind}
        >
          <option value="all">全部类型</option>
          <option value="request">请求</option>
          <option value="response">响应</option>
          <option value="notification">通知</option>
          <option value="unknown">未知</option>
        </select>
        <select
          aria-label="来源"
          onChange={(event) =>
            setScope(event.target.value as ProtocolTraceScope | "all")}
          value={scope}
        >
          <option value="all">全部来源</option>
          <option value="configured">已配置连接</option>
          <option value="connectionTest">连接测试</option>
        </select>
        <select
          aria-label="窗口"
          onChange={(event) => setWindowLabel(event.target.value)}
          value={windowLabel}
        >
          <option value="all">全部窗口</option>
          {windowOptions.map((label) => (
            <option key={label} value={label}>{label}</option>
          ))}
        </select>
        <input
          aria-label="搜索协议消息"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索方法、ID 或内容"
          type="search"
          value={query}
        />
        <button
          aria-pressed={!autoFollow}
          onClick={() => setAutoFollow((current) => !current)}
          type="button"
        >
          {autoFollow ? "暂停跟随" : "继续跟随"}
        </button>
        <button onClick={() => void clear()} type="button">清空</button>
      </section>

      <div className={styles.notice}>
        <span>
          追踪内容可能包含提示词、代码、路径和工具输出，认证字段已强制脱敏
        </span>
        <span>
          {summary.retainedCount} 条 · {formatBytes(summary.retainedBytes)}
          {summary.evictedCount === 0
            ? ""
            : ` · 已淘汰 ${summary.evictedCount} 条`}
        </span>
      </div>

      {error === null ? null : (
        <p className={styles.error} role="alert">{error}</p>
      )}

      <main className={styles.workspace}>
        <section aria-label="协议消息列表" className={styles.timeline}>
          <div aria-hidden="true" className={styles.columnHeader}>
            <span>时间</span>
            <span>方向</span>
            <span>类型</span>
            <span>方法</span>
            <span>耗时</span>
          </div>
          <div
            className={styles.list}
            onScroll={(event) => {
              const element = event.currentTarget;
              const following =
                element.scrollHeight - element.scrollTop -
                  element.clientHeight < 24;
              if (following !== autoFollow) setAutoFollow(following);
            }}
            ref={listRef}
          >
            {filtered.length === 0 ? (
              <div className={styles.empty}>等待 app-server 协议消息</div>
            ) : (
              <div
                className={styles.virtualList}
                style={{ height: virtual.totalSize }}
              >
                {virtual.rows.map((row) => {
                  const entry = filtered[row.index];
                  if (entry === undefined) return null;
                  return (
                    <button
                      aria-current={selectedSequence === entry.sequence
                        ? "true"
                        : undefined}
                      className={styles.traceRow}
                      key={entry.sequence}
                      onClick={() => {
                        setSelectedSequence(entry.sequence);
                        setAutoFollow(false);
                      }}
                      style={{
                        height: row.size,
                        transform: `translateY(${row.start}px)`,
                      }}
                      title={entry.method ?? entry.requestId ?? "协议消息"}
                      type="button"
                    >
                      <time>{formatTime(entry.timestampMs)}</time>
                      <span
                        className={entry.direction === "outbound"
                          ? styles.outbound
                          : styles.inbound}
                      >
                        {entry.direction === "outbound" ? "→" : "←"}
                      </span>
                      <span>{kindLabel(entry.kind)}</span>
                      <code>{entry.method ?? "—"}</code>
                      <span>{entry.durationMs === undefined
                        ? "—"
                        : formatDuration(entry.durationMs)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className={styles.details}>
          {selected === null ? (
            <div className={styles.empty}>选择一条消息查看详情</div>
          ) : (
            <>
              <header>
                <div>
                  <strong>{selected.method ?? kindLabel(selected.kind)}</strong>
                  <small>
                    #{selected.sequence} · {directionLabel(selected.direction)}
                  </small>
                </div>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(selected.payload).then(
                      () => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1_500);
                      },
                      () => setError("无法复制协议消息"),
                    );
                  }}
                  type="button"
                >
                  {copied ? "已复制" : "复制 JSON"}
                </button>
              </header>
              <dl className={styles.metadata}>
                <Metadata label="服务器" value={selected.serverId ?? "连接测试"} />
                <Metadata label="连接" value={selected.connectionId} />
                <Metadata label="来源窗口" value={selected.windowLabel ?? "全局"} />
                <Metadata
                  label="传输"
                  value={`${transportLabel(selected.transport)} · ${selected.connectionPath}`}
                />
                <Metadata label="请求 ID" value={selected.requestId ?? "无"} />
                <Metadata
                  label="大小"
                  value={`${formatBytes(selected.originalBytes)}${
                    selected.truncated ? " · 展示已截断" : ""
                  }`}
                />
              </dl>
              <JsonPayload
                entry={selected}
                syntaxHighlighter={syntaxHighlighter}
              />
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

function JsonPayload({ entry, syntaxHighlighter }: {
  readonly entry: ProtocolTraceEntry;
  readonly syntaxHighlighter: SyntaxHighlighter;
}) {
  const source = prettyPayload(entry);
  const [highlightedSource, setHighlightedSource] = useState<{
    readonly lines: HighlightedLines;
    readonly source: string;
  } | null>(null);

  useEffect(() => {
    setHighlightedSource(null);
    let disposed = false;
    void syntaxHighlighter.highlight(source, "json").then(
      (lines) => {
        if (!disposed && highlightedText(lines) === source) {
          setHighlightedSource({ lines, source });
        }
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [source, syntaxHighlighter]);

  return (
    <pre className={styles.payload}>
      <code>
        {highlightedSource?.source === source
          ? renderHighlightedLines(highlightedSource.lines)
          : source}
      </code>
    </pre>
  );
}

function highlightedText(lines: HighlightedLines): string {
  return lines
    .map((line) => line.map((token) => token.content).join(""))
    .join("\n");
}

function renderHighlightedLines(lines: HighlightedLines): readonly ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (const [tokenIndex, token] of line.entries()) {
      nodes.push(
        <span
          className={syntaxTokenStyles.token}
          key={`${lineIndex}:${tokenIndex}`}
          style={token.style}
        >
          {token.content}
        </span>,
      );
    }
    if (lineIndex < lines.length - 1) nodes.push("\n");
  }
  return nodes;
}

function Metadata({ label, value }: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function mergeBatch(
  current: readonly ProtocolTraceEntry[],
  batch: ProtocolTraceBatch,
): readonly ProtocolTraceEntry[] {
  const combined = batch.reset ? [...batch.entries] : [...current, ...batch.entries];
  if (batch.oldestSequence === undefined) return Object.freeze(combined);
  return Object.freeze(
    combined.filter(({ sequence }) => sequence >= batch.oldestSequence!),
  );
}

function searchableText(entry: ProtocolTraceEntry): string {
  return [
    entry.method,
    entry.requestId,
    entry.serverId,
    entry.connectionId,
    entry.windowLabel,
    entry.payload,
  ].filter((value): value is string => value !== undefined)
    .join("\n")
    .toLocaleLowerCase();
}

function prettyPayload(entry: ProtocolTraceEntry): string {
  if (entry.truncated) return entry.payload;
  try {
    return JSON.stringify(JSON.parse(entry.payload) as unknown, null, 2);
  } catch {
    return entry.payload;
  }
}

function kindLabel(kind: ProtocolMessageKind): string {
  switch (kind) {
    case "request": return "请求";
    case "response": return "响应";
    case "notification": return "通知";
    case "unknown": return "未知";
  }
}

function directionLabel(direction: ProtocolTraceDirection): string {
  return direction === "outbound" ? "客户端 → 服务端" : "服务端 → 客户端";
}

function transportLabel(transport: ProtocolTraceEntry["transport"]): string {
  return transport === "localStdio" ? "本机 stdio" : "远程 WebSocket";
}

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs.toFixed(1)}ms`
    : `${(durationMs / 1_000).toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function shortIdentifier(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}
