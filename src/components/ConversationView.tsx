import {
  Children,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type UIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { RestoredThread, ThreadTurn } from "../app/useServerThreads";
import { decodeDataImageUrl } from "../content/dataImage";
import {
  browserBlobUrls,
  useBlobUrl,
  type BlobUrlFactory,
} from "../content/useBlobUrl";
import { recordConversationFirstCommit } from "../diagnostics/conversationLoadDiagnostics";
import { AnsiCommandOutput } from "./AnsiCommandOutput";
import { markdownToPlainText, SafeMarkdown } from "./SafeMarkdown";
import styles from "./ConversationView.module.css";

export interface CommandLocationRequest {
  readonly itemId: string;
  readonly requestId: number;
}

export interface ConversationViewProps {
  readonly restoredThread: RestoredThread;
  readonly blobUrlFactory?: BlobUrlFactory;
  readonly commandLocationRequest?: CommandLocationRequest | null;
  readonly hasOlderTurns?: boolean;
  readonly loadingOlderTurns?: boolean;
  readonly olderTurnsError?: string | null;
  readonly onLoadOlderTurns?: () => Promise<boolean>;
  readonly onForkTurn?: (turnId: string, isLatest: boolean) => void;
  readonly actionError?: string | null;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly onOpenImage?: (url: string, name: string) => void;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly shellCommandDisabled?: boolean;
}

export function ConversationPlaceholder({
  detail = null,
  kind,
  onNewTask,
}: {
  readonly detail?: string | null;
  readonly kind: "blank" | "loading" | "error" | "deleted";
  readonly onNewTask?: () => void;
}) {
  const copy =
    kind === "blank"
      ? ["开始一个新任务", "发送第一条消息时才会创建服务端会话"]
      : kind === "loading"
        ? ["正在恢复会话", "正在读取最近回合、完整项目和服务端状态"]
        : kind === "deleted"
          ? ["会话已被删除", "服务端已删除此会话，不能继续提交输入"]
          : [
              "无法恢复会话",
              detail ?? "可从左侧重新选择会话或重试连接",
            ];
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
const FIRST_TURN_ROW_PADDING = 24;
const BOTTOM_THRESHOLD = 1;
const HISTORY_LOAD_THRESHOLD = 96;
const RUNNING_TURN_RESERVE_RATIO = 2 / 3;

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

interface RunningTurnFloor {
  readonly contentHeight: number;
  readonly floorHeight: number;
  readonly kind: "finalQuestion" | "page" | "question";
  readonly turnId: string;
  readonly viewportHeight: number;
}

interface PendingFinalAnswerQuestionPosition {
  readonly questionItemId: string;
  readonly turnId: string;
}

type ConversationRow =
  | { readonly key: "action-error"; readonly type: "actionError" }
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
  blobUrlFactory = browserBlobUrls,
  commandLocationRequest = null,
  hasOlderTurns = false,
  loadingOlderTurns = false,
  olderTurnsError = null,
  onLoadOlderTurns,
  onForkTurn,
  actionError = null,
  onOpenLink,
  onOpenDiff,
  onOpenImage,
  onRunShellCommand,
  restoredThread,
  shellCommandDisabled = false,
}: ConversationViewProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingQuestionPositionRef = useRef<string | null>(null);
  const pendingFinalAnswerQuestionPositionRef =
    useRef<PendingFinalAnswerQuestionPosition | null>(null);
  const pendingHistoryAnchorRef = useRef<{
    readonly firstTurnId: string | null;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  } | null>(null);
  const historyLoadRef = useRef<Promise<boolean> | null>(null);
  const followBottomRef = useRef(true);
  const scrollbarDragRef = useRef(false);
  const touchPositionRef = useRef<{ x: number; y: number } | null>(null);
  const observedThreadIdRef = useRef(restoredThread.metadata.id);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [scrollerHeight, setScrollerHeight] = useState(0);
  useLayoutEffect(() => {
    recordConversationFirstCommit(restoredThread.metadata);
  }, [restoredThread.metadata]);
  const itemCount = restoredThread.turns.reduce(
    (count, turn) => count + turn.items.length,
    0,
  );
  const rows = useMemo(
    () => conversationRows(restoredThread.turns, actionError !== null),
    [actionError, restoredThread.turns],
  );
  const historyQuestions = useMemo(
    () => historyQuestionItems(restoredThread.turns, rows),
    [restoredThread.turns, rows],
  );
  const questionIndexByRow = useMemo(
    () => new Map(historyQuestions.map((question, index) => [question.rowIndex, index])),
    [historyQuestions],
  );
  const runningTurn =
    restoredThread.turns.findLast(({ status }) => status === "inProgress") ??
    null;
  const runningTurnId = runningTurn?.id ?? null;
  const runningFinalAnswer =
    runningTurn?.items.find(isFinalAnswer) ?? null;
  const runningQuestion =
    runningTurnId === null
      ? null
      : historyQuestions.findLast((question) => {
        const row = rows[question.rowIndex];
        return row?.type === "segment" && row.turn.id === runningTurnId;
      }) ?? null;
  const observedRunningFinalAnswerRef = useRef({
    itemId: runningFinalAnswer?.id ?? null,
    threadId: restoredThread.metadata.id,
  });
  const [runningTurnFloor, setRunningTurnFloor] =
    useState<RunningTurnFloor | null>(null);
  const runningTurnFloorVisible =
    runningTurnId !== null && runningTurnFloor?.turnId === runningTurnId;
  const previousQuestionCountRef = useRef(historyQuestions.length);

  const questionTop = useCallback(
    (question: HistoryQuestion): number | null => {
      const scroller = scrollerRef.current;
      if (scroller === null) {
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
      const rowElement = scroller.querySelector<HTMLElement>(
        `[data-row-index="${question.rowIndex}"]`,
      );
      if (rowElement === null) {
        return null;
      }
      const rowPadding = rowElement.dataset.firstInTurn === "true"
        ? FIRST_TURN_ROW_PADDING
        : 0;
      return conversationListTop(scroller) + rowElement.offsetTop + rowPadding;
    },
    [historyQuestions],
  );

  const questionTargetTop = useCallback(
    (
      scroller: HTMLDivElement,
      question: HistoryQuestion,
    ): number | null => {
      const top = questionTop(question);
      return top === null
        ? null
        : Math.max(0, top - initialQuestionTop(scroller));
    },
    [questionTop],
  );

  const updateBottomState = useCallback(
    (scroller: HTMLDivElement, allowExitFollowing = true) => {
      const atBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <=
          BOTTOM_THRESHOLD;
      if (atBottom) {
        followBottomRef.current = true;
        setShowJumpToBottom(false);
      } else if (allowExitFollowing || !followBottomRef.current) {
        followBottomRef.current = false;
        setShowJumpToBottom(true);
      }
      return atBottom;
    },
    [],
  );

  const stopFollowingForUserScroll = useCallback(
    (scroller: HTMLDivElement, direction: -1 | 1) => {
      const maximumScrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      const canScroll = direction < 0
        ? scroller.scrollTop > BOTTOM_THRESHOLD
        : scroller.scrollTop < maximumScrollTop - BOTTOM_THRESHOLD;
      if (!canScroll) {
        return;
      }
      followBottomRef.current = false;
      setShowJumpToBottom(true);
    },
    [],
  );

  const scrollToBottom = useCallback((scroller: HTMLDivElement) => {
    scroller.scrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    followBottomRef.current = true;
    setShowJumpToBottom(false);
  }, []);

  const positionPendingFinalAnswerQuestion = useCallback(
    (scroller: HTMLDivElement) => {
      const pending = pendingFinalAnswerQuestionPositionRef.current;
      if (pending === null) {
        return false;
      }
      if (
        !runningTurnFloorVisible ||
        runningTurnFloor?.kind !== "finalQuestion" ||
        runningTurnFloor.turnId !== pending.turnId
      ) {
        return true;
      }
      const question = historyQuestions.find(
        ({ itemId }) => itemId === pending.questionItemId,
      );
      if (question === undefined) {
        pendingFinalAnswerQuestionPositionRef.current = null;
        return false;
      }
      const content = contentRef.current;
      if (content === null) {
        return true;
      }
      const targetTop = questionTargetTop(scroller, question);
      if (targetTop === null) {
        return true;
      }
      const contentRect = content.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const floorHeight = targetTop + scroller.clientHeight;
      if (
        Math.abs(runningTurnFloor.floorHeight - floorHeight) >
          BOTTOM_THRESHOLD ||
        Math.abs(
          runningTurnFloor.viewportHeight - scroller.clientHeight,
        ) > BOTTOM_THRESHOLD ||
        Math.abs(
          runningTurnFloor.contentHeight -
            contentRect.height,
        ) > BOTTOM_THRESHOLD
      ) {
        setRunningTurnFloor({
          ...runningTurnFloor,
          contentHeight: contentRect.height,
          floorHeight,
          viewportHeight: scroller.clientHeight,
        });
        return true;
      }
      scroller.scrollTop = targetTop;
      followBottomRef.current = true;
      setShowJumpToBottom(false);
      if (!turnHasMountedActivityContent(scroller, pending.turnId)) {
        pendingFinalAnswerQuestionPositionRef.current = null;
        if (contentRect.bottom >= scrollerRect.bottom - BOTTOM_THRESHOLD) {
          const naturalBottom =
            scroller.scrollTop + contentRect.bottom - scrollerRect.top;
          setRunningTurnFloor({
            contentHeight: contentRect.height,
            floorHeight:
              naturalBottom +
              scroller.clientHeight * RUNNING_TURN_RESERVE_RATIO,
            kind: "page",
            turnId: pending.turnId,
            viewportHeight: scroller.clientHeight,
          });
        }
      }
      return true;
    },
    [
      historyQuestions,
      questionTargetTop,
      runningTurnFloor,
      runningTurnFloorVisible,
    ],
  );

  const requestOlderTurns = useCallback(() => {
    const scroller = scrollerRef.current;
    if (
      scroller === null ||
      onLoadOlderTurns === undefined ||
      !hasOlderTurns ||
      loadingOlderTurns ||
      historyLoadRef.current !== null
    ) {
      return;
    }
    pendingHistoryAnchorRef.current = {
      firstTurnId: restoredThread.turns[0]?.id ?? null,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
    };
    followBottomRef.current = false;
    setShowJumpToBottom(true);
    const request = onLoadOlderTurns();
    historyLoadRef.current = request;
    void request.then(
      (loaded) => {
        if (!loaded) {
          pendingHistoryAnchorRef.current = null;
        }
      },
      () => {
        pendingHistoryAnchorRef.current = null;
      },
    ).finally(() => {
      if (historyLoadRef.current === request) {
        historyLoadRef.current = null;
      }
    });
  }, [
    hasOlderTurns,
    loadingOlderTurns,
    onLoadOlderTurns,
    restoredThread.turns,
  ]);

  const followContent = useCallback(
    (scroller: HTMLDivElement) => {
      if (positionPendingFinalAnswerQuestion(scroller)) {
        return;
      }
      if (pendingQuestionPositionRef.current !== null) {
        return;
      }
      if (runningTurnId === null && followBottomRef.current) {
        scrollToBottom(scroller);
        return;
      }
      const content = contentRef.current;
      if (content === null || runningTurnId === null) {
        return;
      }
      const contentRect = content.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const naturalBottom =
        scroller.scrollTop + contentRect.bottom - scrollerRect.top;
      const activeFloor = runningTurnFloorVisible
        ? runningTurnFloor
        : null;
      if (
        activeFloor !== null &&
        Math.abs(activeFloor.viewportHeight - scroller.clientHeight) >
          BOTTOM_THRESHOLD
      ) {
        const viewportDelta =
          scroller.clientHeight - activeFloor.viewportHeight;
        const floorHeight = Math.max(
          0,
          activeFloor.floorHeight + viewportDelta * (
            activeFloor.kind === "page"
              ? RUNNING_TURN_RESERVE_RATIO
              : 1
          ),
        );
        setRunningTurnFloor({
          ...activeFloor,
          floorHeight,
          viewportHeight: scroller.clientHeight,
        });
        return;
      }
      if (!followBottomRef.current) {
        return;
      }
      const contentBottom = contentRect.bottom;
      const viewportBottom = scrollerRect.bottom;
      if (contentBottom < viewportBottom - BOTTOM_THRESHOLD) {
        return;
      }
      const floorHeight =
        naturalBottom +
        scroller.clientHeight * RUNNING_TURN_RESERVE_RATIO;
      if (
        activeFloor !== null &&
        activeFloor.kind !== "page" &&
        Math.abs(activeFloor.contentHeight - contentRect.height) <=
          BOTTOM_THRESHOLD
      ) {
        return;
      }
      if (
        activeFloor === null ||
        activeFloor.kind !== "page" ||
        Math.abs(activeFloor.contentHeight - contentRect.height) >
          BOTTOM_THRESHOLD ||
        Math.abs(activeFloor.floorHeight - floorHeight) > BOTTOM_THRESHOLD
      ) {
        setRunningTurnFloor({
          contentHeight: contentRect.height,
          floorHeight,
          kind: "page",
          turnId: runningTurnId,
          viewportHeight: scroller.clientHeight,
        });
        return;
      }
      scrollToBottom(scroller);
    },
    [
      runningTurnId,
      runningTurnFloor,
      runningTurnFloorVisible,
      positionPendingFinalAnswerQuestion,
      scrollToBottom,
    ],
  );

  useLayoutEffect(() => {
    const currentThreadId = restoredThread.metadata.id;
    if (observedThreadIdRef.current !== currentThreadId) {
      observedThreadIdRef.current = currentThreadId;
      previousQuestionCountRef.current = historyQuestions.length;
      return;
    }
    const previousQuestionCount = previousQuestionCountRef.current;
    previousQuestionCountRef.current = historyQuestions.length;
    if (pendingHistoryAnchorRef.current !== null) {
      return;
    }
    if (historyQuestions.length <= previousQuestionCount) {
      return;
    }
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    const latestQuestion = historyQuestions.at(-1);
    const latestQuestionRow = latestQuestion === undefined
      ? undefined
      : rows[latestQuestion.rowIndex];
    if (
      scroller === null ||
      content === null ||
      latestQuestion === undefined ||
      runningTurnId === null ||
      latestQuestionRow?.type !== "segment" ||
      latestQuestionRow.turn.id !== runningTurnId
    ) {
      if (scroller !== null) {
        scrollToBottom(scroller);
      }
      return;
    }
    const contentRect = content.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const naturalBottom =
      scroller.scrollTop + contentRect.bottom - scrollerRect.top;
    pendingQuestionPositionRef.current = latestQuestion.itemId;
    followBottomRef.current = true;
    setShowJumpToBottom(false);
    setRunningTurnFloor({
      contentHeight: contentRect.height,
      floorHeight: naturalBottom + scroller.clientHeight,
      kind: "question",
      turnId: runningTurnId,
      viewportHeight: scroller.clientHeight,
    });
  }, [
    historyQuestions,
    restoredThread.metadata.id,
    rows,
    runningTurnId,
    scrollToBottom,
  ]);

  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchorRef.current;
    const scroller = scrollerRef.current;
    if (
      anchor === null ||
      scroller === null ||
      (restoredThread.turns[0]?.id ?? null) === anchor.firstTurnId
    ) {
      return;
    }
    scroller.scrollTop =
      anchor.scrollTop + scroller.scrollHeight - anchor.scrollHeight;
    pendingHistoryAnchorRef.current = null;
    updateBottomState(scroller);
  }, [restoredThread.turns, updateBottomState]);

  useLayoutEffect(() => {
    const pendingQuestionId = pendingQuestionPositionRef.current;
    const scroller = scrollerRef.current;
    if (
      pendingQuestionId === null ||
      scroller === null ||
      !runningTurnFloorVisible ||
      runningTurnFloor?.kind !== "question"
    ) {
      return;
    }
    const question = historyQuestions.find(
      ({ itemId }) => itemId === pendingQuestionId,
    );
    if (question === undefined) {
      pendingQuestionPositionRef.current = null;
      return;
    }
    const targetTop = questionTargetTop(scroller, question);
    if (targetTop === null) {
      return;
    }
    const floorHeight = targetTop + scroller.clientHeight;
    if (
      Math.abs(runningTurnFloor.floorHeight - floorHeight) > BOTTOM_THRESHOLD ||
      Math.abs(runningTurnFloor.viewportHeight - scroller.clientHeight) >
        BOTTOM_THRESHOLD
    ) {
      setRunningTurnFloor({
        ...runningTurnFloor,
        floorHeight,
        viewportHeight: scroller.clientHeight,
      });
      return;
    }
    scroller.scrollTop = targetTop;
    pendingQuestionPositionRef.current = null;
  }, [
    historyQuestions,
    questionTargetTop,
    runningTurnFloor,
    runningTurnFloorVisible,
    scrollerHeight,
  ]);

  useLayoutEffect(() => {
    const current = {
      itemId: runningFinalAnswer?.id ?? null,
      threadId: restoredThread.metadata.id,
    };
    const observed = observedRunningFinalAnswerRef.current;
    observedRunningFinalAnswerRef.current = current;
    if (
      observed.threadId !== current.threadId ||
      current.itemId === null ||
      observed.itemId === current.itemId ||
      runningTurnId === null ||
      runningQuestion === null
    ) {
      return;
    }
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    const finalAnswer = scroller === null
      ? null
      : conversationItemElement(scroller, current.itemId);
    if (
      scroller === null ||
      content === null ||
      finalAnswer === null ||
      (
        !followBottomRef.current &&
        !turnActivityHeaderIsAboveViewport(scroller, runningTurnId)
      )
    ) {
      return;
    }
    const targetTop = questionTargetTop(scroller, runningQuestion);
    if (targetTop === null) {
      return;
    }
    pendingQuestionPositionRef.current = null;
    pendingFinalAnswerQuestionPositionRef.current = {
      questionItemId: runningQuestion.itemId,
      turnId: runningTurnId,
    };
    followBottomRef.current = true;
    setShowJumpToBottom(false);
    setRunningTurnFloor({
      contentHeight: content.getBoundingClientRect().height,
      floorHeight: targetTop + scroller.clientHeight,
      kind: "finalQuestion",
      turnId: runningTurnId,
      viewportHeight: scroller.clientHeight,
    });
  }, [
    restoredThread.metadata.id,
    runningFinalAnswer?.id,
    runningQuestion,
    runningTurnId,
    questionTargetTop,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const updateLayout = () => {
      setScrollerHeight((current) =>
        current === scroller.clientHeight ? current : scroller.clientHeight
      );
    };
    updateLayout();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateLayout);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const scroller = scrollerRef.current;
    if (
      content === null ||
      scroller === null ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const observer = new ResizeObserver(() => {
      followContent(scroller);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [followContent]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    followContent(scroller);
  }, [
    followContent,
    itemCount,
    restoredThread.turns,
    runningTurnFloorVisible,
    scrollerHeight,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    pendingQuestionPositionRef.current = null;
    pendingFinalAnswerQuestionPositionRef.current = null;
    setRunningTurnFloor(null);
    followBottomRef.current = true;
    setShowJumpToBottom(false);
    if (scroller === null) {
      return;
    }
    scrollToBottom(scroller);
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom(scroller);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [restoredThread.metadata.id, scrollToBottom]);

  useEffect(() => {
    const finishScrollbarDrag = () => {
      scrollbarDragRef.current = false;
    };
    window.addEventListener("pointerup", finishScrollbarDrag);
    window.addEventListener("pointercancel", finishScrollbarDrag);
    return () => {
      window.removeEventListener("pointerup", finishScrollbarDrag);
      window.removeEventListener("pointercancel", finishScrollbarDrag);
    };
  }, []);

  useEffect(() => {
    if (commandLocationRequest === null) {
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    let timer: number | null = null;
    const locate = () => {
      const command = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-command-item-id]"),
      ).find(
        (element) =>
          element.dataset.commandItemId === commandLocationRequest.itemId,
      );
      if (command === undefined) {
        return false;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const commandRect = command.getBoundingClientRect();
      scroller.scrollTop = Math.max(
        0,
        scroller.scrollTop +
          commandRect.top -
          scrollerRect.top -
          Math.max(24, (scroller.clientHeight - commandRect.height) / 2),
      );
      updateBottomState(scroller);
      command.querySelector<HTMLElement>("button, [tabindex]")?.focus({
        preventScroll: true,
      });
      return true;
    };
    const frame = window.requestAnimationFrame(() => {
      if (!locate()) {
        timer = window.setTimeout(locate, PANEL_TRANSITION_MS + 40);
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [commandLocationRequest, updateBottomState]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const atBottom = updateBottomState(scroller, scrollbarDragRef.current);
    if (
      !atBottom &&
      scroller.scrollTop <= HISTORY_LOAD_THRESHOLD &&
      olderTurnsError === null
    ) {
      requestOlderTurns();
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) {
      return;
    }
    stopFollowingForUserScroll(
      event.currentTarget,
      event.deltaY < 0 ? -1 : 1,
    );
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.matches("input, textarea, select"))
    ) {
      return;
    }
    const direction =
      event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
        ? -1
        : event.key === "ArrowDown" ||
            event.key === "PageDown" ||
            event.key === "End" ||
            (event.key === " " && event.target === event.currentTarget)
          ? 1
          : null;
    if (direction !== null) {
      stopFollowingForUserScroll(event.currentTarget, direction);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "mouse" ||
      event.target !== event.currentTarget
    ) {
      return;
    }
    const scroller = event.currentTarget;
    const rect = scroller.getBoundingClientRect();
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
    scrollbarDragRef.current =
      scrollbarWidth > 0 &&
      event.clientX >= rect.right - scrollbarWidth;
  };

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches.item(0);
    touchPositionRef.current = touch === null
      ? null
      : { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const previous = touchPositionRef.current;
    const touch = event.touches.item(0);
    if (previous === null || touch === null) {
      return;
    }
    const deltaX = previous.x - touch.clientX;
    const deltaY = previous.y - touch.clientY;
    touchPositionRef.current = { x: touch.clientX, y: touch.clientY };
    if (Math.abs(deltaY) > Math.abs(deltaX) && deltaY !== 0) {
      stopFollowingForUserScroll(
        event.currentTarget,
        deltaY < 0 ? -1 : 1,
      );
    }
  };

  const handleTouchEnd = () => {
    touchPositionRef.current = null;
  };

  return (
    <section className={styles.conversation}>
      <div
        aria-label="会话消息"
        className={styles.scroller}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onScroll={handleScroll}
        onTouchCancel={handleTouchEnd}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        onWheel={handleWheel}
        ref={scrollerRef}
      >
        <div
          className={`${styles.messageColumn}${
            historyQuestions.length >= 4
              ? ` ${styles.messageColumnWithQuestionNavigation}`
              : ""
          }`}
          data-running-turn-floor={runningTurnFloorVisible}
          style={
            runningTurnFloorVisible && runningTurnFloor !== null
              ? { minHeight: runningTurnFloor.floorHeight }
              : undefined
          }
        >
          {hasOlderTurns || loadingOlderTurns || olderTurnsError !== null ? (
            <div className={styles.historyLoader}>
              {loadingOlderTurns ? (
                <span aria-live="polite" role="status">
                  正在加载更早内容
                </span>
              ) : (
                <button onClick={requestOlderTurns} type="button">
                  {olderTurnsError === null
                    ? "加载更早内容"
                    : "重试加载更早内容"}
                </button>
              )}
              {olderTurnsError === null ? null : (
                <span
                  className={styles.historyLoadError}
                  role="alert"
                >
                  {olderTurnsError}
                </span>
              )}
            </div>
          ) : null}
          <div
            aria-label="会话内容列表"
            className={styles.conversationList}
            data-conversation-list
            ref={contentRef}
            role="list"
          >
            {rows.map((row, rowIndex) => (
              <div
                className={styles.conversationRow}
                data-first-in-turn={
                  row.type === "segment" && row.firstInTurn
                }
                data-row-index={rowIndex}
                data-row-key={row.key}
                data-row-type={row.type}
                data-status={
                  row.type === "segment" ? row.turn.status : undefined
                }
                data-question-index={questionIndexByRow.get(rowIndex)}
                data-turn-id={
                  row.type === "segment" ? row.turn.id : undefined
                }
                key={row.key}
                role="listitem"
              >
                <ConversationRowView
                  actionError={actionError}
                  blobUrlFactory={blobUrlFactory}
                  commandLocationRequest={commandLocationRequest}
                  {...(onForkTurn === undefined ? {} : { onForkTurn })}
                  {...(onOpenLink === undefined ? {} : { onOpenLink })}
                  {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
                  {...(onOpenImage === undefined ? {} : { onOpenImage })}
                  {...(onRunShellCommand === undefined
                    ? {}
                    : { onRunShellCommand })}
                  row={row}
                  shellCommandDisabled={shellCommandDisabled}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
      {historyQuestions.length >= 4 ? (
        <HistoryQuestionNavigation
          onSelect={(question) => {
            const scroller = scrollerRef.current;
            const top = questionTop(question);
            if (scroller !== null && top !== null) {
              scroller.scrollTop = top;
              updateBottomState(scroller);
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
              scrollToBottom(scroller);
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
  blobUrlFactory,
  commandLocationRequest,
  onForkTurn,
  onOpenLink,
  onOpenDiff,
  onOpenImage,
  onRunShellCommand,
  row,
  shellCommandDisabled,
}: {
  readonly actionError: string | null;
  readonly blobUrlFactory: BlobUrlFactory;
  readonly commandLocationRequest: CommandLocationRequest | null;
  readonly onForkTurn?: (turnId: string, isLatest: boolean) => void;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly onOpenImage?: (url: string, name: string) => void;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly row: ConversationRow;
  readonly shellCommandDisabled: boolean;
}) {
  if (row.type === "actionError") {
    return <div className={styles.actionError} role="alert">{actionError}</div>;
  }
  if (row.type === "empty") {
    return <div className={styles.empty}>这个会话还没有回合</div>;
  }
  return row.segment.type === "item" ? (
    <ItemView
      blobUrlFactory={blobUrlFactory}
      item={row.segment.item}
      isLatestTurn={row.isLatestTurn}
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
      {...(onOpenImage === undefined ? {} : { onOpenImage })}
      {...(
        onRunShellCommand === undefined || row.turn.status !== "completed"
          ? {}
          : { onRunShellCommand }
      )}
      shellCommandDisabled={shellCommandDisabled}
    />
  ) : (
    <ActivityGroup
      commandLocationRequest={commandLocationRequest}
      items={row.segment.items}
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
  blobUrlFactory = browserBlobUrls,
  item,
  isLatestTurn = false,
  onFork,
  onOpenLink,
  onOpenDiff,
  onOpenImage,
  onRunShellCommand,
  shellCommandDisabled = false,
  turnCompletedAt,
  turnStartedAt,
}: {
  readonly blobUrlFactory?: BlobUrlFactory;
  readonly item: ThreadItem;
  readonly isLatestTurn?: boolean;
  readonly onFork?: () => void;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly onOpenImage?: (url: string, name: string) => void;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly shellCommandDisabled?: boolean;
  readonly turnCompletedAt?: number | null;
  readonly turnStartedAt?: number | null;
}) {
  switch (item.type) {
    case "userMessage":
      return (
        <UserMessage
          blobUrlFactory={blobUrlFactory}
          item={item}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(onOpenImage === undefined ? {} : { onOpenImage })}
          {...(turnStartedAt === undefined ? {} : { turnStartedAt })}
        />
      );
    case "hookPrompt":
      return (
        <ActivityDisclosure
          label="Hook 提示"
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
          {...(onRunShellCommand === undefined ? {} : { onRunShellCommand })}
          shellCommandDisabled={shellCommandDisabled}
        />
      );
    case "plan":
      return (
        <ActivityDisclosure
          label="计划"
          status="notice"
        >
          <pre>{item.text}</pre>
        </ActivityDisclosure>
      );
    case "reasoning":
      return (
        <ReasoningActivity
          item={item}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
        />
      );
    case "commandExecution":
      return (
        <CommandActivity
          item={item}
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
      return <UnknownItem item={item} />;
  }
}

function UserMessage({
  blobUrlFactory,
  item,
  onOpenLink,
  onOpenImage,
  turnStartedAt,
}: {
  readonly blobUrlFactory: BlobUrlFactory;
  readonly item: Extract<ThreadItem, { type: "userMessage" }>;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenImage?: (url: string, name: string) => void;
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
      <UserMessageBody
        blobUrlFactory={blobUrlFactory}
        item={item}
        {...(onOpenLink === undefined ? {} : { onOpenLink })}
        {...(onOpenImage === undefined ? {} : { onOpenImage })}
      />
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
  blobUrlFactory,
  item,
  onOpenLink,
  onOpenImage,
  variant = "document",
}: {
  readonly blobUrlFactory: BlobUrlFactory;
  readonly item: UserMessageItem;
  readonly onOpenLink?: (link: string) => void;
  readonly onOpenImage?: (url: string, name: string) => void;
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
            return (
              <UserImageAttachment
                blobUrlFactory={blobUrlFactory}
                key={index}
                url={input.url}
                {...(onOpenImage === undefined ? {} : { onOpen: onOpenImage })}
              />
            );
          case "localImage":
            return <span className={styles.attachment} key={index}>{pathName(input.path)}</span>;
          case "audio":
            return <span className={styles.attachment} key={index}>音频附件</span>;
          case "localAudio":
            return <span className={styles.attachment} key={index}>{pathName(input.path)}</span>;
        }
      })}
    </div>
  );
}

function UserImageAttachment({
  blobUrlFactory,
  onOpen,
  url,
}: {
  readonly blobUrlFactory: BlobUrlFactory;
  readonly onOpen?: (url: string, name: string) => void;
  readonly url: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const image = useMemo(
    () => decodeDataImageUrl(url),
    [attempt, url],
  );
  const imageUrl = useBlobUrl(image?.blob ?? null, blobUrlFactory);
  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (image === null) {
    return <span className={styles.attachment}>图片附件不可预览</span>;
  }
  if (imageUrl === null) {
    return <span aria-label={image.name} className={styles.imageAttachment} />;
  }
  if (failed) {
    return (
      <span className={styles.imageAttachmentError}>
        <span>{image.name}加载失败</span>
        <button
          onClick={() => {
            setAttempt((value) => value + 1);
            setFailed(false);
          }}
          type="button"
        >
          重试
        </button>
      </span>
    );
  }
  const thumbnail = (
    <img
      alt={image.name}
      decoding="async"
      key={attempt}
      onError={() => setFailed(true)}
      src={imageUrl}
    />
  );
  return onOpen === undefined ? (
    <span className={styles.imageAttachment}>{thumbnail}</span>
  ) : (
    <button
      aria-label={`预览${image.name}`}
      className={styles.imageAttachment}
      onClick={() => onOpen(url, image.name)}
      type="button"
    >
      {thumbnail}
    </button>
  );
}

function AgentMessage({
  isLatestTurn,
  item,
  onFork,
  onOpenLink,
  onRunShellCommand,
  shellCommandDisabled,
  turnCompletedAt,
}: {
  readonly isLatestTurn: boolean;
  readonly item: Extract<ThreadItem, { type: "agentMessage" }>;
  readonly onFork?: () => void;
  readonly onOpenLink?: (link: string) => void;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly shellCommandDisabled: boolean;
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
      data-item-id={item.id}
      data-latest-turn={isLatestTurn}
      tabIndex={0}
      onMouseEnter={() => setNow(Date.now())}
    >
      <div className={styles.agentText}>
        <SafeMarkdown
          shellCommandDisabled={shellCommandDisabled}
          source={item.text}
          {...(onOpenLink === undefined ? {} : { onOpenLink })}
          {...(
            !isFinalAnswer || onRunShellCommand === undefined
              ? {}
              : { onRunShellCommand }
          )}
        />
      </div>
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
  commandLocationRequest,
  items,
  onOpenDiff,
  onOpenLink,
  turn,
}: {
  readonly commandLocationRequest: CommandLocationRequest | null;
  readonly items: readonly ThreadItem[];
  readonly onOpenDiff?: (path: string, diff: string) => void;
  readonly onOpenLink?: (link: string) => void;
  readonly turn: ThreadTurn;
}) {
  const finalAnswerStarted = turn.items.some(isFinalAnswer);
  const runningCommandCount = items.filter(
    (item) =>
      item.type === "commandExecution" && item.status === "inProgress",
  ).length;
  const turnWorkRunning =
    turn.status === "inProgress" && !finalAnswerStarted;
  const automaticallyExpanded = turnWorkRunning;
  const initiallyExpanded = automaticallyExpanded;
  const transition = useCollapsibleContent(initiallyExpanded);
  const previousAutomaticallyExpandedRef = useRef(automaticallyExpanded);
  const duration = useTurnDuration(turn, turnWorkRunning);
  const visibleItems = items;
  const setGroupOpen = transition.setOpen;
  const commandLocationRequestId = commandLocationRequest?.requestId;
  const runningCommand = visibleItems.findLast(
    (item): item is Extract<ThreadItem, { type: "commandExecution" }> =>
      item.type === "commandExecution" && item.status === "inProgress",
  );

  useEffect(() => {
    const wasAutomaticallyExpanded =
      previousAutomaticallyExpandedRef.current;
    previousAutomaticallyExpandedRef.current = automaticallyExpanded;
    if (wasAutomaticallyExpanded === automaticallyExpanded) {
      return;
    }
    setGroupOpen(automaticallyExpanded);
  }, [automaticallyExpanded, setGroupOpen]);

  useEffect(() => {
    if (
      commandLocationRequest !== null &&
      visibleItems.some(({ id }) => id === commandLocationRequest.itemId)
    ) {
      setGroupOpen(true);
    }
  }, [commandLocationRequestId, setGroupOpen]);

  const toggle = () => {
    const nextExpanded = !transition.targetExpandedRef.current;
    transition.setOpen(nextExpanded);
  };

  return (
    <section
      className={styles.activityGroup}
      data-activity-group
      data-content-mounted={transition.contentMounted}
      data-expanded={transition.expanded}
      data-status={runningCommandCount > 0 ? "inProgress" : turn.status}
    >
      <button
        aria-expanded={transition.targetExpanded}
        className={styles.activityGroupHeader}
        data-activity-group-header
        onClick={toggle}
        type="button"
      >
        <span>{activityGroupLabel(
          turn.status,
          duration,
          finalAnswerStarted,
          runningCommandCount,
        )}</span>
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
}: {
  readonly item: CommandExecutionItem;
}) {
  const output = item.aggregatedOutput?.trim().length === 0
    ? null
    : item.aggregatedOutput ?? null;
  return (
    <ActivityDisclosure
      dataItemId={item.id}
      label={commandActivityTitle(item)}
      status={item.status}
    >
      {output === null ? null : <AnsiCommandOutput output={output} />}
    </ActivityDisclosure>
  );
}

function ReasoningActivity({
  item,
  onOpenLink,
}: {
  readonly item: ReasoningItem;
  readonly onOpenLink?: (link: string) => void;
}) {
  const summary = reasoningParts(item.summary);
  const content = reasoningParts(item.content);
  return (
    <ActivityDisclosure
      ariaLabel={summary.length === 0 ? "Thinking" : reasoningAccessibleLabel(summary)}
      label={summary.length === 0 ? "Thinking" : <ReasoningTitle parts={summary} />}
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
  dataItemId,
  label,
  status,
}: {
  readonly ariaLabel?: string;
  readonly children?: ReactNode;
  readonly dataItemId?: string;
  readonly label: ReactNode;
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
      {...(dataItemId === undefined
        ? {}
        : { "data-command-item-id": dataItemId })}
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
  runningCommandCount: number,
): string {
  if (runningCommandCount > 0) {
    return `${runningCommandCount} 个命令正在运行`;
  }
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

function UnknownItem({ item }: {
  readonly item: never;
}) {
  const serialized = JSON.stringify(item, null, 2);
  return (
    <ActivityDisclosure
      label="未知活动"
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
): readonly ConversationRow[] {
  const rows: ConversationRow[] = [];
  if (hasActionError) {
    rows.push({ key: "action-error", type: "actionError" });
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

function conversationItemElement(
  scroller: HTMLElement,
  itemId: string,
): HTMLElement | null {
  return Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-item-id]"),
  ).find((element) => element.dataset.itemId === itemId) ?? null;
}

function turnActivityGroups(
  scroller: HTMLElement,
  turnId: string,
): readonly HTMLElement[] {
  return Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-turn-id]"),
  ).filter((row) => row.dataset.turnId === turnId).flatMap((row) =>
    Array.from(row.querySelectorAll<HTMLElement>("[data-activity-group]"))
  );
}

function turnActivityHeaderIsAboveViewport(
  scroller: HTMLElement,
  turnId: string,
): boolean {
  const header = turnActivityGroups(scroller, turnId).at(-1)?.querySelector<
    HTMLElement
  >("[data-activity-group-header]");
  if (header === null || header === undefined) {
    return false;
  }
  const headerRect = header.getBoundingClientRect();
  return headerRect.height > 0 &&
    headerRect.bottom <= scroller.getBoundingClientRect().top;
}

function turnHasMountedActivityContent(
  scroller: HTMLElement,
  turnId: string,
): boolean {
  return turnActivityGroups(scroller, turnId).some(
    (group) => group.dataset.contentMounted === "true",
  );
}

function initialQuestionTop(scroller: HTMLElement): number {
  return conversationListTop(scroller) + FIRST_TURN_ROW_PADDING;
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
    case "audio": return "[音频]";
    case "localAudio": return `[音频 ${pathName(input.path)}]`;
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
