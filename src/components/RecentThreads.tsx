import {
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
import { createPortal } from "react-dom";

import type {
  ProjectThreadPage,
  ThreadSummary,
  ServerThreadsPhase,
} from "../app/useServerThreads";
import { useVirtualRows } from "./useVirtualRows";
import { ArchiveIcon, DeleteIcon, DraftIcon } from "./SidebarIcons";
import styles from "./RecentThreads.module.css";

export interface RecentThreadsProps {
  readonly currentThreadId: string | null;
  readonly draftThreadIds: ReadonlySet<string>;
  readonly error: string | null;
  readonly grouped: boolean;
  readonly headerActions?: ReactNode;
  readonly sidebarToggle?: ReactNode;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly pendingThreadIds: readonly string[];
  readonly removingThreadIds: readonly string[];
  readonly archivedThread: ThreadSummary | null;
  readonly onArchiveThread: (threadId: string) => void;
  readonly onDeleteThread: (threadId: string) => void;
  readonly onLoadMore: () => void;
  readonly onLoadProjectThreads?: (
    cwd: string,
    limit: number,
  ) => Promise<ProjectThreadPage>;
  readonly onNewTaskInProject?: (cwd: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onOpenThreadInNewWindow?: (threadId: string) => void;
  readonly onUndoArchive: () => void;
  readonly phase: ServerThreadsPhase;
  readonly threads: readonly ThreadSummary[];
  readonly readOnly?: boolean;
}

interface ThreadGroup {
  readonly key: string;
  readonly label: string;
  readonly path: string | null;
  readonly threads: readonly ThreadSummary[];
}

interface ThreadContextMenuState {
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
    };

type RecentThreadGroupEntry = Extract<RecentThreadEntry, { type: "group" }>;

interface StickyGroupHeadingState {
  readonly key: string;
  readonly translateY: number;
}

const GROUP_HEADING_HEIGHT = 32;
const INITIAL_GROUP_THREAD_COUNT = 3;
const GROUP_THREAD_PAGE_SIZE = 3;

export function RecentThreads({
  currentThreadId,
  draftThreadIds,
  error,
  grouped,
  headerActions,
  sidebarToggle,
  hasMore,
  loadingMore,
  pendingThreadIds,
  removingThreadIds,
  archivedThread,
  onArchiveThread,
  onDeleteThread,
  onLoadMore,
  onLoadProjectThreads,
  onNewTaskInProject,
  onOpenThread,
  onOpenThreadInNewWindow,
  onUndoArchive,
  phase,
  threads,
  readOnly = false,
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
  const [stickyGroupHeading, setStickyGroupHeading] =
    useState<StickyGroupHeadingState | null>(null);
  const groups = useMemo(() => groupThreads(threads, grouped), [grouped, threads]);
  const entries = useMemo(
    () => recentThreadEntries({
      collapsedGroupKeys,
      currentThreadId,
      failedProjectGroupKeys,
      grouped,
      groups,
      hasMore,
      loadingProjectGroupKeys,
      projectGroupHasMore,
      visibleGroupThreadCounts,
    }),
    [
      collapsedGroupKeys,
      currentThreadId,
      failedProjectGroupKeys,
      grouped,
      groups,
      hasMore,
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
      return entry?.type === "group" ? GROUP_HEADING_HEIGHT : 40;
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
    setStickyGroupHeading(null);
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
    if (!grouped || currentThreadId === null) {
      return;
    }
    for (const group of groups) {
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

  const updateStickyGroupHeading = useCallback((element: HTMLDivElement | null) => {
    if (!grouped || element === null) {
      setStickyGroupHeading(null);
      return;
    }
    const entryIndex = virtual.indexAtOffset(element.scrollTop);
    if (entryIndex === null) {
      setStickyGroupHeading(null);
      return;
    }
    let groupIndex = entryIndex;
    while (groupIndex >= 0 && entries[groupIndex]?.type !== "group") {
      groupIndex -= 1;
    }
    const group = entries[groupIndex];
    const groupOffset = virtual.offsetForIndex(groupIndex);
    if (
      group?.type !== "group" ||
      group.collapsed ||
      groupOffset === null ||
      element.scrollTop <= groupOffset
    ) {
      setStickyGroupHeading(null);
      return;
    }
    const nextGroupIndex = entries.findIndex(
      (entry, index) => index > groupIndex && entry.type === "group",
    );
    const nextGroupOffset = nextGroupIndex < 0
      ? null
      : virtual.offsetForIndex(nextGroupIndex);
    const translateY = nextGroupOffset === null
      ? 0
      : Math.min(
          0,
          nextGroupOffset - element.scrollTop - GROUP_HEADING_HEIGHT,
        );
    setStickyGroupHeading((current) =>
      current?.key === group.key && current.translateY === translateY
        ? current
        : { key: group.key, translateY },
    );
  }, [entries, grouped, virtual.indexAtOffset, virtual.offsetForIndex]);

  useLayoutEffect(() => {
    updateStickyGroupHeading(listRef.current);
  }, [updateStickyGroupHeading, virtual.totalSize]);

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
    updateStickyGroupHeading(element);
    if (
      hasMore &&
      !loadingMore &&
      element.scrollHeight - element.scrollTop - element.clientHeight <= 120
    ) {
      onLoadMore();
    }
  };
  const stickyGroupEntry = stickyGroupHeading === null
    ? null
    : entries.find(
        (entry): entry is RecentThreadGroupEntry =>
          entry.type === "group" &&
          entry.key === stickyGroupHeading.key &&
          !entry.collapsed,
      ) ?? null;

  return (
    <section aria-labelledby="recent-threads-title" className={styles.section}>
      <header className={styles.sectionHeader}>
        <div className={styles.titleGroup}>
          {sidebarToggle}
          <h2 id="recent-threads-title">最近会话</h2>
        </div>
        {headerActions}
      </header>
      {error === null ? null : (
        <div className={styles.error} role="status">
          <span>{error}</span>
        </div>
      )}
      {phase === "idle" ? (
        <p className={styles.empty}>连接完成后加载会话</p>
      ) : phase === "loading" && threads.length === 0 ? (
        <div aria-label="正在加载最近会话" className={styles.skeleton} role="status">
          <span />
          <span />
          <span />
        </div>
      ) : phase === "error" && threads.length === 0 ? (
        <p className={styles.empty}>最近会话暂时不可用</p>
      ) : threads.length === 0 ? (
        <p className={styles.empty}>尚无最近会话，可新建任务开始</p>
      ) : (
        <div
          aria-label="最近会话"
          className={styles.scroller}
          onScroll={handleScroll}
          ref={listRef}
          role="list"
        >
          {stickyGroupEntry === null || stickyGroupHeading === null ? null : (
            <div
              className={styles.stickyGroupHeading}
              data-sticky-group-heading
              style={{
                transform: `translateY(${stickyGroupHeading.translateY}px)`,
              }}
            >
              <GroupHeading
                entry={stickyGroupEntry}
                {...(onNewTaskInProject === undefined
                  ? {}
                  : { onNewTaskInProject })}
                onToggle={() => toggleGroup(stickyGroupEntry.key)}
              />
            </div>
          )}
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
                      suppressed={stickyGroupHeading?.key === entry.key}
                    />
                  ) : entry.type === "thread" ? (
                    <ThreadRow
                      current={entry.thread.id === currentThreadId}
                      disabled={pendingThreadIds.includes(entry.thread.id)}
                      hasDraft={draftThreadIds.has(entry.thread.id)}
                      operationDisabled={
                        readOnly || pendingThreadIds.includes(entry.thread.id)
                      }
                      onArchive={() => onArchiveThread(entry.thread.id)}
                      onDelete={() => onDeleteThread(entry.thread.id)}
                      onNavigate={(direction) =>
                        navigate(entry.thread.id, direction)
                      }
                      onOpen={() => onOpenThread(entry.thread.id)}
                      {...(onOpenThreadInNewWindow === undefined
                        ? {}
                        : {
                            onOpenContextMenu: (x: number, y: number) =>
                              setContextMenu({
                                threadId: entry.thread.id,
                                title: threadTitle(entry.thread),
                                x,
                                y,
                              }),
                            onOpenInNewWindow: () =>
                              onOpenThreadInNewWindow(entry.thread.id),
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
      {archivedThread === null ? null : (
        <div className={styles.undoNotice} role="status">
          <span>已归档“{threadTitle(archivedThread)}”</span>
          <button
            disabled={readOnly || pendingThreadIds.includes(archivedThread.id)}
            onClick={onUndoArchive}
            type="button"
          >
            撤销
          </button>
        </div>
      )}
      {contextMenu === null || onOpenThreadInNewWindow === undefined
        ? null
        : createPortal(
            <div
              aria-label={`会话“${contextMenu.title}”操作`}
              className={styles.contextMenu}
              data-thread-context-menu
              role="menu"
              style={contextMenuPosition(contextMenu.x, contextMenu.y)}
            >
              <button
                autoFocus
                onClick={() => {
                  onOpenThreadInNewWindow(contextMenu.threadId);
                  setContextMenu(null);
                }}
                role="menuitem"
                type="button"
              >
                在新窗口打开
              </button>
            </div>,
            document.body,
          )}
    </section>
  );
}

function GroupHeading({
  entry,
  onNewTaskInProject,
  onToggle,
  suppressed = false,
}: {
  readonly entry: RecentThreadGroupEntry;
  readonly onNewTaskInProject?: (cwd: string) => void;
  readonly onToggle: () => void;
  readonly suppressed?: boolean;
}) {
  const projectPath = entry.path;
  return (
    <h3
      aria-label={entry.label}
      aria-hidden={suppressed || undefined}
      className={styles.groupHeading}
      inert={suppressed || undefined}
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
  current,
  disabled,
  hasDraft,
  operationDisabled,
  onArchive,
  onDelete,
  onNavigate,
  onOpen,
  onOpenContextMenu,
  onOpenInNewWindow,
  thread,
}: {
  readonly current: boolean;
  readonly disabled: boolean;
  readonly hasDraft: boolean;
  readonly operationDisabled: boolean;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onNavigate: (direction: 1 | -1) => void;
  readonly onOpen: () => void;
  readonly onOpenContextMenu?: (x: number, y: number) => void;
  readonly onOpenInNewWindow?: () => void;
  readonly thread: ThreadSummary;
}) {
  const title = threadTitle(thread);
  const status = threadStatus(thread);
  return (
    <div className={styles.threadRowContainer} data-pending={disabled} role="listitem">
      <button
        aria-current={current ? "page" : undefined}
        className={styles.threadRow}
        data-current={current}
        data-has-draft={hasDraft}
        data-thread-row
        data-thread-id={thread.id}
        disabled={disabled}
        onAuxClick={(event) => {
          if (event.button === 1 && onOpenInNewWindow !== undefined) {
            event.preventDefault();
            onOpenInNewWindow();
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
          } else if (event.key === "Delete") {
            event.preventDefault();
            onDelete();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onNavigate(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
        onClick={onOpen}
        title={`${title}\n${thread.cwd}`}
        type="button"
      >
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
        <span className={styles.threadTitle}>{title}</span>
        {status === null ? null : (
          <span
            aria-label={status.label}
            className={styles.threadStatus}
            data-status={status.kind}
            role="img"
          >
            {status.text}
          </span>
        )}
      </button>
      <span className={styles.rowActions}>
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
      </span>
    </div>
  );
}

function contextMenuPosition(x: number, y: number): CSSProperties {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - 208)),
    top: Math.max(8, Math.min(y, window.innerHeight - 52)),
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

function threadStatus(thread: ThreadSummary): {
  readonly kind: "running" | "approval" | "input" | "error";
  readonly label: string;
  readonly text: string;
} | null {
  if (thread.status.type === "systemError") {
    return { kind: "error", label: "会话失败", text: "失败" };
  }
  if (thread.status.type !== "active") {
    return null;
  }
  if (thread.status.activeFlags.includes("waitingOnApproval")) {
    return { kind: "approval", label: "等待审批", text: "审批" };
  }
  if (thread.status.activeFlags.includes("waitingOnUserInput")) {
    return { kind: "input", label: "等待输入", text: "待回复" };
  }
  return { kind: "running", label: "正在运行", text: "" };
}

function groupThreads(
  threads: readonly ThreadSummary[],
  grouped: boolean,
): readonly ThreadGroup[] {
  if (!grouped) {
    return [{ key: "all", label: "", path: null, threads }];
  }
  const groups = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const key = thread.cwd.trim() || "\u0000other";
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [thread]);
    } else {
      group.push(thread);
    }
  }
  return [...groups.entries()].map(([path, group]) => ({
    key: path,
    label: path === "\u0000other" ? "其他会话" : pathLabel(path),
    path: path === "\u0000other" ? null : path,
    threads: group,
  }));
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
  grouped,
  groups,
  hasMore,
  loadingProjectGroupKeys,
  projectGroupHasMore,
  visibleGroupThreadCounts,
}: {
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly currentThreadId: string | null;
  readonly failedProjectGroupKeys: ReadonlySet<string>;
  readonly grouped: boolean;
  readonly groups: readonly ThreadGroup[];
  readonly hasMore: boolean;
  readonly loadingProjectGroupKeys: ReadonlySet<string>;
  readonly projectGroupHasMore: ReadonlyMap<string, boolean>;
  readonly visibleGroupThreadCounts: ReadonlyMap<string, number>;
}): readonly RecentThreadEntry[] {
  const entries: RecentThreadEntry[] = [];
  for (const group of groups) {
    if (grouped) {
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
    const visibleCount = grouped
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
      grouped &&
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
