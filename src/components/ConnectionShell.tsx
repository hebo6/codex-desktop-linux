import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type {
  ProjectThreadPage,
  ServerThreadsPhase,
  ThreadSummary,
} from "../app/useServerThreads";
import type { ReconnectViewState } from "../app/useConfiguredServerConnection";
import type { ConnectionPhase } from "../store/connectionSlice";
import { RecentThreads } from "./RecentThreads";
import {
  ComposeIcon,
  GroupIcon,
  MenuIcon,
  MoreIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SidebarCollapseIcon,
} from "./SidebarIcons";
import { WindowControls } from "./WindowControls";
import styles from "./ConnectionShell.module.css";

export type { ConnectionPhase } from "../store/connectionSlice";

interface ConnectionShellProps {
  phase: ConnectionPhase;
  detail?: string;
  serverControl?: ReactNode;
  threads?: readonly ThreadSummary[];
  threadListPhase?: ServerThreadsPhase;
  threadListError?: string | null;
  currentThreadId?: string | null;
  draftThreadIds?: ReadonlySet<string>;
  hasMoreThreads?: boolean;
  loadingMoreThreads?: boolean;
  refreshingThreads?: boolean;
  pendingThreadIds?: readonly string[];
  removingThreadIds?: readonly string[];
  archivedThread?: ThreadSummary | null;
  onArchiveThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onLoadMoreThreads?: () => void;
  onLoadProjectThreads?: (
    cwd: string,
    limit: number,
  ) => Promise<ProjectThreadPage>;
  onRefreshThreads?: () => void;
  onSearchThreads?: () => void;
  onNewTask?: () => void;
  onNewTaskInProject?: (cwd: string) => void;
  onOpenThread?: (threadId: string) => void;
  onOpenThreadInNewWindow?: (threadId: string) => void;
  onUndoArchive?: () => void;
  onRetry?: () => void;
  onOpenDiagnostics?: () => void;
  onOpenSettings?: () => void;
  mainContent?: ReactNode;
  contentTitle?: string;
  contentSubtitle?: string;
  topbarAccessory?: ReactNode;
  reconnect?: ReconnectViewState | null;
  onStopReconnect?: () => void;
  offline?: boolean;
  offlineSyncedAt?: number | null;
  announcement?: string | null;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
}

interface PhaseContent {
  eyebrow: string;
  title: string;
  description: string;
  shortLabel: string;
}

const PHASE_CONTENT: Record<ConnectionPhase, PhaseContent> = {
  disconnected: {
    eyebrow: "等待连接",
    title: "尚未连接 app-server",
    description: "连接开始后，这里将显示传输与初始化进度",
    shortLabel: "未连接",
  },
  connecting: {
    eyebrow: "建立连接",
    title: "正在连接 app-server",
    description: "连接建立后，客户端将验证服务器能力并完成初始化",
    shortLabel: "连接中",
  },
  initializing: {
    eyebrow: "初始化连接",
    title: "正在初始化 Codex",
    description: "业务请求将在初始化完成后开放，当前不会创建任何会话",
    shortLabel: "初始化中",
  },
  ready: {
    eyebrow: "连接完成",
    title: "Codex 已就绪",
    description: "服务器连接和初始化已经完成",
    shortLabel: "已连接",
  },
  error: {
    eyebrow: "连接中断",
    title: "未能完成连接",
    description: "请检查连接诊断后重试",
    shortLabel: "连接错误",
  },
};

const STEPS = [
  { key: "transport", label: "建立传输连接" },
  { key: "initialize", label: "初始化 app-server" },
  { key: "capabilities", label: "读取服务器能力" },
] as const;

type StepState = "complete" | "current" | "pending";

function getStepState(phase: ConnectionPhase, index: number): StepState {
  if (phase === "disconnected") {
    return "pending";
  }

  if (phase === "connecting") {
    return index === 0 ? "current" : "pending";
  }

  if (phase === "initializing") {
    return index === 0 ? "complete" : index === 1 ? "current" : "pending";
  }

  if (phase === "ready") {
    return "complete";
  }

  return "pending";
}

export function ConnectionShell({
  phase,
  detail,
  serverControl,
  threads = [],
  threadListPhase = "idle",
  threadListError = null,
  currentThreadId = null,
  draftThreadIds = EMPTY_THREAD_IDS,
  hasMoreThreads = false,
  loadingMoreThreads = false,
  refreshingThreads = false,
  pendingThreadIds = [],
  removingThreadIds = [],
  archivedThread = null,
  onArchiveThread,
  onDeleteThread,
  onLoadMoreThreads,
  onLoadProjectThreads,
  onRefreshThreads,
  onSearchThreads,
  onNewTask,
  onNewTaskInProject,
  onOpenThread,
  onOpenThreadInNewWindow,
  onUndoArchive,
  onRetry,
  onOpenDiagnostics,
  onOpenSettings,
  mainContent,
  contentTitle = "Codex Desktop Linux",
  contentSubtitle,
  topbarAccessory,
  reconnect = null,
  onStopReconnect,
  offline = false,
  offlineSyncedAt = null,
  announcement = null,
  sidebarWidth = 288,
  onSidebarWidthChange,
}: ConnectionShellProps) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [groupThreads, setGroupThreads] = useState(false);
  const [threadActionsOpen, setThreadActionsOpen] = useState(false);
  const sidebarId = useId();
  const titleId = useId();
  const threadActionsMenuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const threadActionsRef = useRef<HTMLDivElement>(null);
  const threadActionsButtonRef = useRef<HTMLButtonElement>(null);
  const threadActionsMenuRef = useRef<HTMLDivElement>(null);
  const content = PHASE_CONTENT[phase];
  const isError = phase === "error";
  const [liveSidebarWidth, setLiveSidebarWidth] = useState(sidebarWidth);
  const resizeRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    if (resizeRef.current === null) {
      setLiveSidebarWidth(sidebarWidth);
    }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!threadActionsOpen) return;
    threadActionsMenuRef.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !threadActionsRef.current?.contains(event.target)) {
        setThreadActionsOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [threadActionsOpen]);

  useEffect(() => {
    if (threadListPhase !== "ready") {
      setThreadActionsOpen(false);
    }
  }, [threadListPhase]);


  useEffect(() => {
    if (!isSidebarOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsSidebarOpen(false);
        menuButtonRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSidebarOpen]);

  useEffect(() => {
    const handleNavigationShortcut = (event: KeyboardEvent) => {
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        document.querySelector('[aria-modal="true"]') !== null
      ) {
        return;
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        const narrow =
          typeof window.matchMedia === "function" &&
          window.matchMedia("(max-width: 1099px)").matches;
        if (narrow) {
          setIsSidebarOpen((open) => !open);
        } else {
          setIsSidebarCollapsed((collapsed) => !collapsed);
        }
        return;
      }
      if (phase !== "ready") {
        return;
      }
      if (event.key.toLowerCase() === "n" && onNewTask !== undefined) {
        event.preventDefault();
        onNewTask();
        return;
      }
      if (
        (event.key === "PageUp" || event.key === "PageDown") &&
        onOpenThread !== undefined
      ) {
        const threadId = adjacentThreadId(
          threads,
          currentThreadId,
          event.key === "PageDown" ? 1 : -1,
        );
        if (threadId !== null) {
          event.preventDefault();
          onOpenThread(threadId);
        }
      }
    };
    window.addEventListener("keydown", handleNavigationShortcut);
    return () => window.removeEventListener("keydown", handleNavigationShortcut);
  }, [currentThreadId, onNewTask, onOpenThread, phase, threads]);

  const closeSidebar = () => {
    setIsSidebarOpen(false);
    menuButtonRef.current?.focus();
  };

  const setSidebarWidth = (width: number) => {
    const bounded = Math.round(Math.min(420, Math.max(240, width)));
    if (resizeRef.current !== null) {
      resizeRef.current.width = bounded;
    }
    setLiveSidebarWidth(bounded);
    return bounded;
  };

  const handleThreadActionsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = items.length - 1;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setThreadActionsOpen(false);
      threadActionsButtonRef.current?.focus();
      return;
    }
    if (nextIndex !== null && items.length > 0) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  };

  return (
    <div
      className={styles.appShell}
      data-sidebar-collapsed={isSidebarCollapsed}
      style={{ "--sidebar-width": `${liveSidebarWidth}px` } as CSSProperties}
    >
      <button
        aria-label="关闭侧栏"
        className={styles.backdrop}
        data-visible={isSidebarOpen}
        onClick={closeSidebar}
        tabIndex={isSidebarOpen ? 0 : -1}
        type="button"
      />

      <aside
        aria-label="会话侧栏"
        className={styles.sidebar}
        data-open={isSidebarOpen}
        id={sidebarId}
      >
        <RecentThreads
          archivedThread={archivedThread}
          currentThreadId={currentThreadId}
          draftThreadIds={draftThreadIds}
          error={threadListError}
          grouped={groupThreads}
          hasMore={hasMoreThreads}
          sidebarToggle={
            <button
              aria-controls={sidebarId}
              aria-expanded={true}
              aria-label="隐藏侧栏"
              className={styles.sidebarInnerToggle}
              onClick={() => {
                if (isSidebarOpen) {
                  setIsSidebarOpen(false);
                } else {
                  setIsSidebarCollapsed(true);
                }
              }}
              type="button"
            >
              <SidebarCollapseIcon collapsed={false} />
            </button>
          }
          headerActions={
            <div className={styles.taskActions}>
              <button
                className={styles.newTaskButton}
                disabled={phase !== "ready" || onNewTask === undefined}
                onClick={() => {
                  onNewTask?.();
                  setIsSidebarOpen(false);
                }}
                title="新建任务（Ctrl+N）"
                type="button"
              >
                <ComposeIcon />
                <span className={styles.visuallyHidden}>新建任务</span>
              </button>
              <button
                aria-label={groupThreads ? "取消按项目分组" : "按项目分组"}
                aria-pressed={groupThreads}
                className={styles.groupButton}
                disabled={threadListPhase !== "ready"}
                onClick={() => setGroupThreads((grouped) => !grouped)}
                title={groupThreads ? "取消按项目分组" : "按项目分组"}
                type="button"
              >
                <GroupIcon />
              </button>
              <div className={styles.threadActions} ref={threadActionsRef}>
                <button
                  aria-controls={threadActionsOpen ? threadActionsMenuId : undefined}
                  aria-expanded={threadActionsOpen}
                  aria-haspopup="menu"
                  aria-label="最近会话操作"
                  className={styles.threadActionsButton}
                  data-refreshing={refreshingThreads}
                  disabled={
                    threadListPhase !== "ready" ||
                    (onSearchThreads === undefined && (
                      offline || refreshingThreads || onRefreshThreads === undefined
                    ))
                  }
                  onClick={() => setThreadActionsOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && threadActionsOpen) {
                      event.preventDefault();
                      setThreadActionsOpen(false);
                    }
                  }}
                  ref={threadActionsButtonRef}
                  title="最近会话操作"
                  type="button"
                >
                  {refreshingThreads ? <RefreshIcon /> : <MoreIcon />}
                </button>
                {threadActionsOpen ? (
                  <div
                    aria-label="最近会话操作"
                    className={styles.threadActionsMenu}
                    id={threadActionsMenuId}
                    onKeyDown={handleThreadActionsKeyDown}
                    ref={threadActionsMenuRef}
                    role="menu"
                  >
                    <button
                      disabled={onSearchThreads === undefined}
                      onClick={() => {
                        setThreadActionsOpen(false);
                        onSearchThreads?.();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <SearchIcon />
                      <span>搜索会话</span>
                      <small>Ctrl+K</small>
                    </button>
                    <button
                      data-refreshing={refreshingThreads}
                      disabled={offline || refreshingThreads || onRefreshThreads === undefined}
                      onClick={() => {
                        setThreadActionsOpen(false);
                        onRefreshThreads?.();
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <RefreshIcon />
                      <span>{refreshingThreads ? "正在刷新" : "刷新会话"}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          }
          loadingMore={loadingMoreThreads}
          onArchiveThread={(threadId) => onArchiveThread?.(threadId)}
          onDeleteThread={(threadId) => onDeleteThread?.(threadId)}
          onLoadMore={() => onLoadMoreThreads?.()}
          {...(onLoadProjectThreads === undefined
            ? {}
            : { onLoadProjectThreads })}
          {...(onNewTaskInProject === undefined
            ? {}
            : {
                onNewTaskInProject: (cwd: string) => {
                  onNewTaskInProject(cwd);
                  setIsSidebarOpen(false);
                },
              })}
          onOpenThread={(threadId) => {
            onOpenThread?.(threadId);
            setIsSidebarOpen(false);
          }}
          {...(onOpenThreadInNewWindow === undefined
            ? {}
            : { onOpenThreadInNewWindow })}
          onUndoArchive={() => onUndoArchive?.()}
          pendingThreadIds={pendingThreadIds}
          removingThreadIds={removingThreadIds}
          phase={threadListPhase}
          readOnly={offline}
          threads={threads}
        />

        <div className={styles.serverArea}>
          {serverControl ?? (
            <div className={styles.serverSummary}>
              <ServerIcon />
              <span className={styles.serverText}>
                <span>当前连接</span>
                <span className={styles.serverState}>{content.shortLabel}</span>
              </span>
              {phase === "ready" ? null : (
                <span
                  aria-hidden="true"
                  className={styles.statusDot}
                  data-connection-indicator
                  data-phase={phase}
                />
              )}
            </div>
          )}
        </div>
        <div
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemax={420}
          aria-valuemin={240}
          aria-valuenow={liveSidebarWidth}
          className={styles.sidebarResizeHandle}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
              return;
            }
            event.preventDefault();
            const width = setSidebarWidth(
              liveSidebarWidth + (event.key === "ArrowRight" ? 8 : -8),
            );
            onSidebarWidthChange?.(width);
          }}
          onPointerCancel={() => {
            resizeRef.current = null;
            setLiveSidebarWidth(sidebarWidth);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            resizeRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startWidth: liveSidebarWidth,
              width: liveSidebarWidth,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const resize = resizeRef.current;
            if (resize?.pointerId !== event.pointerId) {
              return;
            }
            setSidebarWidth(resize.startWidth + event.clientX - resize.startX);
          }}
          onPointerUp={(event) => {
            const resize = resizeRef.current;
            if (resize?.pointerId !== event.pointerId) {
              return;
            }
            resizeRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            onSidebarWidthChange?.(resize.width);
          }}
          role="separator"
          tabIndex={0}
          title="拖动或使用左右方向键调整侧栏宽度"
        />
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar} data-tauri-drag-region="deep">
          <WindowControls side="left" />
          {isSidebarCollapsed && (
            <button
              aria-controls={sidebarId}
              aria-expanded={false}
              aria-label="显示侧栏"
              className={styles.desktopSidebarButton}
              onClick={() => setIsSidebarCollapsed(false)}
              type="button"
            >
              <SidebarCollapseIcon collapsed={true} />
            </button>
          )}
          <button
            aria-controls={sidebarId}
            aria-expanded={isSidebarOpen}
            aria-label={isSidebarOpen ? "关闭侧栏" : "打开侧栏"}
            className={styles.menuButton}
            onClick={() => setIsSidebarOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            <SidebarCollapseIcon collapsed={!isSidebarOpen} />
          </button>
          <div className={styles.topbarTitle} title={`${contentSubtitle ?? content.eyebrow} / ${contentTitle}`}>
            <span className={styles.topbarSubtitle}>{contentSubtitle ?? content.eyebrow}</span>
            <span className={styles.topbarSeparator}>/</span>
            <strong>{contentTitle}</strong>
          </div>

          {topbarAccessory}
          {onOpenSettings ? (
            <button
              aria-label="打开设置"
              className={styles.settingsButton}
              onClick={onOpenSettings}
              title="设置 Ctrl+,"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
                <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
                <path d="m19.2 13.7 1.2 1.8-2.1 3.6-2.2-.2a8 8 0 0 1-1.7 1l-.9 2.1H9.3l-.9-2.1a8 8 0 0 1-1.7-1l-2.2.2-2.1-3.6 1.2-1.8a8 8 0 0 1 0-2l-1.2-1.8 2.1-3.6 2.2.2a8 8 0 0 1 1.7-1l.9-2.1h4.2l.9 2.1a8 8 0 0 1 1.7 1l2.2-.2 2.1 3.6-1.2 1.8a8 8 0 0 1 0 2Z" />
              </svg>
            </button>
          ) : null}
          <WindowControls side="right" />
          <span aria-live="polite" className={styles.visuallyHidden}>{announcement}</span>
        </header>

        {(phase === "ready" || offline) && mainContent !== undefined ? (
          <div className={styles.mainContent}>
            {offline ? (
              <div className={styles.offlineBanner} role="status">
                <span>{threadListPhase === "loading"
                  ? "正在同步服务端内容 · 当前内容只读"
                  : `连接已中断 · 当前内容只读${offlineSyncedAt === null ? "" : ` · 上次同步 ${new Date(offlineSyncedAt).toLocaleString()}`}`}</span>
                {threadListPhase !== "loading" && onRetry ? <button onClick={onRetry} type="button">立即重连</button> : null}
              </div>
            ) : null}
            {mainContent}
          </div>
        ) : (
        <section aria-labelledby={titleId} className={styles.connectionStage}>
          <div
            aria-live={isError ? "assertive" : "polite"}
            className={styles.connectionCard}
            role={isError ? "alert" : "status"}
          >
            <div className={styles.connectionMark} data-phase={phase}>
              <span aria-hidden="true" className={styles.spinner} />
            </div>

            <p className={styles.eyebrow}>{content.eyebrow}</p>
            <h1 id={titleId}>{content.title}</h1>
            <p className={styles.description}>
              {detail ?? content.description}
            </p>

            {!isError ? (
              <ol aria-label="连接进度" className={styles.steps}>
                {STEPS.map((step, index) => {
                  const stepState = getStepState(phase, index);
                  return (
                    <li data-state={stepState} key={step.key}>
                      <span aria-hidden="true" className={styles.stepIndicator}>
                        {stepState === "complete" ? "✓" : index + 1}
                      </span>
                      <span>{step.label}</span>
                      <span className={styles.stepStateText}>
                        {stepState === "complete"
                          ? "完成"
                          : stepState === "current"
                            ? "进行中"
                            : "等待"}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : null}

            {isError && (onRetry || onOpenDiagnostics || (reconnect !== null && onStopReconnect)) ? (
              <div className={styles.actions}>
                {onRetry ? (
                  <button
                    className={styles.primaryButton}
                    onClick={onRetry}
                    type="button"
                  >
                    {reconnect === null ? "重试连接" : "立即重试"}
                  </button>
                ) : null}
                {onOpenDiagnostics ? (
                  <button
                    className={styles.secondaryButton}
                    onClick={onOpenDiagnostics}
                    type="button"
                  >
                    查看诊断
                  </button>
                ) : null}
                {reconnect !== null && onStopReconnect ? (
                  <button
                    className={styles.secondaryButton}
                    onClick={onStopReconnect}
                    type="button"
                  >
                    停止重连
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
        )}
      </main>
    </div>
  );
}

export function adjacentThreadId(
  threads: readonly ThreadSummary[],
  currentThreadId: string | null,
  direction: 1 | -1,
): string | null {
  if (
    threads.length === 0 ||
    (threads.length === 1 && threads[0]?.id === currentThreadId)
  ) {
    return null;
  }
  const currentIndex = threads.findIndex(({ id }) => id === currentThreadId);
  if (currentIndex === -1) {
    return direction === 1 ? threads[0]?.id ?? null : threads.at(-1)?.id ?? null;
  }
  return threads[
    (currentIndex + direction + threads.length) % threads.length
  ]?.id ?? null;
}

const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();
