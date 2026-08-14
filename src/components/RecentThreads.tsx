import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";

import type {
  ProjectThreadPage,
  ThreadSummary,
  ServerThreadsPhase,
} from "../app/useServerThreads";
import { useVirtualRows } from "./useVirtualRows";
import {
  ArchiveIcon,
  DeleteIcon,
  DraftIcon,
  RestoreIcon,
  TerminalIcon,
} from "./SidebarIcons";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import styles from "./RecentThreads.module.css";

export interface RecentThreadsProps {
  readonly archiveNotices: readonly ThreadSummary[];
  readonly currentThreadId: string | null;
  readonly draftThreadIds: ReadonlySet<string>;
  readonly error: string | null;
  readonly grouped: boolean;
  readonly headerActions?: ReactNode;
  readonly sidebarToggle?: ReactNode;
  readonly hasMore: boolean;
  readonly hasMorePinnedThreads?: boolean;
  readonly loadingMore: boolean;
  readonly loadingMorePinnedThreads?: boolean;
  readonly pendingThreadIds: readonly string[];
  readonly pendingResultThreadIds?: ReadonlySet<string>;
  readonly removingThreadIds: readonly string[];
  readonly backgroundCommandCounts?: ReadonlyMap<string, number>;
  readonly onArchiveThread: (threadId: string) => void;
  readonly onDeleteThread: (threadId: string) => void;
  readonly onDismissArchiveNotice: (threadId: string) => void;
  readonly onLoadMore: () => void;
  readonly onLoadMorePinnedThreads?: () => void;
  readonly onLoadProjectThreads?: (
    cwd: string,
    limit: number,
  ) => Promise<ProjectThreadPage>;
  readonly onNewTaskInProject?: (cwd: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenThreadInNewTab?: (threadId: string) => void;
  readonly onSetThreadPinned?: (threadId: string, pinned: boolean) => void;
  readonly onUnarchiveThread: (threadId: string) => void;
  readonly phase: ServerThreadsPhase;
  readonly pinnedThreads?: readonly ThreadSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly readOnly?: boolean;
  readonly view: ThreadListView;
}

export type ThreadListView = "recent" | "archived";

interface ThreadGroup {
  readonly kind: "all" | "pinned" | "project";
  readonly key: string;
  readonly label: string;
  readonly path: string | null;
  readonly threads: readonly ThreadSummary[];
}

interface ThreadContextMenuState {
  readonly pinned: boolean;
  readonly threadId: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

type RecentThreadEntry =
  | {
      readonly key: string;
      readonly type: "group";
      readonly label: string;
      readonly path: string | null;
      readonly collapsed: boolean;
    }
  | {
      readonly key: string;
      readonly type: "thread";
      readonly thread: ThreadSummary;
    }
  | {
      readonly key: string;
      readonly type: "loadProject";
      readonly groupKey: string;
      readonly groupLabel: string;
      readonly cwd: string;
      readonly error: boolean;
      readonly loading: boolean;
    }
  | {
      readonly key: string;
      readonly type: "loadMoreThreads";
    }
  | {
      readonly key: string;
      readonly type: "loadMorePinnedThreads";
    };

type RecentThreadGroupEntry = Extract<RecentThreadEntry, { type: "group" }>;

const GROUP_HEADING_HEIGHT = 32;
const THREAD_ROW_HEIGHT = 56;
const ACTION_ROW_HEIGHT = 40;
const INITIAL_GROUP_THREAD_COUNT = 3;
const GROUP_THREAD_PAGE_SIZE = 3;
const RELATIVE_TIME_REFRESH_MS = 30_000;
const ARCHIVE_NOTICE_DURATION_MS = 8_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("zh-CN", {
  numeric: "always",
});
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();

export function RecentThreads({
  archiveNotices,
  currentThreadId,
  draftThreadIds,
  error,
  grouped,
  headerActions,
  sidebarToggle,
  hasMore,
  hasMorePinnedThreads = false,
  loadingMore,
  loadingMorePinnedThreads = false,
  pendingThreadIds,
  pendingResultThreadIds = EMPTY_THREAD_IDS,
  removingThreadIds,
  backgroundCommandCounts = EMPTY_COMMAND_COUNTS,
  onArchiveThread,
  onDeleteThread,
  onDismissArchiveNotice,
  onLoadMore,
  onLoadMorePinnedThreads,
  onLoadProjectThreads,
  onNewTaskInProject,
  onOpenThread,
  onOpenThreadInNewTab,
  onSetThreadPinned,
  onUnarchiveThread,
  phase,
  pinnedThreads = [],
  threads,
  readOnly = false,
  view,
}: RecentThreadsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [visibleGroupThreadCounts, setVisibleGroupThreadCounts] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [projectGroupHasMore, setProjectGroupHasMore] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const [loadingProjectGroupKeys, setLoadingProjectGroupKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [failedProjectGroupKeys, setFailedProjectGroupKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [contextMenu, setContextMenu] = useState<ThreadContextMenuState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const groups = useMemo(
    () => groupThreads(threads, pinnedThreads, grouped),
    [grouped, pinnedThreads, threads],
  );
  const pinnedThreadIds = useMemo(
    () => new Set(pinnedThreads.map(({ id }) => id)),
    [pinnedThreads],
  );
  const entries = useMemo(
    () => recentThreadEntries({
      collapsedGroupKeys,
      currentThreadId,
      failedProjectGroupKeys,
      groups,
      hasMore,
      hasMorePinnedThreads,
      loadingProjectGroupKeys,
      projectGroupHasMore,
      visibleGroupThreadCounts,
    }),
    [
      collapsedGroupKeys,
      currentThreadId,
      failedProjectGroupKeys,
      groups,
      hasMore,
      hasMorePinnedThreads,
      loadingProjectGroupKeys,
      projectGroupHasMore,
      visibleGroupThreadCounts,
    ],
  );
  const pinnedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (currentThreadId !== null) {
      keys.add(`thread:${currentThreadId}`);
    }
    if (contextMenu !== null) {
      keys.add(`thread:${contextMenu.threadId}`);
    }
    for (const threadId of pendingThreadIds) {
      keys.add(`thread:${threadId}`);
    }
    return keys;
  }, [contextMenu, currentThreadId, pendingThreadIds]);
  const getEntryKey = useCallback(
    (index: number) => entries[index]?.key ?? `missing:${index}`,
    [entries],
  );
  const estimateEntrySize = useCallback(
    (index: number) => {
      const entry = entries[index];
      return entry?.type === "group"
        ? GROUP_HEADING_HEIGHT
        : entry?.type === "thread"
          ? THREAD_ROW_HEIGHT
          : ACTION_ROW_HEIGHT;
    },
    [entries],
  );
  const virtual = useVirtualRows({
    count: entries.length,
    estimateSize: estimateEntrySize,
    getKey: getEntryKey,
    pinnedKeys,
    scrollerRef: listRef,
    overscan: 320,
  });

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (phase !== "loading") {
      return;
    }
    setVisibleGroupThreadCounts(new Map());
    setProjectGroupHasMore(new Map());
    setLoadingProjectGroupKeys(new Set());
    setFailedProjectGroupKeys(new Set());
  }, [phase]);

  useEffect(() => {
    const interval = window.setInterval(
      () => setNowMs(Date.now()),
      RELATIVE_TIME_REFRESH_MS,
    );
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!grouped || currentThreadId === null) {
      return;
    }
    for (const group of groups) {
      if (group.kind !== "project") {
        continue;
      }
      const currentIndex = group.threads.findIndex(
        ({ id }) => id === currentThreadId,
      );
      if (currentIndex < 0) {
        continue;
      }
      const requiredCount = currentIndex + 1;
      setVisibleGroupThreadCounts((current) => {
        if ((current.get(group.key) ?? INITIAL_GROUP_THREAD_COUNT) >= requiredCount) {
          return current;
        }
        const next = new Map(current);
        next.set(group.key, requiredCount);
        return next;
      });
      break;
    }
  }, [currentThreadId, grouped, groups]);

  const loadMoreProjectThreads = useCallback(async (
    groupKey: string,
    cwd: string,
  ) => {
    const group = groups.find(({ key }) => key === groupKey);
    if (group === undefined || loadingProjectGroupKeys.has(groupKey)) {
      return;
    }
    const configuredCount = visibleGroupThreadCounts.get(groupKey)
      ?? INITIAL_GROUP_THREAD_COUNT;
    const currentIndex = currentThreadId === null
      ? -1
      : group.threads.findIndex(({ id }) => id === currentThreadId);
    const visibleCount = Math.min(
      group.threads.length,
      Math.max(configuredCount, currentIndex + 1),
    );
    const nextCount = visibleCount + GROUP_THREAD_PAGE_SIZE;
    setFailedProjectGroupKeys((current) => withoutKey(current, groupKey));
    if (group.threads.length > visibleCount) {
      setVisibleGroupThreadCounts((current) => mapWith(current, groupKey, nextCount));
      return;
    }
    if (onLoadProjectThreads === undefined) {
      return;
    }
    setLoadingProjectGroupKeys((current) => withKey(current, groupKey));
    try {
      const page = await onLoadProjectThreads(cwd, nextCount);
      setVisibleGroupThreadCounts((current) => mapWith(current, groupKey, nextCount));
      setProjectGroupHasMore((current) => mapWith(current, groupKey, page.hasMore));
    } catch {
      setFailedProjectGroupKeys((current) => withKey(current, groupKey));
    } finally {
      setLoadingProjectGroupKeys((current) => withoutKey(current, groupKey));
    }
  }, [
    currentThreadId,
    groups,
    loadingProjectGroupKeys,
    onLoadProjectThreads,
    visibleGroupThreadCounts,
  ]);

  useEffect(() => {
    if (contextMenu === null) {
      return;
    }
    const closeFromPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-thread-context-menu]") !== null
      ) {
        return;
      }
      setContextMenu(null);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setContextMenu(null);
      }
    };
    const closeFromBlur = () => setContextMenu(null);
    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("blur", closeFromBlur);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("blur", closeFromBlur);
    };
  }, [contextMenu]);

  useEffect(() => {
    setContextMenu(null);
  }, [view]);

  const navigate = (threadId: string, direction: 1 | -1) => {
    const threadEntries = entries.filter(
      (entry): entry is Extract<RecentThreadEntry, { type: "thread" }> =>
        entry.type === "thread",
    );
    const currentIndex = threadEntries.findIndex(
      ({ thread }) => thread.id === threadId,
    );
    if (currentIndex < 0 || threadEntries.length === 0) {
      return;
    }
    const target =
      threadEntries[
        (currentIndex + direction + threadEntries.length) % threadEntries.length
      ];
    if (target === undefined) {
      return;
    }
    const entryIndex = entries.findIndex(({ key }) => key === target.key);
    const renderedTarget = threadRowButtons(listRef.current).find(
      (button) => button.dataset.threadId === target.thread.id,
    );
    if (renderedTarget !== undefined) {
      renderedTarget.focus();
      return;
    }
    virtual.scrollToIndex(entryIndex);
    requestAnimationFrame(() => {
      threadRowButtons(listRef.current)
        .find((button) => button.dataset.threadId === target.thread.id)
        ?.focus();
    });
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    setContextMenu(null);
    const element = event.currentTarget;
    if (
      hasMore &&
      !loadingMore &&
      element.scrollHeight - element.scrollTop - element.clientHeight <= 120
    ) {
      onLoadMore();
    }
  };

  return (
    <section aria-label="会话" className={styles.section}>
      <header className={styles.sectionHeader}>
        <div className={styles.titleGroup}>
          {sidebarToggle}
        </div>
        {headerActions}
      </header>
      {error === null ? null : (
        <div className={styles.error} role="status">
          <span>{error}</span>
        </div>
      )}
      {phase === "idle" ? (
        <p className={styles.empty}>
          {view === "recent" ? "连接完成后加载会话" : "打开后加载已归档会话"}
        </p>
      ) : phase === "loading" &&
        threads.length === 0 &&
        pinnedThreads.length === 0 ? (
        <div
          aria-label={view === "recent" ? "正在加载最近会话" : "正在加载已归档会话"}
          className={styles.skeleton}
          role="status"
        >
          <span />
          <span />
          <span />
        </div>
      ) : phase === "error" &&
        threads.length === 0 &&
        pinnedThreads.length === 0 ? (
        <p className={styles.empty}>
          {view === "recent" ? "最近会话暂时不可用" : "已归档会话暂时不可用"}
        </p>
      ) : threads.length === 0 && pinnedThreads.length === 0 ? (
        <p className={styles.empty}>
          {view === "recent" ? "尚无最近会话，可新建任务开始" : "尚无已归档会话"}
        </p>
      ) : (
        <div
          aria-label={view === "recent" ? "最近会话" : "已归档会话"}
          className={styles.scroller}
          onScroll={handleScroll}
          ref={listRef}
          role="list"
        >
          <div
            className={styles.virtualCanvas}
            style={{ height: virtual.totalSize } as CSSProperties}
          >
            {virtual.rows.map((row) => {
              const entry = entries[row.index];
              if (entry === undefined) {
                return null;
              }
              const removing =
                entry.type === "thread" &&
                removingThreadIds.includes(entry.thread.id);
              return (
                <div
                  className={styles.virtualEntry}
                  data-removing={removing}
                  data-virtual-key={row.key}
                  key={row.key}
                  ref={virtual.measureElement(row.key)}
                  style={{
                    height: removing ? 0 : row.size,
                    minHeight: removing ? 0 : row.size,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  {entry.type === "group" ? (
                    <GroupHeading
                      entry={entry}
                      {...(onNewTaskInProject === undefined
                        ? {}
                        : { onNewTaskInProject })}
                      onToggle={() => toggleGroup(entry.key)}
                    />
                  ) : entry.type === "thread" ? (
                    <ThreadRow
                      archived={view === "archived"}
                      backgroundCommandCount={
                        backgroundCommandCounts.get(entry.thread.id) ?? 0
                      }
                      current={entry.thread.id === currentThreadId}
                      disabled={pendingThreadIds.includes(entry.thread.id)}
                      hasDraft={draftThreadIds.has(entry.thread.id)}
                      operationDisabled={
                        readOnly || pendingThreadIds.includes(entry.thread.id)
                      }
                      resultPending={pendingResultThreadIds.has(entry.thread.id)}
                      {...(view === "recent"
                        ? {
                            onArchive: () => onArchiveThread(entry.thread.id),
                            onDelete: () => onDeleteThread(entry.thread.id),
                          }
                        : {
                            onRestore: () => onUnarchiveThread(entry.thread.id),
                          })}
                      onNavigate={(direction) =>
                        navigate(entry.thread.id, direction)
                      }
                      onOpen={() => {
                        if (view === "recent") {
                          onOpenThread(entry.thread.id);
                        } else {
                          onUnarchiveThread(entry.thread.id);
                        }
                      }}
                      nowMs={nowMs}
                      {...(view === "archived" || (
                        onOpenThreadInNewTab === undefined &&
                        onSetThreadPinned === undefined
                      )
                        ? {}
                        : {
                            onOpenContextMenu: (x: number, y: number) =>
                              setContextMenu({
                                pinned: pinnedThreadIds.has(entry.thread.id),
                                threadId: entry.thread.id,
                                title: threadTitle(entry.thread),
                                x,
                                y,
                              }),
                            ...(onOpenThreadInNewTab === undefined
                              ? {}
                              : {
                                  onOpenInNewTab: () =>
                                    onOpenThreadInNewTab(entry.thread.id),
                                }),
                          })}
                      thread={entry.thread}
                    />
                  ) : entry.type === "loadProject" ? (
                    <button
                      aria-label={
                        entry.error
                          ? `重试加载“${entry.groupLabel}”的更多会话`
                          : `加载“${entry.groupLabel}”的更多会话`
                      }
                      className={styles.loadMore}
                      disabled={entry.loading}
                      onClick={() => void loadMoreProjectThreads(
                        entry.groupKey,
                        entry.cwd,
                      )}
                      type="button"
                    >
                      {entry.loading
                        ? "正在加载"
                        : entry.error
                          ? "加载失败，点击重试"
                          : "加载更多"}
                    </button>
                  ) : entry.type === "loadMorePinnedThreads" ? (
                    <button
                      className={styles.loadMore}
                      disabled={loadingMorePinnedThreads}
                      onClick={onLoadMorePinnedThreads}
                      type="button"
                    >
                      {loadingMorePinnedThreads ? "正在加载" : "加载更多置顶会话"}
                    </button>
                  ) : (
                    <button
                      className={styles.loadMore}
                      disabled={loadingMore}
                      onClick={onLoadMore}
                      type="button"
                    >
                      {loadingMore
                        ? "正在加载"
                        : grouped
                          ? "加载更早会话"
                          : "加载更多"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <ArchiveUndoNotices
        notices={archiveNotices}
        onDismiss={onDismissArchiveNotice}
        onUndo={onUnarchiveThread}
        pendingThreadIds={pendingThreadIds}
        readOnly={readOnly}
      />
      {contextMenu === null
        ? null
        : createPortal(
            <div
              aria-label={`会话“${contextMenu.title}”操作`}
              className={styles.contextMenu}
              data-thread-context-menu
              role="menu"
              style={contextMenuPosition(contextMenu.x, contextMenu.y)}
            >
              {onOpenThreadInNewTab === undefined ? null : (
                <button
                  autoFocus
                  onClick={() => {
                    onOpenThreadInNewTab(contextMenu.threadId);
                    setContextMenu(null);
                  }}
                  role="menuitem"
                  type="button"
                >
                  在新标签打开
                </button>
              )}
              {onSetThreadPinned === undefined ? null : (
                <button
                  autoFocus={onOpenThreadInNewTab === undefined}
                  disabled={
                    readOnly || pendingThreadIds.includes(contextMenu.threadId)
                  }
                  onClick={() => {
                    onSetThreadPinned(contextMenu.threadId, !contextMenu.pinned);
                    setContextMenu(null);
                  }}
                  role="menuitem"
                  type="button"
                >
                  {contextMenu.pinned ? "取消置顶" : "置顶会话"}
                </button>
              )}
            </div>,
            document.body,
          )}
    </section>
  );
}

function ArchiveUndoNotices({
  notices,
  onDismiss,
  onUndo,
  pendingThreadIds,
  readOnly,
}: {
  readonly notices: readonly ThreadSummary[];
  readonly onDismiss: (threadId: string) => void;
  readonly onUndo: (threadId: string) => void;
  readonly pendingThreadIds: readonly string[];
  readonly readOnly: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (notices.length === 0) {
      setHovered(false);
      setFocused(false);
    }
  }, [notices.length]);
  if (notices.length === 0) {
    return null;
  }
  const paused = hovered || focused;
  return (
    <div
      aria-label="归档操作"
      className={styles.undoNotices}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        setFocused(false);
      }}
      onFocusCapture={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {notices.map((thread) => (
        <ArchiveUndoNotice
          key={thread.id}
          onDismiss={onDismiss}
          onUndo={onUndo}
          paused={paused}
          pending={pendingThreadIds.includes(thread.id)}
          readOnly={readOnly}
          thread={thread}
        />
      ))}
    </div>
  );
}

function ArchiveUndoNotice({
  onDismiss,
  onUndo,
  paused,
  pending,
  readOnly,
  thread,
}: {
  readonly onDismiss: (threadId: string) => void;
  readonly onUndo: (threadId: string) => void;
  readonly paused: boolean;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly thread: ThreadSummary;
}) {
  const remainingMsRef = useRef(ARCHIVE_NOTICE_DURATION_MS);
  const previousPendingRef = useRef(pending);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (previousPendingRef.current && !pending) {
      remainingMsRef.current = ARCHIVE_NOTICE_DURATION_MS;
    }
    previousPendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    if (paused || pending) {
      return;
    }
    const startedAt = Date.now();
    const timeout = window.setTimeout(() => {
      remainingMsRef.current = 0;
      onDismissRef.current(thread.id);
    }, remainingMsRef.current);
    return () => {
      window.clearTimeout(timeout);
      remainingMsRef.current = Math.max(
        0,
        remainingMsRef.current - (Date.now() - startedAt),
      );
    };
  }, [paused, pending, thread.id]);

  return (
    <div className={styles.undoNotice} role="status">
      <span>已归档“{threadTitle(thread)}”</span>
      <button
        disabled={readOnly || pending}
        onClick={() => onUndo(thread.id)}
        type="button"
      >
        {pending ? "正在撤销" : "撤销"}
      </button>
    </div>
  );
}

function GroupHeading({
  entry,
  onNewTaskInProject,
  onToggle,
}: {
  readonly entry: RecentThreadGroupEntry;
  readonly onNewTaskInProject?: (cwd: string) => void;
  readonly onToggle: () => void;
}) {
  const projectPath = entry.path;
  return (
    <h3
      aria-label={entry.label}
      className={styles.groupHeading}
    >
      <button
        aria-expanded={!entry.collapsed}
        className={styles.groupToggle}
        onClick={onToggle}
        title={entry.path ?? undefined}
        type="button"
      >
        <span aria-hidden="true" className={styles.groupArrow} />
        <span>{entry.label}</span>
      </button>
      {projectPath === null || onNewTaskInProject === undefined ? null : (
        <button
          aria-label={`在 ${projectPath} 中新建会话`}
          className={styles.groupNewTask}
          onClick={() => onNewTaskInProject(projectPath)}
          title="在此项目中新建会话"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
    </h3>
  );
}

function ThreadRow({
  archived,
  backgroundCommandCount,
  current,
  disabled,
  hasDraft,
  operationDisabled,
  resultPending,
  onArchive,
  onDelete,
  onNavigate,
  onOpen,
  onOpenContextMenu,
  onOpenInNewTab,
  onRestore,
  nowMs,
  thread,
}: {
  readonly archived: boolean;
  readonly backgroundCommandCount: number;
  readonly current: boolean;
  readonly disabled: boolean;
  readonly hasDraft: boolean;
  readonly operationDisabled: boolean;
  readonly resultPending: boolean;
  readonly onArchive?: () => void;
  readonly onDelete?: () => void;
  readonly onNavigate: (direction: 1 | -1) => void;
  readonly onOpen: () => void;
  readonly onOpenContextMenu?: (x: number, y: number) => void;
  readonly onOpenInNewTab?: () => void;
  readonly onRestore?: () => void;
  readonly nowMs: number;
  readonly thread: ThreadSummary;
}) {
  const title = threadTitle(thread);
  const projectName = thread.cwd.trim().length === 0
    ? "其他会话"
    : pathLabel(thread.cwd);
  const relativeUpdatedAt = formatRelativeUpdatedAt(thread.updatedAt, nowMs);
  const threadStatus = displayedThreadStatus(thread.status.type);
  const activeFlags = thread.status.type === "active"
    ? thread.status.activeFlags
    : [];
  const accessibleLabel = [
    title,
    ...(archived ? ["已归档，按 Enter 恢复"] : []),
    ...(resultPending ? ["任务已完成，等待查看"] : []),
    ...(hasDraft ? ["存在未发送草稿"] : []),
    ...(threadStatus === null ? [] : [threadStatus.label]),
    ...activeFlags.map((flag) => ACTIVE_FLAG_CONTENT[flag].label),
    ...(backgroundCommandCount === 0
      ? []
      : [`${backgroundCommandCount} 个后台命令正在运行`]),
    `项目 ${projectName}`,
    `${relativeUpdatedAt}更新`,
  ].join("，");
  return (
    <div
      className={styles.threadRowContainer}
      data-pending={disabled}
      data-single-action={archived}
      role="listitem"
    >
      <button
        aria-label={accessibleLabel}
        aria-current={current ? "page" : undefined}
        className={styles.threadRow}
        data-current={current}
        data-has-draft={hasDraft}
        data-thread-row
        data-thread-id={thread.id}
        disabled={disabled}
        onAuxClick={(event) => {
          if (event.button === 1 && onOpenInNewTab !== undefined) {
            event.preventDefault();
            onOpenInNewTab();
          }
        }}
        onContextMenu={(event) => {
          if (onOpenContextMenu === undefined) {
            return;
          }
          event.preventDefault();
          onOpenContextMenu(event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (
            onOpenContextMenu !== undefined &&
            (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
          ) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenContextMenu(bounds.left + 24, bounds.top + 24);
          } else if (event.key === "Delete" && onDelete !== undefined) {
            event.preventDefault();
            onDelete();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onNavigate(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
        onClick={(event) => {
          if (event.ctrlKey && onOpenInNewTab !== undefined) {
            onOpenInNewTab();
          } else {
            onOpen();
          }
        }}
        title={`${title}\n${thread.cwd}`}
        type="button"
      >
        <span className={styles.threadTitleLine}>
          <span className={styles.titleIndicators}>
            <ThreadStatusIndicator
              status={resultPending ? "resultReady" : null}
            />
            {hasDraft ? (
              <span
                aria-label="存在未发送草稿"
                className={styles.draftIndicator}
                data-present="true"
                role="img"
                title="存在未发送草稿"
              >
                <DraftIcon />
              </span>
            ) : null}
          </span>
          <span className={styles.threadTitle}>{title}</span>
          <span className={styles.titleTrailingIndicators}>
            <span className={styles.activeFlags}>
              {activeFlags.map((flag) => {
                const content = ACTIVE_FLAG_CONTENT[flag];
                return (
                  <span
                    aria-label={content.label}
                    className={styles.activeFlag}
                    data-active-flag={flag}
                    key={flag}
                    role="img"
                    title={content.label}
                  >
                    {content.text}
                  </span>
                );
              })}
            </span>
            {backgroundCommandCount === 0 ? null : (
              <span
                aria-label={`${backgroundCommandCount} 个后台命令正在运行`}
                className={styles.backgroundCommands}
                role="img"
                title={`${backgroundCommandCount} 个后台命令正在运行`}
              >
                <TerminalIcon />
                <span>{backgroundCommandCount}</span>
              </span>
            )}
          </span>
        </span>
        <span className={styles.threadMetadata}>
          {threadStatus === null ? null : (
            <span
              className={styles.threadStatus}
              data-thread-status={threadStatus.kind}
            >
              {threadStatus.text}
            </span>
          )}
          <span
            className={styles.projectName}
            title={thread.cwd}
          >
            {projectName}
          </span>
          <time
            className={styles.updatedAt}
            dateTime={new Date(thread.updatedAt * 1_000).toISOString()}
            title={new Date(thread.updatedAt * 1_000).toLocaleString()}
          >
            {relativeUpdatedAt}
          </time>
        </span>
      </button>
      <span className={styles.rowActions}>
        {archived ? (
          <button
            aria-label={`恢复“${title}”`}
            disabled={operationDisabled}
            onClick={onRestore}
            title="恢复"
            type="button"
          >
            <RestoreIcon />
          </button>
        ) : (
          <>
            <button
              aria-label={`归档“${title}”`}
              disabled={operationDisabled}
              onClick={onArchive}
              title="归档"
              type="button"
            >
              <ArchiveIcon />
            </button>
            <button
              aria-label={`删除“${title}”`}
              disabled={operationDisabled}
              onClick={onDelete}
              title="删除"
              type="button"
            >
              <DeleteIcon />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

const EMPTY_COMMAND_COUNTS: ReadonlyMap<string, number> = new Map();

const ACTIVE_FLAG_CONTENT = Object.freeze({
  waitingOnApproval: { label: "等待审批", text: "待审批" },
  waitingOnUserInput: { label: "等待输入", text: "待回复" },
});

interface DisplayedThreadStatus {
  readonly kind: "active" | "idle" | "systemError";
  readonly label: string;
  readonly text: string;
}

function displayedThreadStatus(
  type: ThreadSummary["status"]["type"],
): DisplayedThreadStatus | null {
  switch (type) {
    case "active":
      return { kind: type, label: "线程正在运行", text: "运行中" };
    case "idle":
      return { kind: type, label: "线程空闲", text: "空闲" };
    case "systemError":
      return { kind: type, label: "线程失败", text: "失败" };
    case "notLoaded":
      return null;
  }
}

function formatRelativeUpdatedAt(updatedAt: number, nowMs: number): string {
  const updatedAtMs = updatedAt * 1_000;
  const elapsedMs = Math.max(0, nowMs - updatedAtMs);
  if (elapsedMs < MINUTE_MS) {
    return "刚刚";
  }
  if (elapsedMs < HOUR_MS) {
    return RELATIVE_TIME_FORMATTER.format(
      -Math.floor(elapsedMs / MINUTE_MS),
      "minute",
    );
  }
  if (elapsedMs < DAY_MS) {
    return RELATIVE_TIME_FORMATTER.format(
      -Math.floor(elapsedMs / HOUR_MS),
      "hour",
    );
  }
  if (elapsedMs < WEEK_MS) {
    return RELATIVE_TIME_FORMATTER.format(
      -Math.floor(elapsedMs / DAY_MS),
      "day",
    );
  }
  if (elapsedMs < MONTH_MS) {
    return RELATIVE_TIME_FORMATTER.format(
      -Math.floor(elapsedMs / WEEK_MS),
      "week",
    );
  }
  if (elapsedMs < YEAR_MS) {
    return RELATIVE_TIME_FORMATTER.format(
      -Math.floor(elapsedMs / MONTH_MS),
      "month",
    );
  }
  return RELATIVE_TIME_FORMATTER.format(
    -Math.floor(elapsedMs / YEAR_MS),
    "year",
  );
}

function contextMenuPosition(x: number, y: number): CSSProperties {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - 208)),
    top: Math.max(8, Math.min(y, window.innerHeight - 96)),
  };
}

function threadTitle(thread: ThreadSummary): string {
  const name = thread.name?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  const preview = thread.preview.trim().split(/\r?\n/u, 1)[0]?.trim();
  return preview === undefined || preview.length === 0 ? "未命名会话" : preview;
}

function groupThreads(
  threads: readonly ThreadSummary[],
  pinnedThreads: readonly ThreadSummary[],
  grouped: boolean,
): readonly ThreadGroup[] {
  const pinnedThreadIds = new Set(pinnedThreads.map(({ id }) => id));
  const unpinnedThreads = threads.filter(({ id }) => !pinnedThreadIds.has(id));
  const pinnedGroup: readonly ThreadGroup[] = pinnedThreads.length === 0
    ? []
    : [
        {
          key: "pinned",
          kind: "pinned",
          label: "已置顶",
          path: null,
          threads: pinnedThreads,
        },
      ];
  if (!grouped) {
    return [
      ...pinnedGroup,
      {
        key: "all",
        kind: "all",
        label: "",
        path: null,
        threads: unpinnedThreads,
      },
    ];
  }
  const groups = new Map<string, ThreadSummary[]>();
  for (const thread of unpinnedThreads) {
    const key = thread.cwd.trim() || "\u0000other";
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [thread]);
    } else {
      group.push(thread);
    }
  }
  const projectGroups = [...groups.entries()].map(([path, group]) => ({
    key: path,
    kind: "project" as const,
    label: path === "\u0000other" ? "其他会话" : pathLabel(path),
    path: path === "\u0000other" ? null : path,
    threads: group,
  }));
  return [...pinnedGroup, ...projectGroups];
}

function pathLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const label = normalized.split(/[\\/]/u).at(-1);
  return label === undefined || label.length === 0 ? path : label;
}

function recentThreadEntries({
  collapsedGroupKeys,
  currentThreadId,
  failedProjectGroupKeys,
  groups,
  hasMore,
  hasMorePinnedThreads,
  loadingProjectGroupKeys,
  projectGroupHasMore,
  visibleGroupThreadCounts,
}: {
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly currentThreadId: string | null;
  readonly failedProjectGroupKeys: ReadonlySet<string>;
  readonly groups: readonly ThreadGroup[];
  readonly hasMore: boolean;
  readonly hasMorePinnedThreads: boolean;
  readonly loadingProjectGroupKeys: ReadonlySet<string>;
  readonly projectGroupHasMore: ReadonlyMap<string, boolean>;
  readonly visibleGroupThreadCounts: ReadonlyMap<string, number>;
}): readonly RecentThreadEntry[] {
  const entries: RecentThreadEntry[] = [];
  for (const group of groups) {
    const hasHeading = group.kind !== "all";
    if (hasHeading) {
      const key = `group:${group.key}`;
      const collapsed = collapsedGroupKeys.has(key);
      entries.push({
        key,
        type: "group",
        label: group.label,
        path: group.path,
        collapsed,
      });
      if (collapsed) {
        continue;
      }
    }
    const currentIndex = currentThreadId === null
      ? -1
      : group.threads.findIndex(({ id }) => id === currentThreadId);
    const visibleCount = group.kind === "project"
      ? Math.max(
          visibleGroupThreadCounts.get(group.key) ?? INITIAL_GROUP_THREAD_COUNT,
          currentIndex + 1,
        )
      : group.threads.length;
    for (const thread of group.threads.slice(0, visibleCount)) {
      entries.push({ key: `thread:${thread.id}`, type: "thread", thread });
    }
    const projectHasMore = projectGroupHasMore.get(group.key)
      ?? (hasMore && group.threads.length >= INITIAL_GROUP_THREAD_COUNT);
    if (
      group.kind === "project" &&
      (group.threads.length > visibleCount || projectHasMore)
    ) {
      entries.push({
        key: `load-project:${group.key}`,
        type: "loadProject",
        groupKey: group.key,
        groupLabel: group.label,
        cwd: group.path ?? "",
        error: failedProjectGroupKeys.has(group.key),
        loading: loadingProjectGroupKeys.has(group.key),
      });
    }
    if (group.kind === "pinned" && hasMorePinnedThreads) {
      entries.push({
        key: "load-more-pinned-threads",
        type: "loadMorePinnedThreads",
      });
    }
  }
  if (hasMore) {
    entries.push({ key: "load-more-threads", type: "loadMoreThreads" });
  }
  return entries;
}

function mapWith<T>(
  current: ReadonlyMap<string, T>,
  key: string,
  value: T,
): ReadonlyMap<string, T> {
  const next = new Map(current);
  next.set(key, value);
  return next;
}

function withKey(current: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(current);
  next.add(key);
  return next;
}

function withoutKey(
  current: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  if (!current.has(key)) {
    return current;
  }
  const next = new Set(current);
  next.delete(key);
  return next;
}

function threadRowButtons(container: HTMLDivElement | null): HTMLButtonElement[] {
  return container === null
    ? []
    : [...container.querySelectorAll<HTMLButtonElement>("[data-thread-row]")];
}
