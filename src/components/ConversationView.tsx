import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from "react";

import type { RestoredThread, ThreadTurn } from "../app/useServerThreads";
import { SafeMarkdown } from "./SafeMarkdown";
import { useVirtualRows } from "./useVirtualRows";
import styles from "./ConversationView.module.css";

export interface ConversationViewProps {
  readonly hasOlderTurns: boolean;
  readonly loadingOlderTurns: boolean;
  readonly onLoadOlderTurns: () => Promise<void>;
  readonly restoredThread: RestoredThread;
  readonly onForkTurn?: (turnId: string, isLatest: boolean) => void;
  readonly actionError?: string | null;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
}

export function ConversationPlaceholder({
  kind,
  onNewTask,
}: {
  readonly kind: "blank" | "loading" | "error" | "deleted";
  readonly onNewTask?: () => void;
}) {
  const copy =
    kind === "blank"
      ? ["开始一个新任务", "发送第一条消息时才会创建服务端会话"]
      : kind === "loading"
        ? ["正在恢复会话", "正在读取最近的回合和服务端状态"]
        : kind === "deleted"
          ? ["会话已被删除", "服务端已删除此会话，不能继续提交输入"]
          : ["无法恢复会话", "可从左侧重新选择会话或重试连接"];
  return (
    <section
      className={styles.placeholder}
      role={kind === "error" || kind === "deleted" ? "alert" : "status"}
    >
      <strong>{copy[0]}</strong>
      <span>{copy[1]}</span>
      {kind === "deleted" && onNewTask !== undefined ? (
        <button onClick={onNewTask} type="button">
          返回新建页
        </button>
      ) : null}
    </section>
  );
}

type ThreadItem = ThreadTurn["items"][number];
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type FileUpdateChange = FileChangeItem["changes"][number];
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

const PANEL_TRANSITION_MS = 210;

interface HistoryQuestion {
  readonly answer: string | null;
  readonly itemId: string;
  readonly question: string;
  readonly rowIndex: number;
}

type ConversationRow =
  | { readonly key: "action-error"; readonly type: "actionError" }
  | { readonly key: "load-older"; readonly type: "loadOlder" }
  | { readonly key: "empty"; readonly type: "empty" }
  | {
      readonly key: string;
      readonly type: "segment";
      readonly firstInTurn: boolean;
      readonly isLatestTurn: boolean;
      readonly segment: TurnSegment;
      readonly turn: ThreadTurn;
    };

export function ConversationView({
  hasOlderTurns,
  loadingOlderTurns,
  onLoadOlderTurns,
  onForkTurn,
  actionError = null,
  onOpenLink,
  onOpenDiff,
  restoredThread,
}: ConversationViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const loadingAnchorRef = useRef(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [loadingAnchorKey, setLoadingAnchorKey] = useState<string | null>(null);
  const itemCount = restoredThread.turns.reduce(
    (count, turn) => count + turn.items.length,
    0,
  );
  const rows = useMemo(
    () => conversationRows(restoredThread.turns, actionError !== null, hasOlderTurns),
    [actionError, hasOlderTurns, restoredThread.turns],
  );
  const historyQuestions = useMemo(
    () => historyQuestionItems(restoredThread.turns, rows),
    [restoredThread.turns, rows],
  );
  const pinnedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (focusedRowKey !== null) {
      keys.add(focusedRowKey);
    }
    if (loadingAnchorKey !== null) {
      keys.add(loadingAnchorKey);
    }
    const activeTurn = restoredThread.turns.findLast(
      ({ status }) => status === "inProgress",
    );
    if (activeTurn !== undefined) {
      const activeRows = rows.filter(
        (row) => row.type === "segment" && row.turn.id === activeTurn.id,
      );
      for (const row of activeRows.slice(-2)) {
        keys.add(row.key);
      }
    }
    return keys;
  }, [focusedRowKey, loadingAnchorKey, restoredThread.turns, rows]);
  const getRowKey = useCallback(
    (index: number) => rows[index]?.key ?? `missing:${index}`,
    [rows],
  );
  const estimateRowSize = useCallback(
    (index: number) => estimateConversationRow(rows[index]),
    [rows],
  );
  const virtual = useVirtualRows({
    count: rows.length,
    estimateSize: estimateRowSize,
    getKey: getRowKey,
    pinnedKeys,
    scrollerRef,
    overscan: 720,
    threshold: 30,
  });
  const handleActivityExpandedChange = useCallback((expanded: boolean) => {
    if (expanded) {
      stickToBottomRef.current = false;
    }
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null && stickToBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [itemCount, restoredThread.turns.length, virtual.totalSize]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null && restoredThread.turns.length > 0) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [restoredThread.metadata.id]);

  const loadOlder = async () => {
    const scroller = scrollerRef.current;
    if (
      scroller === null ||
      loadingAnchorRef.current ||
      loadingOlderTurns ||
      !hasOlderTurns
    ) {
      return;
    }
    loadingAnchorRef.current = true;
    setLoadingAnchorKey(virtual.keyAtOffset(scroller.scrollTop));
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    let restoreScheduled = false;
    try {
      await onLoadOlderTurns();
      restoreScheduled = true;
      requestAnimationFrame(() => {
        const current = scrollerRef.current;
        if (current !== null) {
          current.scrollTop = previousTop + current.scrollHeight - previousHeight;
        }
        setLoadingAnchorKey(null);
        loadingAnchorRef.current = false;
      });
    } finally {
      if (!restoreScheduled) {
        setLoadingAnchorKey(null);
        loadingAnchorRef.current = false;
      }
    }
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    stickToBottomRef.current = distanceFromBottom <= 120;
    setShowJumpToBottom(distanceFromBottom > 120);
    if (scroller.scrollTop <= 48) {
      void loadOlder();
    }
  };

  return (
    <section className={styles.conversation}>
      <div
        aria-label="会话消息"
        className={styles.scroller}
        onScroll={handleScroll}
        ref={scrollerRef}
      >
        <div
          className={`${styles.messageColumn}${
            historyQuestions.length >= 4
              ? ` ${styles.messageColumnWithQuestionNavigation}`
              : ""
          }`}
        >
          <div
            aria-label="会话内容列表"
            className={styles.virtualConversation}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setFocusedRowKey(null);
              }
            }}
            onFocusCapture={(event) => {
              const row = event.target instanceof HTMLElement
                ? event.target.closest<HTMLElement>("[data-virtual-key]")
                : null;
              setFocusedRowKey(row?.dataset.virtualKey ?? null);
            }}
            role="list"
            style={{ height: virtual.totalSize } as CSSProperties}
          >
            {virtual.rows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (row === undefined) {
                return null;
              }
              return (
                <div
                  className={styles.virtualConversationRow}
                  data-first-in-turn={
                    row.type === "segment" && row.firstInTurn
                  }
                  data-row-type={row.type}
                  data-status={
                    row.type === "segment" ? row.turn.status : undefined
                  }
                  data-virtual-key={virtualRow.key}
                  key={virtualRow.key}
                  ref={virtual.measureElement(virtualRow.key)}
                  role="listitem"
                  style={{ top: virtualRow.start }}
                >
                  <ConversationRowView
                    actionError={actionError}
                    loadingOlderTurns={loadingOlderTurns}
                    onActivityExpandedChange={handleActivityExpandedChange}
                    onLoadOlder={() => void loadOlder()}
                    {...(onForkTurn === undefined ? {} : { onForkTurn })}
                    {...(onOpenLink === undefined ? {} : { onOpenLink })}
                    {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
                    row={row}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {historyQuestions.length >= 4 ? (
        <HistoryQuestionNavigation
          onSelect={(rowIndex) => {
            stickToBottomRef.current = false;
            virtual.scrollToIndex(rowIndex);
            setShowJumpToBottom(true);
          }}
          questions={historyQuestions}
        />
      ) : null}
      {showJumpToBottom ? (
        <button
          className={styles.jumpToBottom}
          onClick={() => {
            const scroller = scrollerRef.current;
            if (scroller !== null) {
              stickToBottomRef.current = true;
              scroller.scrollTo({ behavior: "smooth", top: scroller.scrollHeight });
            }
          }}
          type="button"
        >
          回到底部
        </button>
      ) : null}
    </section>
  );
}

function ConversationRowView({
  actionError,
  loadingOlderTurns,
  onActivityExpandedChange,
  onLoadOlder,
  onForkTurn,
  onOpenLink,
  onOpenDiff,
  row,
}: {
  readonly actionError: string | null;
  readonly loadingOlderTurns: boolean;
  readonly onActivityExpandedChange: (expanded: boolean) => void;
  readonly onLoadOlder: () => void;
  readonly onForkTurn?: (turnId: string, isLatest: boolean) => void;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly row: ConversationRow;
}) {
  if (row.type === "actionError") {
    return <div className={styles.actionError} role="alert">{actionError}</div>;
  }
  if (row.type === "loadOlder") {
    return (
      <button
        className={styles.loadOlder}
        disabled={loadingOlderTurns}
        onClick={onLoadOlder}
        type="button"
      >
        {loadingOlderTurns ? "正在加载更早历史" : "加载更早历史"}
      </button>
    );
  }
  if (row.type === "empty") {
    return <div className={styles.empty}>这个会话还没有回合</div>;
  }
  return row.segment.type === "item" ? (
    <ItemView
      item={row.segment.item}
      isLatestTurn={row.isLatestTurn}
      onActivityExpandedChange={onActivityExpandedChange}
      {...(row.turn.completedAt === undefined
        ? {}
        : { turnCompletedAt: row.turn.completedAt })}
      {...(row.turn.startedAt === undefined
        ? {}
        : { turnStartedAt: row.turn.startedAt })}
      {...(onForkTurn === undefined
        ? {}
        : { onFork: () => onForkTurn(row.turn.id, row.isLatestTurn) })}
      {...(onOpenLink === undefined ? {} : { onOpenLink })}
      {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
    />
  ) : (
    <ActivityGroup
      items={row.segment.items}
      onExpandedChange={onActivityExpandedChange}
      turn={row.turn}
      {...(onOpenLink === undefined ? {} : { onOpenLink })}
      {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
    />
  );
}

function HistoryQuestionNavigation({
  onSelect,
  questions,
}: {
  readonly onSelect: (rowIndex: number) => void;
  readonly questions: readonly HistoryQuestion[];
}) {
  return (
    <nav aria-label="历史问题快速导航" className={styles.questionNavigation}>
      {questions.map((question, index) => {
        const previewId = `history-question-preview-${index}`;
        return (
          <button
            aria-describedby={previewId}
            aria-label={`跳转到问题 ${index + 1}：${question.question}`}
            className={styles.questionMarker}
            key={question.itemId}
            onClick={() => onSelect(question.rowIndex)}
            type="button"
          >
            <span aria-hidden="true" className={styles.questionMarkerLine} />
            <span className={styles.questionPreview} id={previewId} role="tooltip">
              <strong>{question.question}</strong>
              {question.answer === null ? null : <span>{question.answer}</span>}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function ItemView({
  item,
  isLatestTurn = false,
  onActivityExpandedChange,
  onFork,
  onOpenLink,
  onOpenDiff,
  turnCompletedAt,
  turnStartedAt,
}: {
  readonly item: ThreadItem;
  readonly isLatestTurn?: boolean;
  readonly onActivityExpandedChange: (expanded: boolean) => void;
  readonly onFork?: () => void;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly turnCompletedAt?: number | null;
  readonly turnStartedAt?: number | null;
}) {
  switch (item.type) {
    case "userMessage":
      return (
        <UserMessage
          item={item}
          {...(turnStartedAt === undefined ? {} : { turnStartedAt })}
        />
      );
    case "hookPrompt":
      return (
        <ActivityDisclosure
          label="Hook 提示"
          onExpandedChange={onActivityExpandedChange}
          status="notice"
        >
          {item.fragments.map(({ hookRunId, text }) => (
            <p key={hookRunId}>{text}</p>
          ))}
        </ActivityDisclosure>
      );
    case "agentMessage":
      return (
        <AgentMessage
          isLatestTurn={isLatestTurn}
          item={item}
          {...(turnCompletedAt === undefined ? {} : { turnCompletedAt })}
          {...(onFork === undefined ? {} : { onFork })}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
        />
      );
    case "plan":
      return (
        <ActivityDisclosure
          label="计划"
          onExpandedChange={onActivityExpandedChange}
          status="notice"
        >
          <pre>{item.text}</pre>
        </ActivityDisclosure>
      );
    case "reasoning":
      return (
        <ReasoningActivity
          item={item}
          onExpandedChange={onActivityExpandedChange}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
        />
      );
    case "commandExecution":
      return (
        <CommandActivity
          item={item}
          onExpandedChange={onActivityExpandedChange}
        />
      );
    case "fileChange":
      return (
        <FileChangeActivity
          item={item}
          {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
        />
      );
    case "mcpToolCall":
      return (
        <ActivityDisclosure
          label={toolActivityLabel(
            `MCP · ${item.server} / ${item.tool}`,
            item.status,
            item.durationMs,
          )}
          onExpandedChange={onActivityExpandedChange}
          status={item.status}
        >
          <JsonBlock value={item.arguments} />
          {item.error === undefined || item.error === null ? null : <p>{item.error.message}</p>}
          {item.result === undefined || item.result === null ? null : <JsonBlock value={item.result} />}
        </ActivityDisclosure>
      );
    case "dynamicToolCall":
      return (
        <ActivityDisclosure
          label={toolActivityLabel(
            `工具 · ${item.namespace ?? "client"} / ${item.tool}`,
            item.status,
            item.durationMs,
          )}
          onExpandedChange={onActivityExpandedChange}
          status={item.status}
        >
          <JsonBlock value={item.arguments} />
          {item.contentItems?.map((content, index) =>
            content.type === "inputText" ? <p key={index}>{content.text}</p> : <p key={index}>图片结果</p>,
          )}
        </ActivityDisclosure>
      );
    case "collabAgentToolCall":
      return (
        <ActivityDisclosure
          label={toolActivityLabel(`协作代理 · ${item.tool}`, item.status)}
          onExpandedChange={onActivityExpandedChange}
          status={item.status}
        >
          {item.prompt === undefined || item.prompt === null ? null : <p>{item.prompt}</p>}
          <JsonBlock value={item.agentsStates} />
        </ActivityDisclosure>
      );
    case "subAgentActivity":
      return (
        <ActivityLine
          label={`子代理 · ${item.kind} · ${item.agentPath}`}
          status="notice"
        />
      );
    case "webSearch":
      return <ActivityLine label={`网页搜索 · ${item.query}`} status="notice" />;
    case "imageView":
      return (
        <ActivityLine
          label={`查看图片 · ${item.path}`}
          {...(onOpenLink === undefined ? {} : { onClick: () => onOpenLink(item.path) })}
          status="notice"
        />
      );
    case "sleep":
      return (
        <ActivityLine
          label={`等待 · ${formatDuration(item.durationMs)}`}
          status="notice"
        />
      );
    case "imageGeneration":
      return (
        <ActivityDisclosure
          label={toolActivityLabel("图片生成", item.status)}
          onExpandedChange={onActivityExpandedChange}
          status={item.status}
        >
          <p>{item.result}</p>
          {item.savedPath === undefined || item.savedPath === null ? null : <code>{item.savedPath}</code>}
        </ActivityDisclosure>
      );
    case "enteredReviewMode":
      return <TimelineRecord label="进入审查模式" detail={item.review} />;
    case "exitedReviewMode":
      return <TimelineRecord label="退出审查模式" detail={item.review} />;
    case "contextCompaction":
      return <TimelineRecord label="上下文已压缩" />;
    default:
      return (
        <UnknownItem
          item={item}
          onExpandedChange={onActivityExpandedChange}
        />
      );
  }
}

function UserMessage({
  item,
  turnStartedAt,
}: {
  readonly item: Extract<ThreadItem, { type: "userMessage" }>;
  readonly turnStartedAt?: number | null;
}) {
  const plainText = item.content.map(userInputText).join("\n");
  const startedAt = typeof turnStartedAt === "number"
    ? new Date(turnStartedAt * 1_000)
    : null;
  const timestamp = startedAt === null ? null : formatTurnTime(startedAt);
  return (
    <article className={styles.userMessage} tabIndex={0}>
      <div className={styles.userMessageBubble}>
        {item.content.map((input, index) => {
          switch (input.type) {
            case "text":
              return <p key={index}>{input.text}</p>;
            case "skill":
              return <span className={styles.chip} key={index}>${input.name}</span>;
            case "mention":
              return <span className={styles.chip} key={index}>@{input.name}</span>;
            case "image":
              return <span className={styles.attachment} key={index}>图片附件</span>;
            case "localImage":
              return <span className={styles.attachment} key={index}>{pathName(input.path)}</span>;
          }
        })}
      </div>
      <div className={styles.userActions}>
        {timestamp === null || startedAt === null ? null : (
          <time
            aria-label={`提问时间 ${timestamp}`}
            className={styles.messageTimestamp}
            dateTime={startedAt.toISOString()}
          >
            {timestamp}
          </time>
        )}
        <CopyButton iconOnly label="复制用户消息" value={plainText} />
      </div>
    </article>
  );
}

function AgentMessage({
  isLatestTurn,
  item,
  onFork,
  onOpenLink,
  turnCompletedAt,
}: {
  readonly isLatestTurn: boolean;
  readonly item: Extract<ThreadItem, { type: "agentMessage" }>;
  readonly onFork?: () => void;
  readonly onOpenLink?: (link: string) => void;
  readonly turnCompletedAt?: number | null;
}) {
  const isFinalAnswer = item.phase === "final_answer";
  const completedAt = typeof turnCompletedAt === "number"
    ? new Date(turnCompletedAt * 1_000)
    : null;
  const timestamp = completedAt === null
    ? null
    : formatTurnTime(completedAt);
  return (
    <article
      className={styles.agentMessage}
      data-final-answer={isFinalAnswer}
      data-latest-turn={isLatestTurn}
      tabIndex={0}
    >
      <div className={styles.agentText}><SafeMarkdown {...(onOpenLink === undefined ? {} : { onOpenLink })} source={item.text} /></div>
      {isFinalAnswer ? (
        <div className={styles.agentActions}>
          <CopyButton
            alternateValue={markdownPlainText(item.text)}
            iconOnly
            label="复制 AI 回答"
            value={item.text}
          />
          {onFork === undefined ? null : (
            <MessageActionButton
              icon={<ContinueInNewThreadIcon />}
              label="在新会话中继续"
              onClick={onFork}
            />
          )}
          {timestamp === null || completedAt === null ? null : (
            <time
              aria-label={`回答时间 ${timestamp}`}
              className={`${styles.messageTimestamp} ${styles.answerTimestamp}`}
              dateTime={completedAt.toISOString()}
            >
              {timestamp}
            </time>
          )}
        </div>
      ) : null}
    </article>
  );
}

function ActivityGroup({
  items,
  onExpandedChange,
  onOpenDiff,
  onOpenLink,
  turn,
}: {
  readonly items: readonly ThreadItem[];
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly onOpenLink?: (link: string) => void;
  readonly turn: ThreadTurn;
}) {
  const finalAnswerStarted = turn.items.some(isFinalAnswer);
  const running = turn.status === "inProgress" && !finalAnswerStarted;
  const initiallyExpanded = running;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [contentVisible, setContentVisible] = useState(initiallyExpanded);
  const hideTimerRef = useRef<number | null>(null);
  const previousRunningRef = useRef(running);
  const duration = useTurnDuration(turn, running);
  const visibleItems = items;
  const runningCommand = visibleItems.findLast(
    (item): item is Extract<ThreadItem, { type: "commandExecution" }> =>
      item.type === "commandExecution" && item.status === "inProgress",
  );

  useEffect(() => () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const wasRunning = previousRunningRef.current;
    previousRunningRef.current = running;
    if (wasRunning === running) {
      return;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (running) {
      setExpanded(true);
      hideTimerRef.current = window.setTimeout(() => {
        setContentVisible(true);
        hideTimerRef.current = null;
      }, panelTransitionDuration());
      return () => {
        if (hideTimerRef.current !== null) {
          window.clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      };
    }
    setContentVisible(false);
    const frame = window.requestAnimationFrame(() => setExpanded(false));
    return () => window.cancelAnimationFrame(frame);
  }, [running]);

  const toggle = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (expanded) {
      onExpandedChange(false);
      setContentVisible(false);
      requestAnimationFrame(() => setExpanded(false));
      return;
    }
    onExpandedChange(true);
    setExpanded(true);
    hideTimerRef.current = window.setTimeout(() => {
      setContentVisible(true);
      hideTimerRef.current = null;
    }, panelTransitionDuration());
  };

  return (
    <section
      className={styles.activityGroup}
      data-expanded={expanded}
      data-status={turn.status}
    >
      <button aria-expanded={expanded} className={styles.activityGroupHeader} onClick={toggle} type="button">
        <span>{activityGroupLabel(turn.status, duration, finalAnswerStarted)}</span>
        <span aria-hidden="true">›</span>
      </button>
      <div className={styles.activityGroupSize}>
        <div className={styles.activityGroupClip}>
          <div className={styles.activityGroupContent} data-visible={contentVisible}>
            {visibleItems.map((item) => (
              isEmptyReasoning(item) ? (
                <div className={styles.thinking} key={item.id} role="status">Thinking</div>
              ) : (
                <ItemView
                  item={item}
                  key={item.id}
                  onActivityExpandedChange={onExpandedChange}
                  {...(onOpenLink === undefined ? {} : { onOpenLink })}
                  {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
                />
              )
            ))}
            {runningCommand === undefined ? null : (
              <div className={styles.activityProgress} role="status">
                正在运行命令
                {typeof runningCommand.durationMs === "number"
                  ? ` · ${formatDuration(runningCommand.durationMs)}`
                  : ""}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function CommandActivity({
  item,
  onExpandedChange,
}: {
  readonly item: CommandExecutionItem;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const output = item.aggregatedOutput?.trim().length === 0
    ? null
    : item.aggregatedOutput ?? null;
  return (
    <ActivityDisclosure
      label={commandActivityTitle(item)}
      onExpandedChange={onExpandedChange}
      status={item.status}
    >
      {output === null ? null : <pre>{output}</pre>}
    </ActivityDisclosure>
  );
}

function ReasoningActivity({
  item,
  onExpandedChange,
  onOpenLink,
}: {
  readonly item: ReasoningItem;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onOpenLink?: (link: string) => void;
}) {
  const summary = reasoningParts(item.summary);
  const content = reasoningParts(item.content);
  return (
    <ActivityDisclosure
      ariaLabel={summary.length === 0 ? "Thinking" : reasoningAccessibleLabel(summary)}
      label={summary.length === 0 ? "Thinking" : <ReasoningTitle parts={summary} />}
      onExpandedChange={onExpandedChange}
      status="notice"
    >
      {content.length === 0
        ? null
        : content.map((part, index) => (
          <SafeMarkdown
            {...(onOpenLink === undefined ? {} : { onOpenLink })}
            key={index}
            source={part}
          />
        ))}
    </ActivityDisclosure>
  );
}

function ReasoningTitle({ parts }: { readonly parts: readonly string[] }) {
  return (
    <span className={styles.reasoningTitle}>
      {parts.map((part, index) => (
        <span className={styles.reasoningTitleLine} data-activity-title-line key={index}>
          <SafeMarkdown source={part} variant="compact" />
        </span>
      ))}
    </span>
  );
}

function FileChangeActivity({
  item,
  onOpenDiff,
}: {
  readonly item: FileChangeItem;
  readonly onOpenDiff?: (path: string, diff: string) => void;
}) {
  return (
    <div className={styles.fileChanges}>
      {item.changes.map((change) => {
        const movedTo = change.kind.type === "update"
          ? change.kind.move_path ?? null
          : null;
        const path = movedTo === null
          ? change.path
          : `${change.path} → ${movedTo}`;
        const verb = fileChangeVerb(item.status, change.kind.type, movedTo !== null);
        const stats = fileChangeStats(change);
        const statsText = formatFileChangeStats(stats);
        const label = `${verb} ${path}`;
        const content = (
          <>
            <span className={styles.fileChangeTitle}>
              <strong>{verb}</strong>
              <code title={path}>{path}</code>
            </span>
            {statsText.length === 0 ? null : (
              <span aria-hidden="true" className={styles.fileChangeStats}>
                {statsText}
              </span>
            )}
          </>
        );
        const key = `${change.path}:${movedTo ?? ""}:${change.kind.type}`;
        if (onOpenDiff === undefined) {
          return (
            <div className={styles.fileChangeRow} data-status={item.status} key={key}>
              {content}
            </div>
          );
        }
        return (
          <button
            aria-label={`${label} ${statsText}`.trim()}
            className={styles.fileChangeRow}
            data-status={item.status}
            key={key}
            onClick={() => onOpenDiff(movedTo ?? change.path, change.diff)}
            type="button"
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

function ActivityDisclosure({
  ariaLabel,
  children,
  label,
  onExpandedChange,
  status,
}: {
  readonly ariaLabel?: string;
  readonly children?: ReactNode;
  readonly label: ReactNode;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly status: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentVisible, setContentVisible] = useState(false);
  const [titleTruncated, setTitleTruncated] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const hasDetails = Children.toArray(children).length > 0;
  const expandable = expanded || hasDetails || titleTruncated;

  const cancelTransition = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelTransition(), [cancelTransition]);

  const measureTitle = useCallback(() => {
    if (expanded || titleRef.current === null) {
      return;
    }
    const lineElements = Array.from(
      titleRef.current.querySelectorAll<HTMLElement>("[data-activity-title-line]"),
    );
    const measuredElements = lineElements.length === 0
      ? [titleRef.current]
      : lineElements;
    const truncated = measuredElements.some(
      (element) => element.scrollWidth > element.clientWidth,
    );
    setTitleTruncated((current) => current === truncated ? current : truncated);
  }, [expanded]);

  useLayoutEffect(() => {
    measureTitle();
  });

  useEffect(() => {
    if (expanded || titleRef.current === null) {
      return;
    }
    const title = titleRef.current;
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measureTitle);
    observer?.observe(title);
    for (const line of title.querySelectorAll<HTMLElement>("[data-activity-title-line]")) {
      observer?.observe(line);
    }
    window.addEventListener("resize", measureTitle);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureTitle);
    };
  }, [expandable, expanded, measureTitle]);

  const toggle = () => {
    cancelTransition();
    if (expanded) {
      onExpandedChange(false);
      setContentVisible(false);
      frameRef.current = window.requestAnimationFrame(() => {
        setExpanded(false);
        frameRef.current = null;
      });
      return;
    }
    onExpandedChange(true);
    setExpanded(true);
    if (hasDetails) {
      hideTimerRef.current = window.setTimeout(() => {
        setContentVisible(true);
        hideTimerRef.current = null;
      }, panelTransitionDuration());
    }
  };

  const title = (
    <>
      <span className={styles.activityRowTitle} data-activity-title ref={titleRef}>
        {label}
      </span>
      {expandable ? <span aria-hidden="true" className={styles.activityRowChevron}>›</span> : null}
    </>
  );

  return (
    <section
      className={styles.activityDisclosure}
      data-expanded={expanded}
      data-status={status}
    >
      {expandable ? (
        <button
          {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
          aria-expanded={expanded}
          className={styles.activityRowHeader}
          onClick={toggle}
          type="button"
        >
          {title}
        </button>
      ) : (
        <div className={styles.activityRowHeader}>{title}</div>
      )}
      {hasDetails ? (
        <div className={styles.activityDetailSize}>
          <div className={styles.activityDetailClip}>
            <div className={styles.activityDetail} data-activity-detail data-visible={contentVisible}>
              {children}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ActivityLine({
  label,
  onClick,
  status,
}: {
  readonly label: string;
  readonly onClick?: () => void;
  readonly status: string;
}) {
  if (onClick !== undefined) {
    return (
      <button
        className={styles.activityLine}
        data-status={status}
        onClick={onClick}
        title={label}
        type="button"
      >
        {label}
      </button>
    );
  }
  return (
    <div className={styles.activityLine} data-status={status} title={label}>
      {label}
    </div>
  );
}

function useTurnDuration(turn: ThreadTurn, running: boolean): number | null {
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  useEffect(() => {
    if (!running || typeof turn.startedAt !== "number") {
      return;
    }
    setCurrentTime(Date.now());
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, turn.id, turn.startedAt]);

  if (typeof turn.durationMs === "number") {
    return Math.max(0, turn.durationMs);
  }
  if (typeof turn.startedAt === "number" && typeof turn.completedAt === "number") {
    return Math.max(0, (turn.completedAt - turn.startedAt) * 1_000);
  }
  if (typeof turn.startedAt === "number") {
    return Math.max(0, currentTime - turn.startedAt * 1_000);
  }
  return null;
}

function activityGroupLabel(
  status: ThreadTurn["status"],
  duration: number | null,
  finalAnswerStarted: boolean,
): string {
  if (status === "interrupted") {
    return duration === null ? "已停止" : `已停止 ${formatDuration(duration)}`;
  }
  if (status === "failed") {
    return duration === null ? "工作失败" : `工作失败 ${formatDuration(duration)}`;
  }
  const completed = status === "completed" || finalAnswerStarted;
  if (duration === null) {
    return completed ? "Worked" : "Working";
  }
  return `${completed ? "Worked for" : "Working for"} ${formatWorkDuration(duration)}`;
}

function JsonBlock({ value }: { readonly value: unknown }) {
  const serialized = JSON.stringify(redactSensitive(value), null, 2) ?? "null";
  return <pre className={styles.json}>{serialized}</pre>;
}

function TimelineRecord({ label, detail }: { readonly label: string; readonly detail?: string }) {
  return <div className={styles.timeline}><span>{label}</span>{detail ? <p>{detail}</p> : null}</div>;
}

function UnknownItem({
  item,
  onExpandedChange,
}: {
  readonly item: never;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const serialized = JSON.stringify(item, null, 2);
  return (
    <ActivityDisclosure
      label="未知活动"
      onExpandedChange={onExpandedChange}
      status="notice"
    >
      <CopyButton label="复制原始 JSON" value={serialized} />
      <pre className={styles.json}>{serialized}</pre>
    </ActivityDisclosure>
  );
}

function MessageActionButton({
  icon,
  label,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={styles.messageActionButton}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span aria-hidden="true" className={styles.messageActionTooltip}>{label}</span>
    </button>
  );
}

function CopyButton({
  alternateValue,
  iconOnly = false,
  label,
  value,
}: {
  readonly alternateValue?: string;
  readonly iconOnly?: boolean;
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={label}
      className={iconOnly ? styles.messageActionButton : styles.inlineCopyButton}
      onClick={(event) => {
        void copyText(event.shiftKey && alternateValue !== undefined ? alternateValue : value).then((success) => {
          if (success) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          }
        });
      }}
      type="button"
    >
      {iconOnly ? (
        <>
          <CopyIcon copied={copied} />
          <span aria-hidden="true" className={styles.messageActionTooltip}>
            {copied ? "已复制" : "复制"}
          </span>
          <span aria-live="polite" className={styles.visuallyHidden}>
            {copied ? `${label}成功` : ""}
          </span>
        </>
      ) : copied ? "已复制" : "复制"}
    </button>
  );
}

function CopyIcon({ copied }: { readonly copied: boolean }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      {copied ? (
        <path d="m6 12 4 4 8-9" />
      ) : (
        <>
          <rect height="12" rx="2" width="12" x="8" y="8" />
          <path d="M16 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1" />
        </>
      )}
    </svg>
  );
}

function ContinueInNewThreadIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function markdownPlainText(source: string): string {
  return source
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`>#-]/gu, "")
    .trim();
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

type TurnSegment =
  | { readonly type: "item"; readonly item: ThreadItem }
  | { readonly type: "activities"; readonly items: readonly ThreadItem[] };

function conversationRows(
  turns: readonly ThreadTurn[],
  hasActionError: boolean,
  hasOlderTurns: boolean,
): readonly ConversationRow[] {
  const rows: ConversationRow[] = [];
  if (hasActionError) {
    rows.push({ key: "action-error", type: "actionError" });
  }
  if (hasOlderTurns) {
    rows.push({ key: "load-older", type: "loadOlder" });
  }
  if (turns.length === 0) {
    rows.push({ key: "empty", type: "empty" });
    return rows;
  }
  turns.forEach((turn, turnIndex) => {
    const finalAnswerStarted = turn.items.some(isFinalAnswer);
    const segments = groupTurnItems(
      turn.items,
      turn.status === "inProgress" && !finalAnswerStarted,
    );
    segments.forEach((segment, segmentIndex) => {
      const identity = segment.type === "item"
        ? segment.item.id
        : segment.items[0]?.id ?? `activities-${segmentIndex}`;
      rows.push({
        key: `${turn.id}:segment:${identity}`,
        type: "segment",
        firstInTurn: segmentIndex === 0,
        isLatestTurn: turnIndex === turns.length - 1,
        segment,
        turn,
      });
    });
  });
  return rows;
}

function historyQuestionItems(
  turns: readonly ThreadTurn[],
  rows: readonly ConversationRow[],
): readonly HistoryQuestion[] {
  const rowByItemId = new Map<string, number>();
  rows.forEach((row, rowIndex) => {
    if (row.type === "segment" && row.segment.type === "item") {
      rowByItemId.set(row.segment.item.id, rowIndex);
    }
  });

  const questions: HistoryQuestion[] = [];
  for (const turn of turns) {
    turn.items.forEach((item, itemIndex) => {
      if (item.type !== "userMessage") {
        return;
      }
      const rowIndex = rowByItemId.get(item.id);
      if (rowIndex === undefined) {
        return;
      }
      const followingItems = turn.items.slice(itemIndex + 1);
      const nextUserIndex = followingItems.findIndex(
        (followingItem) => followingItem.type === "userMessage",
      );
      const responseItems = (
        nextUserIndex < 0 ? followingItems : followingItems.slice(0, nextUserIndex)
      ).filter(
        (followingItem): followingItem is Extract<ThreadItem, { type: "agentMessage" }> =>
          followingItem.type === "agentMessage",
      );
      const finalAnswer = responseItems.find(
        (responseItem) => responseItem.phase === "final_answer",
      );
      const question = singleLinePreview(
        item.content.map(userInputText).join(" "),
      );
      const answer = finalAnswer === undefined
        ? null
        : singleLinePreview(markdownPlainText(finalAnswer.text));
      questions.push({
        answer: answer === null || answer.length === 0 ? null : answer,
        itemId: item.id,
        question,
        rowIndex,
      });
    });
  }
  return questions;
}

function estimateConversationRow(row: ConversationRow | undefined): number {
  if (row === undefined) {
    return 80;
  }
  switch (row.type) {
    case "actionError":
      return 72;
    case "loadOlder":
      return 54;
    case "empty":
      return 240;
    case "segment": {
      if (row.segment.type === "activities") {
        return row.turn.status === "inProgress" ? 180 : 64;
      }
      switch (row.segment.item.type) {
        case "userMessage":
          return 96;
        case "agentMessage":
          return 180;
        case "plan":
        case "reasoning":
          return 112;
        default:
          return 72;
      }
    }
  }
}

function isWorkActivity(item: ThreadItem): boolean {
  if (item.type === "agentMessage") {
    return item.phase === "commentary";
  }
  return [
    "hookPrompt",
    "plan",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "sleep",
    "imageGeneration",
  ].includes(item.type);
}

function isFinalAnswer(
  item: ThreadItem,
): item is Extract<ThreadItem, { type: "agentMessage" }> {
  return item.type === "agentMessage" && item.phase === "final_answer";
}

function groupTurnItems(
  items: readonly ThreadItem[],
  running: boolean,
): readonly TurnSegment[] {
  const segments: TurnSegment[] = [];
  let activities: ThreadItem[] = [];
  const flush = () => {
    if (activities.length > 0) {
      segments.push({ type: "activities", items: activities });
      activities = [];
    }
  };
  items.forEach((item, itemIndex) => {
    if (isWorkActivity(item)) {
      const hasLaterWorkActivity = items
        .slice(itemIndex + 1)
        .some(isWorkActivity);
      if (isEmptyReasoning(item) && (!running || hasLaterWorkActivity)) {
        return;
      }
      activities.push(item);
      return;
    }
    flush();
    segments.push({ type: "item", item });
  });
  flush();
  return segments;
}

function isEmptyReasoning(item: ThreadItem): item is Extract<ThreadItem, { type: "reasoning" }> {
  return item.type === "reasoning" &&
    !(item.summary?.some((part) => part.trim().length > 0) ?? false) &&
    !(item.content?.some((part) => part.trim().length > 0) ?? false);
}

function singleLinePreview(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function userInputText(input: Extract<ThreadItem, { type: "userMessage" }>["content"][number]): string {
  switch (input.type) {
    case "text": return input.text;
    case "skill": return `$${input.name}`;
    case "mention": return `@${input.name}`;
    case "image": return "[图片]";
    case "localImage": return `[图片 ${pathName(input.path)}]`;
  }
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /token|password|secret|authorization|cookie|private.?key/iu.test(key)
        ? "••••••"
        : redactSensitive(nested),
    ]),
  );
}

function pathName(path: string): string {
  return path.split(/[\\/]/u).at(-1) || "图片";
}

function commandActivityTitle(item: CommandExecutionItem): string {
  if (
    item.commandActions.length === 0 ||
    item.commandActions.some((action) => action.type === "unknown")
  ) {
    return rawCommandTitle(item.status, item.command);
  }
  return item.commandActions
    .map((action) => semanticCommandActionTitle(item.status, action))
    .join(" · ");
}

function semanticCommandActionTitle(
  status: CommandExecutionItem["status"],
  action: CommandExecutionItem["commandActions"][number],
): string {
  switch (action.type) {
    case "read":
      return `${semanticCommandVerb(status, "read")} ${action.name}`;
    case "listFiles":
      return action.path === undefined || action.path === null
        ? rawCommandTitle(status, action.command)
        : `${semanticCommandVerb(status, "listFiles")} ${action.path}`;
    case "search":
      return action.query === undefined || action.query === null ||
        action.path === undefined || action.path === null
        ? rawCommandTitle(status, action.command)
        : `${semanticCommandVerb(status, "search")} “${action.query}” in ${action.path}`;
    case "unknown":
      return rawCommandTitle(status, action.command);
  }
}

function semanticCommandVerb(
  status: CommandExecutionItem["status"],
  type: "read" | "listFiles" | "search",
): string {
  const verbs = {
    read: {
      completed: "Read",
      declined: "Did not read",
      failed: "Failed to read",
      inProgress: "Reading",
    },
    listFiles: {
      completed: "Listed",
      declined: "Did not list",
      failed: "Failed to list",
      inProgress: "Listing",
    },
    search: {
      completed: "Searched",
      declined: "Did not search",
      failed: "Failed to search",
      inProgress: "Searching",
    },
  } as const;
  return verbs[type][status];
}

function rawCommandTitle(
  status: CommandExecutionItem["status"],
  command: string,
): string {
  const verb = {
    completed: "Ran",
    declined: "Did not run",
    failed: "Failed to run",
    inProgress: "Running",
  } as const;
  return `${verb[status]} ${command}`;
}

function reasoningParts(parts: readonly string[] | undefined): readonly string[] {
  return parts
    ?.map((part) => part.trim())
    .filter((part) => part.length > 0) ?? [];
}

function reasoningAccessibleLabel(parts: readonly string[]): string {
  return parts
    .map((part) => markdownPlainText(part).replace(/\s+/gu, " "))
    .filter((part) => part.length > 0)
    .join(" ");
}

function fileChangeVerb(
  status: FileChangeItem["status"],
  kind: FileUpdateChange["kind"]["type"],
  moved: boolean,
): string {
  const type = moved ? "move" : kind;
  const verbs = {
    add: {
      completed: "Added",
      declined: "Did not add",
      failed: "Failed to add",
      inProgress: "Adding",
    },
    delete: {
      completed: "Deleted",
      declined: "Did not delete",
      failed: "Failed to delete",
      inProgress: "Deleting",
    },
    move: {
      completed: "Moved",
      declined: "Did not move",
      failed: "Failed to move",
      inProgress: "Moving",
    },
    update: {
      completed: "Updated",
      declined: "Did not update",
      failed: "Failed to update",
      inProgress: "Updating",
    },
  } as const;
  return verbs[type][status];
}

function fileChangeStats(change: FileUpdateChange): {
  readonly additions: number;
  readonly deletions: number;
  readonly kind: "add" | "delete" | "update";
} | null {
  if (isBinaryDiff(change.diff)) {
    return null;
  }
  if (change.kind.type === "add") {
    return { additions: contentLineCount(change.diff), deletions: 0, kind: "add" };
  }
  if (change.kind.type === "delete") {
    return { additions: 0, deletions: contentLineCount(change.diff), kind: "delete" };
  }
  let additions = 0;
  let deletions = 0;
  for (const line of change.diff.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions, kind: "update" };
}

function isBinaryDiff(diff: string): boolean {
  return diff.includes("\0") || /^(?:GIT binary patch|Binary files .+ differ)$/mu.test(diff);
}

function contentLineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split(/\r?\n/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function formatFileChangeStats(stats: ReturnType<typeof fileChangeStats>): string {
  if (stats === null) {
    return "";
  }
  if (stats.kind === "add") {
    return `+${stats.additions}`;
  }
  if (stats.kind === "delete") {
    return `−${stats.deletions}`;
  }
  return `+${stats.additions} −${stats.deletions}`;
}

function toolActivityLabel(
  label: string,
  status: string,
  durationMs?: number | null,
): string {
  const statusLabel = {
    completed: "完成",
    declined: "已拒绝",
    failed: "失败",
    inProgress: "进行中",
  }[status];
  const parts = [label];
  if (statusLabel !== undefined) {
    parts.push(statusLabel);
  }
  if (typeof durationMs === "number") {
    parts.push(formatDuration(durationMs));
  }
  return parts.join(" · ");
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs} 毫秒`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
}

function panelTransitionDuration(): number {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : PANEL_TRANSITION_MS;
}

function formatWorkDuration(durationMs: number): string {
  return `${Math.max(0, Math.round(durationMs / 1_000))}s`;
}

function formatTurnTime(timestamp: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).format(timestamp);
}
