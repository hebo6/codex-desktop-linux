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
import { recordConversationFirstCommit } from "../diagnostics/conversationLoadDiagnostics";
import { markdownToPlainText, SafeMarkdown } from "./SafeMarkdown";
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
type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type FileUpdateChange = FileChangeItem["changes"][number];
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

const PANEL_TRANSITION_MS = 210;
const COMPOSER_CONTENT_GAP = 24;
const ACTIVITY_BOTTOM_GAP = 20;
const FIRST_TURN_ROW_PADDING = 24;
const MANUAL_SCROLL_SETTLE_MS = 300;

function useCollapsibleContent(initiallyExpanded: boolean) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [targetExpanded, setTargetExpanded] = useState(initiallyExpanded);
  const [contentMounted, setContentMounted] = useState(initiallyExpanded);
  const [contentVisible, setContentVisible] = useState(initiallyExpanded);
  const targetExpandedRef = useRef(initiallyExpanded);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const cancelTransition = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelTransition(), [cancelTransition]);

  const setOpen = useCallback((open: boolean) => {
    cancelTransition();
    targetExpandedRef.current = open;
    setTargetExpanded(open);
    if (open) {
      setContentMounted(true);
      frameRef.current = window.requestAnimationFrame(() => {
        setExpanded(true);
        frameRef.current = null;
        timerRef.current = window.setTimeout(() => {
          setContentVisible(true);
          timerRef.current = null;
        }, panelTransitionDuration());
      });
      return;
    }

    setContentVisible(false);
    frameRef.current = window.requestAnimationFrame(() => {
      setExpanded(false);
      frameRef.current = null;
      timerRef.current = window.setTimeout(() => {
        setContentMounted(false);
        timerRef.current = null;
      }, panelTransitionDuration());
    });
  }, [cancelTransition]);

  return {
    contentMounted,
    contentVisible,
    expanded,
    setOpen,
    targetExpanded,
    targetExpandedRef,
  } as const;
}

interface HistoryQuestion {
  readonly answer: string | null;
  readonly item: UserMessageItem;
  readonly itemId: string;
  readonly question: string;
  readonly rowIndex: number;
  readonly rowKey: string;
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
  const conversationTailRef = useRef<HTMLDivElement>(null);
  const pageFollowingRef = useRef(false);
  const manualScrollRef = useRef(false);
  const manualScrollTimerRef = useRef<number | null>(null);
  const manualForwardScrollLimitRef = useRef<number | null>(null);
  const pointerScrollRef = useRef(false);
  const pendingQuestionPositionRef = useRef<string | null>(null);
  const loadingAnchorRef = useRef(false);
  const observedThreadIdRef = useRef(restoredThread.metadata.id);
  const initialBottomScrollRef = useRef<{
    pending: boolean;
    threadId: string | null;
  }>({
    pending: false,
    threadId: null,
  });
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [preservePageEndSpace, setPreservePageEndSpace] = useState(false);
  const [scrollerHeight, setScrollerHeight] = useState(0);
  const [contentBottomInset, setContentBottomInset] = useState(0);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [loadingAnchorKey, setLoadingAnchorKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    recordConversationFirstCommit(restoredThread.metadata);
  }, [restoredThread.metadata]);
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
  const latestQuestion = historyQuestions.at(-1) ?? null;
  const observedQuestionIdRef = useRef(latestQuestion?.itemId ?? null);
  const activeTurn = restoredThread.turns.findLast(
    ({ status }) => status === "inProgress",
  );
  const activeTurnRef = useRef(activeTurn);
  activeTurnRef.current = activeTurn;
  const previousActiveTurnIdRef = useRef(activeTurn?.id ?? null);
  const questionIndexByRow = useMemo(
    () => new Map(historyQuestions.map((question, index) => [question.rowIndex, index])),
    [historyQuestions],
  );
  const pinnedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (focusedRowKey !== null) {
      keys.add(focusedRowKey);
    }
    if (loadingAnchorKey !== null) {
      keys.add(loadingAnchorKey);
    }
    if (activeTurn !== undefined) {
      const activeRows = rows.filter(
        (row) => row.type === "segment" && row.turn.id === activeTurn.id,
      );
      for (const row of activeRows.slice(-2)) {
        keys.add(row.key);
      }
      const activeQuestion = historyQuestions.findLast((question) => {
        const row = rows[question.rowIndex];
        return row?.type === "segment" && row.turn.id === activeTurn.id;
      });
      if (activeQuestion !== undefined) {
        keys.add(activeQuestion.rowKey);
      }
    }
    return keys;
  }, [activeTurn, focusedRowKey, historyQuestions, loadingAnchorKey, rows]);
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
  const lastRowKey = rows.at(-1)?.key ?? null;
  const lastRowVisible = lastRowKey === null || virtual.rows.some(
    ({ key }) => key === lastRowKey,
  );
  const visibleRowsMeasured = virtual.rows.every(
    ({ key }) => virtual.isMeasured(key),
  );
  const setPageFollowingMode = useCallback((following: boolean) => {
    if (!following) {
      pendingQuestionPositionRef.current = null;
    }
    pageFollowingRef.current = following;
  }, []);

  const questionTop = useCallback(
    (question: HistoryQuestion): number | null => {
      const scroller = scrollerRef.current;
      const rowStart = virtual.offsetForIndex(question.rowIndex);
      if (scroller === null || rowStart === null) {
        return null;
      }
      const questionIndex = historyQuestions.indexOf(question);
      const source = scroller.querySelector<HTMLElement>(
        `[data-question-index="${questionIndex}"] [data-user-message]`,
      );
      if (source !== null) {
        const sourceRect = source.getBoundingClientRect();
        if (sourceRect.height > 0) {
          const scrollerRect = scroller.getBoundingClientRect();
          return scroller.scrollTop + sourceRect.top - scrollerRect.top;
        }
      }
      const listTop = conversationListTop(scroller);
      const row = rows[question.rowIndex];
      return listTop + rowStart + (
        row?.type === "segment" && row.firstInTurn ? FIRST_TURN_ROW_PADDING : 0
      );
    },
    [historyQuestions, rows, virtual],
  );

  const conversationEndScrollTop = useCallback((scroller: HTMLDivElement) => {
    const tail = conversationTailRef.current;
    if (tail === null) {
      return null;
    }
    const maximumTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const targetTop = scroller.scrollTop + tail.getBoundingClientRect().bottom -
      conversationReadableBottom(scroller);
    return Math.min(maximumTop, Math.max(0, targetTop));
  }, []);

  const updateConversationBottom = useCallback((scroller: HTMLDivElement) => {
    const tail = conversationTailRef.current;
    const atBottom = tail === null ||
      tail.getBoundingClientRect().bottom <=
        conversationReadableBottom(scroller) + 0.5;
    setShowJumpToBottom(!atBottom);
    return atBottom;
  }, []);

  const stopPageFollowing = useCallback(() => {
    const scroller = scrollerRef.current;
    if (pageFollowingRef.current) {
      setPageFollowingMode(false);
    }
    if (scroller !== null) {
      updateConversationBottom(scroller);
    }
  }, [setPageFollowingMode, updateConversationBottom]);

  const cancelManualScrollDelay = useCallback(() => {
    if (manualScrollTimerRef.current !== null) {
      window.clearTimeout(manualScrollTimerRef.current);
      manualScrollTimerRef.current = null;
    }
    manualScrollRef.current = false;
    manualForwardScrollLimitRef.current = null;
  }, []);

  const restartManualScrollDelay = useCallback(() => {
    if (manualScrollTimerRef.current !== null) {
      window.clearTimeout(manualScrollTimerRef.current);
    }
    manualScrollRef.current = true;
    manualScrollTimerRef.current = window.setTimeout(() => {
      manualScrollTimerRef.current = null;
      if (pointerScrollRef.current) {
        return;
      }
      manualScrollRef.current = false;
      manualForwardScrollLimitRef.current = null;
      const scroller = scrollerRef.current;
      if (scroller === null) {
        return;
      }
      const atBottom = updateConversationBottom(scroller);
      if (activeTurnRef.current !== undefined && atBottom) {
        setPageFollowingMode(true);
      }
    }, MANUAL_SCROLL_SETTLE_MS);
  }, [
    setPageFollowingMode,
    updateConversationBottom,
  ]);

  const startManualScroll = useCallback(() => {
    stopPageFollowing();
    restartManualScrollDelay();
  }, [restartManualScrollDelay, stopPageFollowing]);

  const captureManualForwardScrollLimit = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      manualForwardScrollLimitRef.current = null;
      return;
    }
    manualForwardScrollLimitRef.current = conversationEndScrollTop(scroller);
  }, [conversationEndScrollTop]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const preventForwardWheelAtEnd = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY <= 0) {
        return;
      }
      const endTop = conversationEndScrollTop(scroller);
      if (endTop !== null && endTop <= scroller.scrollTop + 0.5) {
        event.preventDefault();
      }
    };
    scroller.addEventListener("wheel", preventForwardWheelAtEnd, {
      passive: false,
    });
    return () => scroller.removeEventListener("wheel", preventForwardWheelAtEnd);
  }, [conversationEndScrollTop]);

  const prepareManualScroll = useCallback(() => {
    captureManualForwardScrollLimit();
    startManualScroll();
  }, [captureManualForwardScrollLimit, startManualScroll]);

  const preparePointerScroll = useCallback(() => {
    pointerScrollRef.current = true;
    captureManualForwardScrollLimit();
  }, [captureManualForwardScrollLimit]);

  const finishPointerScroll = useCallback(() => {
    pointerScrollRef.current = false;
    if (!manualScrollRef.current) {
      manualForwardScrollLimitRef.current = null;
      return;
    }
    if (manualScrollTimerRef.current === null) {
      restartManualScrollDelay();
    }
  }, [restartManualScrollDelay]);

  const handleActivityExpandedChange = useCallback((expanded: boolean) => {
    if (expanded) {
      cancelManualScrollDelay();
      stopPageFollowing();
    }
  }, [cancelManualScrollDelay, stopPageFollowing]);

  useEffect(
    () => () => cancelManualScrollDelay(),
    [cancelManualScrollDelay],
  );

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const updateLayout = () => {
      setScrollerHeight((current) =>
        current === scroller.clientHeight ? current : scroller.clientHeight
      );
      const inset = conversationBottomInset(scroller);
      setContentBottomInset((current) =>
        Math.abs(current - inset) < 0.5 ? current : inset
      );
    };
    updateLayout();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateLayout);
    observer.observe(scroller);
    const composer = conversationComposer(scroller);
    if (composer !== null) {
      observer.observe(composer);
    }
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const currentThreadId = restoredThread.metadata.id;
    if (observedThreadIdRef.current !== currentThreadId) {
      observedThreadIdRef.current = currentThreadId;
      observedQuestionIdRef.current = latestQuestion?.itemId ?? null;
      return;
    }
    const latestQuestionId = latestQuestion?.itemId ?? null;
    if (latestQuestion === null) {
      return;
    }
    const scroller = scrollerRef.current;
    if (observedQuestionIdRef.current !== latestQuestionId) {
      observedQuestionIdRef.current = latestQuestionId;
      pendingQuestionPositionRef.current =
        scroller !== null && !updateConversationBottom(scroller)
          ? latestQuestionId
          : null;
      cancelManualScrollDelay();
      setPreservePageEndSpace(true);
      setPageFollowingMode(true);
      setShowJumpToBottom(false);
    }
    if (pendingQuestionPositionRef.current !== latestQuestionId) {
      return;
    }
    const top = questionTop(latestQuestion);
    if (scroller !== null && top !== null) {
      scroller.scrollTop = top;
      if (Math.abs(scroller.scrollTop - top) < 0.5) {
        pendingQuestionPositionRef.current = null;
      }
    }
  }, [
    cancelManualScrollDelay,
    latestQuestion,
    questionTop,
    restoredThread.metadata.id,
    setPageFollowingMode,
    updateConversationBottom,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const pagingTurnId = activeTurn?.id ?? previousActiveTurnIdRef.current;
    if (scroller === null) {
      return;
    }
    const atBottom = updateConversationBottom(scroller);
    if (
      atBottom ||
      pagingTurnId === null ||
      !pageFollowingRef.current
    ) {
      return;
    }
    const followingActivities = activeTurn !== undefined &&
      isFollowingActivities(activeTurn);
    if (followingActivities) {
      const endTop = conversationEndScrollTop(scroller);
      if (endTop === null || endTop <= scroller.scrollTop + 0.5) {
        return;
      }
      const maximumTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      const nextTop = Math.min(
        maximumTop,
        endTop + ACTIVITY_BOTTOM_GAP,
      );
      if (nextTop <= scroller.scrollTop + 0.5) {
        return;
      }
      scroller.scrollTop = nextTop;
      updateConversationBottom(scroller);
      return;
    }
    const pageHeight = Math.max(
      1,
      scroller.clientHeight - conversationBottomInset(scroller),
    );
    const maximumTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const nextTop = Math.min(maximumTop, scroller.scrollTop + pageHeight);
    if (nextTop <= scroller.scrollTop + 0.5) {
      return;
    }
    scroller.scrollTop = nextTop;
    updateConversationBottom(scroller);
  }, [
    activeTurn,
    conversationEndScrollTop,
    itemCount,
    scrollerHeight,
    updateConversationBottom,
    virtual.totalSize,
  ]);

  useEffect(() => {
    const previousActiveTurnId = previousActiveTurnIdRef.current;
    previousActiveTurnIdRef.current = activeTurn?.id ?? null;
    if (previousActiveTurnId !== null && activeTurn === undefined) {
      cancelManualScrollDelay();
      setPageFollowingMode(false);
      const scroller = scrollerRef.current;
      if (scroller !== null) {
        updateConversationBottom(scroller);
      }
    }
  }, [
    activeTurn,
    cancelManualScrollDelay,
    setPageFollowingMode,
    updateConversationBottom,
  ]);

  useLayoutEffect(() => {
    initialBottomScrollRef.current = {
      pending: true,
      threadId: restoredThread.metadata.id,
    };
    observedThreadIdRef.current = restoredThread.metadata.id;
    observedQuestionIdRef.current = latestQuestion?.itemId ?? null;
    pendingQuestionPositionRef.current = null;
    cancelManualScrollDelay();
    pointerScrollRef.current = false;
    setPreservePageEndSpace(activeTurn !== undefined);
    setPageFollowingMode(activeTurn !== undefined);
    setShowJumpToBottom(false);
  }, [cancelManualScrollDelay, restoredThread.metadata.id]);

  useLayoutEffect(() => {
    const scrollState = initialBottomScrollRef.current;
    if (
      !scrollState.pending ||
      scrollState.threadId !== restoredThread.metadata.id
    ) {
      return;
    }
    virtual.scrollToBottom();
    if (typeof ResizeObserver === "undefined") {
      scrollState.pending = false;
      return;
    }
    if (!lastRowVisible || !visibleRowsMeasured) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (
        !scrollState.pending ||
        scrollState.threadId !== restoredThread.metadata.id
      ) {
        return;
      }
      virtual.scrollToBottom();
      scrollState.pending = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    lastRowKey,
    lastRowVisible,
    restoredThread.metadata.id,
    virtual.scrollToBottom,
    virtual.totalSize,
    visibleRowsMeasured,
  ]);

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
    const manualScroll = pointerScrollRef.current || manualScrollRef.current;
    const forwardLimit = manualForwardScrollLimitRef.current;
    if (
      manualScroll &&
      forwardLimit !== null &&
      scroller.scrollTop > forwardLimit + 0.5
    ) {
      scroller.scrollTop = forwardLimit;
    }
    updateConversationBottom(scroller);
    if (manualScroll) {
      startManualScroll();
    }
    if (scroller.scrollTop <= 48) {
      void loadOlder();
    }
  };

  const reservePageEndSpace =
    preservePageEndSpace || activeTurn !== undefined;
  const pageEndSpacerHeight = reservePageEndSpace
    ? Math.max(
        0,
        scrollerHeight - contentBottomInset,
      )
    : 0;

  return (
    <section className={styles.conversation}>
      <div
        aria-label="会话消息"
        className={styles.scroller}
        onKeyDown={(event) => {
          if (isScrollKey(event.key)) {
            prepareManualScroll();
          }
        }}
        onPointerCancel={finishPointerScroll}
        onPointerDown={preparePointerScroll}
        onPointerUp={finishPointerScroll}
        onScroll={handleScroll}
        onTouchMove={prepareManualScroll}
        onWheel={(event) => {
          if (!event.defaultPrevented) {
            prepareManualScroll();
          }
        }}
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
            data-conversation-list
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
                  data-question-index={questionIndexByRow.get(virtualRow.index)}
                  data-turn-id={
                    row.type === "segment" ? row.turn.id : undefined
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
          <div aria-hidden="true" data-conversation-tail ref={conversationTailRef} />
          {pageEndSpacerHeight <= 0 ? null : (
            <div
              aria-hidden="true"
              className={styles.pageEndSpacer}
              style={{ height: pageEndSpacerHeight }}
            />
          )}
        </div>
      </div>
      {historyQuestions.length >= 4 ? (
        <HistoryQuestionNavigation
          onSelect={(question) => {
            cancelManualScrollDelay();
            stopPageFollowing();
            const scroller = scrollerRef.current;
            const top = questionTop(question);
            if (scroller !== null && top !== null) {
              scroller.scrollTop = top;
              updateConversationBottom(scroller);
            }
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
              cancelManualScrollDelay();
              const resumeFollowing = activeTurn !== undefined;
              setPageFollowingMode(resumeFollowing);
              if (!resumeFollowing && preservePageEndSpace) {
                setPreservePageEndSpace(false);
                requestAnimationFrame(() => {
                  const current = scrollerRef.current;
                  if (current !== null) {
                    const top = conversationEndScrollTop(current);
                    if (top !== null) {
                      current.scrollTop = top;
                    }
                    updateConversationBottom(current);
                  }
                });
              } else {
                const top = conversationEndScrollTop(scroller);
                if (top !== null) {
                  scroller.scrollTop = top;
                }
                updateConversationBottom(scroller);
              }
            }
          }}
          type="button"
          aria-label="回到底部"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
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
  readonly onSelect: (question: HistoryQuestion) => void;
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
            onClick={() => onSelect(question)}
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
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
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
  onOpenLink,
  turnStartedAt,
}: {
  readonly item: Extract<ThreadItem, { type: "userMessage" }>;
  readonly onOpenLink?: (link: string) => void;
  readonly turnStartedAt?: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const markdownSource = item.content.map(userInputText).join("\n");
  const startedAt = typeof turnStartedAt === "number"
    ? new Date(turnStartedAt * 1_000)
    : null;
  const timestamp = startedAt === null ? null : formatRelativeTime(startedAt, now);
  return (
    <article
      className={styles.userMessage}
      data-user-message
      tabIndex={0}
      onMouseEnter={() => setNow(Date.now())}
    >
      <UserMessageBody item={item} {...(onOpenLink === undefined ? {} : { onOpenLink })} />
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
        <CopyButton
          alternateValue={markdownToPlainText(markdownSource)}
          iconOnly
          label="复制用户消息"
          value={markdownSource}
        />
      </div>
    </article>
  );
}

function UserMessageBody({
  item,
  onOpenLink,
  variant = "document",
}: {
  readonly item: UserMessageItem;
  readonly onOpenLink?: (link: string) => void;
  readonly variant?: "compact" | "document";
}) {
  return (
    <div className={styles.userMessageBubble}>
      {item.content.map((input, index) => {
        switch (input.type) {
          case "text":
            return (
              <SafeMarkdown
                key={index}
                source={input.text}
                variant={variant}
                {...(onOpenLink === undefined ? {} : { onOpenLink })}
              />
            );
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
  const [now, setNow] = useState(() => Date.now());
  const isFinalAnswer = item.phase === "final_answer";
  const completedAt = typeof turnCompletedAt === "number"
    ? new Date(turnCompletedAt * 1_000)
    : null;
  const timestamp = completedAt === null
    ? null
    : formatRelativeTime(completedAt, now);
  return (
    <article
      className={styles.agentMessage}
      data-final-answer={isFinalAnswer}
      data-latest-turn={isLatestTurn}
      tabIndex={0}
      onMouseEnter={() => setNow(Date.now())}
    >
      <div className={styles.agentText}><SafeMarkdown {...(onOpenLink === undefined ? {} : { onOpenLink })} source={item.text} /></div>
      {isFinalAnswer ? (
        <div className={styles.agentActions}>
          <CopyButton
            alternateValue={markdownToPlainText(item.text)}
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
  const transition = useCollapsibleContent(initiallyExpanded);
  const previousRunningRef = useRef(running);
  const duration = useTurnDuration(turn, running);
  const visibleItems = items;
  const runningCommand = visibleItems.findLast(
    (item): item is Extract<ThreadItem, { type: "commandExecution" }> =>
      item.type === "commandExecution" && item.status === "inProgress",
  );

  useEffect(() => {
    const wasRunning = previousRunningRef.current;
    previousRunningRef.current = running;
    if (wasRunning === running) {
      return;
    }
    transition.setOpen(running);
  }, [running, transition]);

  const toggle = () => {
    const nextExpanded = !transition.targetExpandedRef.current;
    onExpandedChange(nextExpanded);
    transition.setOpen(nextExpanded);
  };

  return (
    <section
      className={styles.activityGroup}
      data-expanded={transition.expanded}
      data-status={turn.status}
    >
      <button aria-expanded={transition.targetExpanded} className={styles.activityGroupHeader} onClick={toggle} type="button">
        <span>{activityGroupLabel(turn.status, duration, finalAnswerStarted)}</span>
        <span aria-hidden="true">›</span>
      </button>
      {transition.contentMounted ? (
        <div className={styles.activityGroupSize}>
          <div className={styles.activityGroupClip}>
            <div className={styles.activityGroupContent} data-visible={transition.contentVisible}>
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
      ) : null}
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
  const transition = useCollapsibleContent(false);
  const [titleTruncated, setTitleTruncated] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const hasDetails = Children.toArray(children).length > 0;
  const expandable = transition.targetExpanded || hasDetails || titleTruncated;

  const measureTitle = useCallback(() => {
    if (transition.expanded || titleRef.current === null) {
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
  }, [transition.expanded]);

  useLayoutEffect(() => {
    measureTitle();
  });

  useEffect(() => {
    if (transition.expanded || titleRef.current === null) {
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
  }, [expandable, measureTitle, transition.expanded]);

  const toggle = () => {
    const nextExpanded = !transition.targetExpandedRef.current;
    onExpandedChange(nextExpanded);
    transition.setOpen(nextExpanded);
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
      data-expanded={transition.expanded}
      data-status={status}
    >
      {expandable ? (
        <button
          {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
          aria-expanded={transition.targetExpanded}
          className={styles.activityRowHeader}
          onClick={toggle}
          type="button"
        >
          {title}
        </button>
      ) : (
        <div className={styles.activityRowHeader}>{title}</div>
      )}
      {hasDetails && transition.contentMounted ? (
        <div className={styles.activityDetailSize}>
          <div className={styles.activityDetailClip}>
            <div className={styles.activityDetail} data-activity-detail data-visible={transition.contentVisible}>
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
    return completed ? "已完成" : "正在运行";
  }
  return `${completed ? "已运行" : "正在运行"} ${formatDuration(duration)}`;
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
  const rowByItemId = new Map<string, { readonly index: number; readonly key: string }>();
  rows.forEach((row, rowIndex) => {
    if (row.type === "segment" && row.segment.type === "item") {
      rowByItemId.set(row.segment.item.id, { index: rowIndex, key: row.key });
    }
  });

  const questions: HistoryQuestion[] = [];
  for (const turn of turns) {
    turn.items.forEach((item, itemIndex) => {
      if (item.type !== "userMessage") {
        return;
      }
      const row = rowByItemId.get(item.id);
      if (row === undefined) {
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
        markdownToPlainText(item.content.map(userInputText).join(" ")),
      );
      const answer = finalAnswer === undefined
        ? null
        : singleLinePreview(markdownToPlainText(finalAnswer.text));
      questions.push({
        answer: answer === null || answer.length === 0 ? null : answer,
        item,
        itemId: item.id,
        question,
        rowIndex: row.index,
        rowKey: row.key,
      });
    });
  }
  return questions;
}

function conversationListTop(scroller: HTMLElement): number {
  const list = scroller.querySelector<HTMLElement>("[data-conversation-list]");
  if (list === null) {
    return 0;
  }
  const listRect = list.getBoundingClientRect();
  if (listRect.height > 0 || listRect.top !== 0) {
    return scroller.scrollTop + listRect.top - scroller.getBoundingClientRect().top;
  }
  return list.offsetTop;
}

function conversationComposer(scroller: HTMLElement): HTMLElement | null {
  return scroller.closest<HTMLElement>("[data-conversation-workspace]")
    ?.querySelector<HTMLElement>("[data-conversation-composer]") ?? null;
}

function conversationReadableBottom(scroller: HTMLElement): number {
  const scrollerBottom = scroller.getBoundingClientRect().top +
    scroller.clientHeight;
  const composer = conversationComposer(scroller);
  return composer === null
    ? scrollerBottom
    : Math.min(
        scrollerBottom,
        composer.getBoundingClientRect().top - COMPOSER_CONTENT_GAP,
      );
}

function conversationBottomInset(scroller: HTMLElement): number {
  const scrollerBottom = scroller.getBoundingClientRect().top +
    scroller.clientHeight;
  return Math.max(0, scrollerBottom - conversationReadableBottom(scroller));
}

function isFollowingActivities(turn: ThreadTurn): boolean {
  if (turn.items.some(isFinalAnswer)) {
    return false;
  }
  const latestResponseItem = turn.items.findLast(
    (item) => item.type !== "userMessage",
  );
  return latestResponseItem !== undefined && isWorkActivity(latestResponseItem);
}

function isScrollKey(key: string): boolean {
  return [
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
    " ",
  ].includes(key);
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
  if (item.commandActions.length === 0) {
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
    .map((part) => markdownToPlainText(part).replace(/\s+/gu, " "))
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

function panelTransitionDuration(): number {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0
    : PANEL_TRANSITION_MS;
}

function formatTurnTime(timestamp: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
  }).format(timestamp);
}

function formatRelativeTime(completedAt: Date, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - completedAt.getTime());
  if (diffMs < 30 * 60 * 1000) {
    const mins = Math.floor(diffMs / (60 * 1000));
    return mins <= 0 ? "刚刚" : `${mins}分钟之前`;
  } else if (diffMs < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    return hours <= 0 ? "1小时之前" : `${hours}小时之前`;
  } else {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${completedAt.getFullYear()}-${pad(completedAt.getMonth() + 1)}-${pad(completedAt.getDate())} ${pad(completedAt.getHours())}:${pad(completedAt.getMinutes())}`;
  }
}
