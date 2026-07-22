import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ServerNotification,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadTurnsListResponse,
  ThreadUnsubscribeResponse,
  ThreadArchiveResponse,
  ThreadUnarchiveResponse,
  ThreadDeleteResponse,
} from "../protocol/generated";
import type { ServerId } from "../configuration";
import { recordConversationProjection } from "../diagnostics/conversationLoadDiagnostics";

export type ServerThreadsPhase = "idle" | "loading" | "ready" | "error";
export type ThreadSummary = ThreadListResponse["data"][number];
export type ThreadTurn = ThreadTurnsListResponse["data"][number];

export interface RestoredThread {
  readonly metadata: ThreadResumeResponse["thread"];
  readonly turns: readonly ThreadTurn[];
  readonly nextCursor: string | null;
}

export interface ServerThreadsState {
  readonly threadListPhase: ServerThreadsPhase;
  readonly threadRestorePhase: ServerThreadsPhase;
  readonly threads: readonly ThreadSummary[];
  readonly nextThreadCursor: string | null;
  readonly restoredThread: RestoredThread | null;
  readonly loadingMoreThreads: boolean;
  readonly refreshingThreads: boolean;
  readonly loadingOlderTurns: boolean;
  readonly pendingThreadIds: readonly string[];
  readonly removingThreadIds: readonly string[];
  readonly currentThreadDeleted: boolean;
  readonly archivedThread: ThreadSummary | null;
  readonly threadListError: string | null;
  readonly threadRestoreError: string | null;
  readonly offline: boolean;
  readonly lastSyncedAt: number | null;
}

export interface ServerThreadsControls extends ServerThreadsState {
  readonly prepareStartedThread: (response: ThreadStartResponse) => () => void;
  readonly loadMoreThreads: () => Promise<void>;
  readonly loadProjectThreads: (
    cwd: string,
    limit: number,
  ) => Promise<ProjectThreadPage>;
  readonly refreshThreads: () => Promise<void>;
  readonly loadOlderTurns: () => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly undoArchive: () => Promise<boolean>;
  readonly deleteThread: (threadId: string) => Promise<boolean>;
}

export interface ProjectThreadPage {
  readonly hasMore: boolean;
}

interface ThreadRequest<T> {
  readonly result: Promise<T>;
}

export interface ServerThreadsClient {
  subscribeNotifications(
    handler: (notification: ServerNotification) => void,
  ): () => void;
  listRecentThreads(
    options?: {
      readonly archived?: boolean;
      readonly cursor?: string | null;
      readonly cwd?: string;
      readonly limit?: number;
    },
  ): ThreadRequest<ThreadListResponse>;
  readThread(threadId: string): ThreadRequest<ThreadReadResponse>;
  resumeThread(threadId: string): ThreadRequest<ThreadResumeResponse>;
  listOlderTurns(
    threadId: string,
    cursor: string,
  ): ThreadRequest<ThreadTurnsListResponse>;
  unsubscribeThread(threadId: string): ThreadRequest<ThreadUnsubscribeResponse>;
  archiveThread(threadId: string): ThreadRequest<ThreadArchiveResponse>;
  unarchiveThread(threadId: string): ThreadRequest<ThreadUnarchiveResponse>;
  deleteThread(threadId: string): ThreadRequest<ThreadDeleteResponse>;
}

const IDLE_STATE = Object.freeze({
  threadListPhase: "idle",
  threadRestorePhase: "idle",
  threads: Object.freeze([]),
  nextThreadCursor: null,
  restoredThread: null,
  loadingMoreThreads: false,
  refreshingThreads: false,
  loadingOlderTurns: false,
  pendingThreadIds: Object.freeze([]),
  removingThreadIds: Object.freeze([]),
  currentThreadDeleted: false,
  archivedThread: null,
  threadListError: null,
  threadRestoreError: null,
  offline: false,
  lastSyncedAt: null,
}) satisfies ServerThreadsState;

const THREAD_LIST_FAILED = "无法加载最近会话";
const THREAD_RESTORE_FAILED = "无法恢复当前会话";
const THREAD_PAGE_FAILED = "无法加载更多会话";
const THREAD_REFRESH_FAILED = "无法刷新最近会话";
const TURN_PAGE_FAILED = "无法加载更早历史";
const THREAD_ARCHIVE_FAILED = "无法归档会话";
const THREAD_UNARCHIVE_FAILED = "无法撤销归档";
const THREAD_DELETE_FAILED = "无法删除会话";
const THREAD_SYNC_FAILED = "无法同步其他窗口的会话变化";
const THREAD_REMOVAL_DURATION_MS = 200;

interface ActiveSource {
  readonly client: ServerThreadsClient;
  readonly currentThreadId: string | null;
}

interface PreparedStartedThread {
  readonly client: ServerThreadsClient;
  readonly restoredThread: RestoredThread;
}

interface RetainedSelection {
  readonly serverId: ServerId | null;
  readonly currentThreadId: string | null;
}

interface RetainedThreadList {
  readonly client: ServerThreadsClient;
  readonly serverId: ServerId | null;
}

export function useServerThreads(
  client: ServerThreadsClient | null,
  currentThreadId: string | null,
  serverId: ServerId | null = null,
): ServerThreadsControls {
  const [state, setState] = useState<ServerThreadsState>(IDLE_STATE);
  const sourceRef = useRef<ActiveSource | null>(null);
  const loadingThreadsRef = useRef<ActiveSource | null>(null);
  const refreshingThreadsRef = useRef<ActiveSource | null>(null);
  const loadingTurnsRef = useRef<ActiveSource | null>(null);
  const preparedStartedThreadRef = useRef<PreparedStartedThread | null>(null);
  const retainedSelectionRef = useRef<RetainedSelection | null>(null);
  const retainedThreadListRef = useRef<RetainedThreadList | null>(null);

  const prepareStartedThread = useCallback((response: ThreadStartResponse) => {
    if (client === null) {
      throw new TypeError("cannot prepare a started thread without a client");
    }
    const prepared = Object.freeze({
      client,
      restoredThread: Object.freeze({
        metadata: response.thread,
        turns: Object.freeze([]),
        nextCursor: null,
      }),
    });
    preparedStartedThreadRef.current = prepared;
    return () => {
      if (preparedStartedThreadRef.current === prepared) {
        preparedStartedThreadRef.current = null;
      }
    };
  }, [client]);

  useEffect(() => {
    loadingThreadsRef.current = null;
    refreshingThreadsRef.current = null;
    loadingTurnsRef.current = null;
    if (client === null) {
      sourceRef.current = null;
      const canRetainThreadList = matchesRetainedThreadList(
        retainedThreadListRef.current,
        serverId,
      );
      const canRetainSelection = matchesRetainedSelection(
        retainedSelectionRef.current,
        serverId,
        currentThreadId,
      );
      setState((current) => ({
        ...IDLE_STATE,
        threadListPhase: canRetainThreadList ? "ready" : "idle",
        threadRestorePhase: canRetainSelection ? "ready" : "idle",
        threads: canRetainThreadList ? current.threads : IDLE_STATE.threads,
        nextThreadCursor: canRetainThreadList
          ? current.nextThreadCursor
          : null,
        restoredThread: canRetainSelection ? current.restoredThread : null,
        currentThreadDeleted: canRetainSelection
          ? current.currentThreadDeleted
          : false,
        offline: canRetainThreadList || canRetainSelection,
        lastSyncedAt: canRetainThreadList ? current.lastSyncedAt : null,
      }));
      return;
    }

    const source: ActiveSource = { client, currentThreadId };
    sourceRef.current = source;
    const removalTimeouts = new Set<number>();
    const removedThreadIds = new Set<string>();
    const removeExternalThread = (threadId: string, deleted: boolean) => {
      removedThreadIds.add(threadId);
      setState((current) => {
        const currentDeleted =
          deleted && source.currentThreadId === threadId;
        if (current.threadListPhase !== "ready") {
          return currentDeleted
            ? {
                ...current,
                restoredThread: null,
                currentThreadDeleted: true,
              }
            : current;
        }
        if (
          current.pendingThreadIds.includes(threadId)
        ) {
          return current;
        }
        if (
          !currentDeleted &&
          !current.threads.some(({ id }) => id === threadId)
        ) {
          return current;
        }
        return {
          ...current,
          restoredThread: currentDeleted ? null : current.restoredThread,
          currentThreadDeleted:
            current.currentThreadDeleted || currentDeleted,
          pendingThreadIds: addPendingThread(
            current.pendingThreadIds,
            threadId,
          ),
          removingThreadIds: addPendingThread(
            current.removingThreadIds,
            threadId,
          ),
        };
      });
      const timeout = window.setTimeout(() => {
        removalTimeouts.delete(timeout);
        if (sourceRef.current !== source) {
          return;
        }
        setState((current) => {
          if (!current.removingThreadIds.includes(threadId)) {
            return current;
          }
          return {
            ...current,
            threads: Object.freeze(
              current.threads.filter(({ id }) => id !== threadId),
            ),
            pendingThreadIds: removePendingThread(
              current.pendingThreadIds,
              threadId,
            ),
            removingThreadIds: removePendingThread(
              current.removingThreadIds,
              threadId,
            ),
          };
        });
      }, THREAD_REMOVAL_DURATION_MS);
      removalTimeouts.add(timeout);
    };
    const restoreExternalThread = async (threadId: string) => {
      removedThreadIds.delete(threadId);
      try {
        const response = await source.client.readThread(threadId).result;
        if (sourceRef.current !== source) {
          return;
        }
        setState((current) =>
          current.threadListPhase === "ready" &&
          !current.pendingThreadIds.includes(threadId)
            ? {
                ...current,
                threads: insertThreadByRecency(
                  current.threads,
                  response.thread,
                ),
              }
            : current,
        );
      } catch {
        if (sourceRef.current === source) {
          setState((current) => ({
            ...current,
            threadListError: THREAD_SYNC_FAILED,
          }));
        }
      }
    };
    const releaseNotifications = client.subscribeNotifications(
      (notification) => {
        if (sourceRef.current !== source) {
          return;
        }
        switch (notification.method) {
          case "thread/started":
            removedThreadIds.delete(notification.params.thread.id);
            setState((current) =>
              current.threadListPhase === "ready"
                ? {
                    ...current,
                    threads: insertThreadByRecency(
                      current.threads,
                      notification.params.thread,
                    ),
                  }
                : current,
            );
            break;
          case "thread/name/updated":
            setState((current) =>
              updateThreadMetadata(
                current,
                notification.params.threadId,
                (thread) => ({
                  ...thread,
                  name: notification.params.threadName ?? null,
                }),
              ),
            );
            break;
          case "item/started": {
            const preview = userMessagePreview(notification.params.item);
            if (preview === null) {
              break;
            }
            setState((current) =>
              updateThreadMetadata(
                current,
                notification.params.threadId,
                (thread) =>
                  thread.preview.trim().length === 0
                    ? { ...thread, preview }
                    : thread,
              ),
            );
            break;
          }
          case "thread/status/changed":
            setState((current) =>
              updateThreadMetadata(
                current,
                notification.params.threadId,
                (thread) => ({
                  ...thread,
                  status: notification.params.status,
                }),
              ),
            );
            break;
          case "thread/archived":
            removeExternalThread(notification.params.threadId, false);
            break;
          case "thread/deleted":
            removeExternalThread(notification.params.threadId, true);
            break;
          case "thread/unarchived":
            void restoreExternalThread(notification.params.threadId);
            break;
        }
      },
    );
    const retainedThreadList = retainedThreadListRef.current;
    const canRetainThreadList = matchesRetainedThreadList(
      retainedThreadList,
      serverId,
    );
    const shouldLoadThreadList =
      !canRetainThreadList || retainedThreadList?.client !== client;
    const canRetainSelection = matchesRetainedSelection(
      retainedSelectionRef.current,
      serverId,
      currentThreadId,
    );
    const preparedStartedThread = preparedStartedThreadRef.current;
    const preparedRestoredThread =
      preparedStartedThread?.client === client &&
      preparedStartedThread.restoredThread.metadata.id === currentThreadId
        ? preparedStartedThread.restoredThread
        : null;
    if (preparedStartedThread !== null) {
      preparedStartedThreadRef.current = null;
    }
    const shouldRestoreThread =
      currentThreadId !== null && preparedRestoredThread === null;
    let threadListReconciled =
      !shouldLoadThreadList || !canRetainThreadList;
    let threadRestoreReconciled =
      !shouldRestoreThread || !canRetainSelection;
    const isReconcilingRetainedState = () =>
      !threadListReconciled || !threadRestoreReconciled;

    if (preparedRestoredThread !== null || currentThreadId === null) {
      retainedSelectionRef.current = { serverId, currentThreadId };
    }
    setState((current) => {
      const retainedThreads = canRetainThreadList
        ? current.threads
        : IDLE_STATE.threads;
      return {
        ...IDLE_STATE,
        threadListPhase: shouldLoadThreadList ? "loading" : "ready",
        threadRestorePhase: shouldRestoreThread ? "loading" : "ready",
        threads: preparedRestoredThread === null
          ? retainedThreads
          : insertThreadByRecency(
              retainedThreads,
              preparedRestoredThread.metadata,
            ),
        nextThreadCursor: canRetainThreadList
          ? current.nextThreadCursor
          : null,
        restoredThread:
          preparedRestoredThread ??
          (canRetainSelection ? current.restoredThread : null),
        currentThreadDeleted: canRetainSelection
          ? current.currentThreadDeleted
          : false,
        offline: isReconcilingRetainedState(),
        lastSyncedAt: canRetainThreadList ? current.lastSyncedAt : null,
      };
    });

    if (shouldLoadThreadList) {
      void Promise.resolve()
        .then(() => source.client.listRecentThreads().result)
        .then(
          (list) => {
            if (sourceRef.current !== source) {
              return;
            }
            threadListReconciled = true;
            retainedThreadListRef.current = { client, serverId };
            const listedThreads = list.data.filter(
              ({ id }) => !removedThreadIds.has(id),
            );
            setState((current) => {
              const restored = current.restoredThread;
              const threads =
                restored === null ||
                restored.metadata.id !== source.currentThreadId ||
                removedThreadIds.has(restored.metadata.id)
                  ? Object.freeze(listedThreads)
                  : insertThreadByRecency(listedThreads, restored.metadata);
              return {
                ...current,
                threadListPhase: "ready",
                threads,
                nextThreadCursor: list.nextCursor ?? null,
                threadListError: null,
                offline: isReconcilingRetainedState(),
                lastSyncedAt: Date.now(),
              };
            });
          },
          () => {
            if (sourceRef.current !== source) {
              return;
            }
            setState((current) => ({
              ...current,
              threadListPhase: canRetainThreadList ? "ready" : "error",
              threadListError: THREAD_LIST_FAILED,
              offline: isReconcilingRetainedState(),
            }));
          },
        );
    }

    if (shouldRestoreThread && currentThreadId !== null) {
      void Promise.resolve()
        .then(() => source.client.resumeThread(currentThreadId).result)
        .then((response) => restoredThreadFrom(response))
        .then(
          (restoredThread) => {
            if (sourceRef.current !== source) {
              return;
            }
            threadRestoreReconciled = true;
            retainedSelectionRef.current = { serverId, currentThreadId };
            const currentThreadWasDeleted = removedThreadIds.has(currentThreadId);
            setState((current) => ({
              ...current,
              threadRestorePhase: "ready",
              threads:
                currentThreadWasDeleted || current.threadListPhase !== "ready"
                  ? current.threads
                  : insertThreadByRecency(
                      current.threads,
                      restoredThread.metadata,
                    ),
              restoredThread: currentThreadWasDeleted ? null : restoredThread,
              currentThreadDeleted: currentThreadWasDeleted,
              threadRestoreError: null,
              offline: isReconcilingRetainedState(),
            }));
          },
          () => {
            if (sourceRef.current !== source) {
              return;
            }
            setState((current) => ({
              ...current,
              threadRestorePhase: canRetainSelection ? "ready" : "error",
              threadRestoreError: THREAD_RESTORE_FAILED,
              offline: isReconcilingRetainedState(),
            }));
          },
        );
    }

    return () => {
      releaseNotifications();
      for (const timeout of removalTimeouts) {
        window.clearTimeout(timeout);
      }
      if (currentThreadId !== null) {
        unsubscribeSafely(source.client, currentThreadId);
      }
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, [client, currentThreadId, serverId]);

  const loadMoreThreads = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    if (
      source === null ||
      state.threadListPhase !== "ready" ||
      state.offline ||
      loadingThreadsRef.current !== null ||
      state.nextThreadCursor === null
    ) {
      return;
    }
    loadingThreadsRef.current = source;
    const cursor = state.nextThreadCursor;
    setState((current) => ({
      ...current,
      loadingMoreThreads: true,
      threadListError: null,
    }));
    try {
      const page = await source.client.listRecentThreads({ cursor }).result;
      if (sourceRef.current !== source) {
        return;
      }
      setState((current) => ({
        ...current,
        threads: mergeUniqueById(current.threads, page.data),
        nextThreadCursor: page.nextCursor ?? null,
        loadingMoreThreads: false,
      }));
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          loadingMoreThreads: false,
          threadListError: THREAD_PAGE_FAILED,
        }));
      }
    } finally {
      if (loadingThreadsRef.current === source) {
        loadingThreadsRef.current = null;
      }
    }
  }, [state.nextThreadCursor, state.offline, state.threadListPhase]);

  const loadProjectThreads = useCallback(async (
    cwd: string,
    limit: number,
  ): Promise<ProjectThreadPage> => {
    const source = sourceRef.current;
    if (source === null || state.threadListPhase !== "ready" || state.offline) {
      throw new Error("project threads are unavailable");
    }
    const page = await source.client.listRecentThreads({ cwd, limit }).result;
    if (sourceRef.current !== source) {
      throw new Error("project thread request is stale");
    }
    setState((current) => ({
      ...current,
      threads: mergeUniqueById(current.threads, page.data),
    }));
    return { hasMore: page.nextCursor !== null && page.nextCursor !== undefined };
  }, [state.offline, state.threadListPhase]);

  const refreshThreads = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    if (
      source === null ||
      state.threadListPhase !== "ready" ||
      state.offline ||
      refreshingThreadsRef.current !== null
    ) {
      return;
    }
    refreshingThreadsRef.current = source;
    setState((current) => ({
      ...current,
      refreshingThreads: true,
      threadListError: null,
    }));
    try {
      const page = await source.client.listRecentThreads().result;
      if (sourceRef.current !== source) {
        return;
      }
      setState((current) => ({
        ...current,
        threads: mergeUniqueById(page.data, current.threads),
        nextThreadCursor: page.nextCursor ?? null,
        refreshingThreads: false,
        lastSyncedAt: Date.now(),
      }));
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          refreshingThreads: false,
          threadListError: THREAD_REFRESH_FAILED,
        }));
      }
    } finally {
      if (refreshingThreadsRef.current === source) {
        refreshingThreadsRef.current = null;
      }
    }
  }, [state.offline, state.threadListPhase]);

  const loadOlderTurns = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    const restored = state.restoredThread;
    if (
      source === null ||
      state.threadRestorePhase !== "ready" ||
      state.offline ||
      loadingTurnsRef.current !== null ||
      restored === null ||
      restored.nextCursor === null
    ) {
      return;
    }
    loadingTurnsRef.current = source;
    const cursor = restored.nextCursor;
    const threadId = restored.metadata.id;
    setState((current) => ({
      ...current,
      loadingOlderTurns: true,
      threadRestoreError: null,
    }));
    try {
      const page = await source.client.listOlderTurns(threadId, cursor).result;
      if (sourceRef.current !== source) {
        return;
      }
      setState((current) => {
        const active = current.restoredThread;
        if (active === null || active.metadata.id !== threadId) {
          return current;
        }
        return {
          ...current,
          restoredThread: Object.freeze({
            ...active,
            turns: prependOlderTurns(active.turns, page.data),
            nextCursor: page.nextCursor ?? null,
          }),
          loadingOlderTurns: false,
        };
      });
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          loadingOlderTurns: false,
          threadRestoreError: TURN_PAGE_FAILED,
        }));
      }
    } finally {
      if (loadingTurnsRef.current === source) {
        loadingTurnsRef.current = null;
      }
    }
  }, [state.offline, state.restoredThread, state.threadRestorePhase]);

  const archiveThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const source = sourceRef.current;
      const threadIndex = state.threads.findIndex(({ id }) => id === threadId);
      if (
        source === null ||
        state.threadListPhase !== "ready" ||
        state.offline ||
        threadIndex < 0 ||
        state.pendingThreadIds.includes(threadId)
      ) {
        return false;
      }
      const thread = state.threads[threadIndex];
      if (thread === undefined) {
        return false;
      }
      setState((current) => ({
        ...current,
        pendingThreadIds: addPendingThread(current.pendingThreadIds, threadId),
        threadListError: null,
      }));
      try {
        await source.client.archiveThread(threadId).result;
        if (sourceRef.current !== source) {
          return false;
        }
        setState((current) => ({
          ...current,
          removingThreadIds: addPendingThread(
            current.removingThreadIds,
            threadId,
          ),
        }));
        await waitForThreadRemoval();
        if (sourceRef.current !== source) {
          return false;
        }
        setState((current) => ({
          ...current,
          threads: Object.freeze(current.threads.filter(({ id }) => id !== threadId)),
          pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
          removingThreadIds: removePendingThread(
            current.removingThreadIds,
            threadId,
          ),
          archivedThread: thread,
        }));
        return true;
      } catch {
        if (sourceRef.current === source) {
          setState((current) => ({
            ...current,
            pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
            removingThreadIds: removePendingThread(
              current.removingThreadIds,
              threadId,
            ),
            threadListError: THREAD_ARCHIVE_FAILED,
          }));
        }
        return false;
      }
    },
    [state.offline, state.pendingThreadIds, state.threadListPhase, state.threads],
  );

  const undoArchive = useCallback(async (): Promise<boolean> => {
    const source = sourceRef.current;
    const thread = state.archivedThread;
    if (
      source === null ||
      state.threadListPhase !== "ready" ||
      state.offline ||
      thread === null ||
      state.pendingThreadIds.includes(thread.id)
    ) {
      return false;
    }
    setState((current) => ({
      ...current,
      pendingThreadIds: addPendingThread(current.pendingThreadIds, thread.id),
      threadListError: null,
    }));
    try {
      const response = await source.client.unarchiveThread(thread.id).result;
      if (sourceRef.current !== source) {
        return false;
      }
      setState((current) => ({
        ...current,
        threads: insertThreadByRecency(current.threads, response.thread),
        pendingThreadIds: removePendingThread(current.pendingThreadIds, thread.id),
        archivedThread: null,
      }));
      return true;
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          pendingThreadIds: removePendingThread(current.pendingThreadIds, thread.id),
          threadListError: THREAD_UNARCHIVE_FAILED,
        }));
      }
      return false;
    }
  }, [
    state.archivedThread,
    state.offline,
    state.pendingThreadIds,
    state.threadListPhase,
  ]);

  const deleteThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const source = sourceRef.current;
      if (
        source === null ||
        state.threadListPhase !== "ready" ||
        state.offline ||
        !state.threads.some(({ id }) => id === threadId) ||
        state.pendingThreadIds.includes(threadId)
      ) {
        return false;
      }
      setState((current) => ({
        ...current,
        pendingThreadIds: addPendingThread(current.pendingThreadIds, threadId),
        threadListError: null,
      }));
      try {
        await source.client.deleteThread(threadId).result;
        if (sourceRef.current !== source) {
          return false;
        }
        setState((current) => ({
          ...current,
          removingThreadIds: addPendingThread(
            current.removingThreadIds,
            threadId,
          ),
        }));
        await waitForThreadRemoval();
        if (sourceRef.current !== source) {
          return false;
        }
        setState((current) => ({
          ...current,
          threads: Object.freeze(current.threads.filter(({ id }) => id !== threadId)),
          pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
          removingThreadIds: removePendingThread(
            current.removingThreadIds,
            threadId,
          ),
          archivedThread:
            current.archivedThread?.id === threadId ? null : current.archivedThread,
        }));
        return true;
      } catch {
        if (sourceRef.current === source) {
          setState((current) => ({
            ...current,
            pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
            removingThreadIds: removePendingThread(
              current.removingThreadIds,
              threadId,
            ),
            threadListError: THREAD_DELETE_FAILED,
          }));
        }
        return false;
      }
    },
    [state.offline, state.pendingThreadIds, state.threadListPhase, state.threads],
  );

  return {
    ...state,
    prepareStartedThread,
    loadMoreThreads,
    loadProjectThreads,
    refreshThreads,
    loadOlderTurns,
    archiveThread,
    undoArchive,
    deleteThread,
  };
}

function updateThreadMetadata(
  state: ServerThreadsState,
  threadId: string,
  update: (thread: ThreadSummary) => ThreadSummary,
): ServerThreadsState {
  if (state.threadListPhase !== "ready") {
    return state;
  }
  let changed = false;
  const threads = state.threads.map((thread) => {
    if (thread.id !== threadId) {
      return thread;
    }
    changed = true;
    return update(thread);
  });
  const restored = state.restoredThread;
  const restoredThread =
    restored?.metadata.id === threadId
      ? Object.freeze({ ...restored, metadata: update(restored.metadata) })
      : restored;
  if (!changed && restoredThread === restored) {
    return state;
  }
  return {
    ...state,
    threads: changed ? Object.freeze(threads) : state.threads,
    restoredThread,
  };
}

function userMessagePreview(
  item: Extract<ServerNotification, { method: "item/started" }>["params"]["item"],
): string | null {
  if (item.type !== "userMessage") {
    return null;
  }
  const preview = item.content.map((input) => {
    switch (input.type) {
      case "text":
        return input.text;
      case "skill":
        return `$${input.name}`;
      case "mention":
        return `@${input.name}`;
      case "image":
        return "[图片]";
      case "localImage": {
        const name = input.path.split(/[\\/]/u).at(-1) || "图片";
        return `[图片 ${name}]`;
      }
    }
  }).join("\n").trim();
  return preview.length === 0 ? null : preview;
}

function addPendingThread(existing: readonly string[], threadId: string): readonly string[] {
  return existing.includes(threadId) ? existing : Object.freeze([...existing, threadId]);
}

function removePendingThread(existing: readonly string[], threadId: string): readonly string[] {
  return Object.freeze(existing.filter((id) => id !== threadId));
}

function waitForThreadRemoval(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, THREAD_REMOVAL_DURATION_MS);
  });
}

function insertThreadByRecency(
  existing: readonly ThreadSummary[],
  thread: ThreadSummary,
): readonly ThreadSummary[] {
  const withoutThread = existing.filter(({ id }) => id !== thread.id);
  const index = withoutThread.findIndex(({ updatedAt }) => updatedAt < thread.updatedAt);
  const insertionIndex = index < 0 ? withoutThread.length : index;
  return Object.freeze([
    ...withoutThread.slice(0, insertionIndex),
    thread,
    ...withoutThread.slice(insertionIndex),
  ]);
}

function unsubscribeSafely(client: ServerThreadsClient, threadId: string): void {
  try {
    void client.unsubscribeThread(threadId).result.catch(() => undefined);
  } catch {
    // 清理失败由连接诊断记录，不覆盖新会话的加载状态
  }
}

function matchesRetainedSelection(
  retained: RetainedSelection | null,
  serverId: ServerId | null,
  currentThreadId: string | null,
): boolean {
  return retained !== null &&
    retained.serverId === serverId &&
    retained.currentThreadId === currentThreadId;
}

function matchesRetainedThreadList(
  retained: RetainedThreadList | null,
  serverId: ServerId | null,
): retained is RetainedThreadList {
  return retained !== null && retained.serverId === serverId;
}

function restoredThreadFrom(response: ThreadResumeResponse): RestoredThread {
  const projectionStartedAt = performance.now();
  const initialPage = response.initialTurnsPage;
  if (initialPage === undefined || initialPage === null) {
    throw new TypeError("missing initial turns page");
  }
  const restoredThread = Object.freeze({
    metadata: response.thread,
    turns: Object.freeze([...initialPage.data].reverse()),
    nextCursor: initialPage.nextCursor ?? null,
  });
  recordConversationProjection(
    response.thread,
    performance.now() - projectionStartedAt,
  );
  return restoredThread;
}

function mergeUniqueById<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  const known = new Set(existing.map(({ id }) => id));
  const merged = [...existing];
  for (const item of incoming) {
    if (!known.has(item.id)) {
      known.add(item.id);
      merged.push(item);
    }
  }
  return Object.freeze(merged);
}

function prependOlderTurns(
  existing: readonly ThreadTurn[],
  descendingPage: readonly ThreadTurn[],
): readonly ThreadTurn[] {
  const known = new Set(existing.map(({ id }) => id));
  const older: ThreadTurn[] = [];
  for (const turn of descendingPage.toReversed()) {
    if (!known.has(turn.id)) {
      known.add(turn.id);
      older.push(turn);
    }
  }
  return Object.freeze([...older, ...existing]);
}
