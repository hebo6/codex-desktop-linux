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

import type { ThreadSummary, ServerThreadsPhase } from "../app/useServerThreads";
import { useVirtualRows } from "./useVirtualRows";
import styles from "./RecentThreads.module.css";

export interface RecentThreadsProps {
  readonly currentThreadId: string | null;
  readonly error: string | null;
  readonly grouped: boolean;
  readonly headerActions?: ReactNode;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly pendingThreadIds: readonly string[];
  readonly removingThreadIds: readonly string[];
  readonly archivedThread: ThreadSummary | null;
  readonly onArchiveThread: (threadId: string) => void;
  readonly onDeleteThread: (threadId: string) => void;
  readonly onLoadMore: () => void;
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
      readonly type: "loadMore";
    };

type RecentThreadGroupEntry = Extract<RecentThreadEntry, { type: "group" }>;

interface StickyGroupHeadingState {
  readonly key: string;
  readonly translateY: number;
}

const GROUP_HEADING_HEIGHT = 32;

export function RecentThreads({
  currentThreadId,
  error,
  grouped,
  headerActions,
  hasMore,
  loadingMore,
  pendingThreadIds,
  removingThreadIds,
  archivedThread,
  onArchiveThread,
  onDeleteThread,
  onLoadMore,
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
  const [contextMenu, setContextMenu] = useState<ThreadContextMenuState | null>(null);
  const [stickyGroupHeading, setStickyGroupHeading] =
    useState<StickyGroupHeadingState | null>(null);
  const groups = useMemo(() => groupThreads(threads, grouped), [grouped, threads]);
  const entries = useMemo(
    () => recentThreadEntries(groups, grouped, collapsedGroupKeys, hasMore),
    [collapsedGroupKeys, grouped, groups, hasMore],
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
        <h2 id="recent-threads-title">最近会话</h2>
        {headerActions}
      </header>
      {error === null ? null : (
        <div className={styles.error} role="status">
          <span>{error}</span>
        </div>
      )}
      {phase === "idle" ? (
        <p className={styles.empty}>连接完成后加载会话</p>
      ) : phase === "loading" ? (
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
                      onToggle={() => toggleGroup(entry.key)}
                      suppressed={stickyGroupHeading?.key === entry.key}
                    />
                  ) : entry.type === "thread" ? (
                    <ThreadRow
                      current={entry.thread.id === currentThreadId}
                      disabled={pendingThreadIds.includes(entry.thread.id)}
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
                  ) : (
                    <button
                      className={styles.loadMore}
                      disabled={loadingMore}
                      onClick={onLoadMore}
                      type="button"
                    >
                      {loadingMore ? "正在加载" : "加载更多"}
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
  onToggle,
  suppressed = false,
}: {
  readonly entry: RecentThreadGroupEntry;
  readonly onToggle: () => void;
  readonly suppressed?: boolean;
}) {
  return (
    <h3
      aria-hidden={suppressed || undefined}
      className={styles.groupHeading}
      inert={suppressed || undefined}
    >
      <button
        aria-expanded={!entry.collapsed}
        onClick={onToggle}
        title={entry.path ?? undefined}
        type="button"
      >
        <span aria-hidden="true" className={styles.groupArrow} />
        <span>{entry.label}</span>
      </button>
    </h3>
  );
}

function ThreadRow({
  current,
  disabled,
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

function ArchiveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16M6 7v12h12V7M9 11h6" />
      <rect height="3" rx="1" width="18" x="3" y="4" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  );
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

function recentThreadEntries(
  groups: readonly ThreadGroup[],
  grouped: boolean,
  collapsedGroupKeys: ReadonlySet<string>,
  hasMore: boolean,
): readonly RecentThreadEntry[] {
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
    for (const thread of group.threads) {
      entries.push({ key: `thread:${thread.id}`, type: "thread", thread });
    }
  }
  if (hasMore) {
    entries.push({ key: "load-more", type: "loadMore" });
  }
  return entries;
}

function threadRowButtons(container: HTMLDivElement | null): HTMLButtonElement[] {
  return container === null
    ? []
    : [...container.querySelectorAll<HTMLButtonElement>("[data-thread-row]")];
}
