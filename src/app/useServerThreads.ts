import { useCallback, useEffect, useRef, useState } from "react";

import { PINNED_THREAD_SECTION_ID } from "../appServer/threadClient";
import type { ServerId } from "../configuration";
import { recordConversationProjection } from "../diagnostics/conversationLoadDiagnostics";
import type {
  ServerNotification,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
  ThreadItemsListResponse,
  ThreadStartResponse,
  ThreadUnsubscribeResponse,
  ThreadArchiveResponse,
  ThreadUnarchiveResponse,
  ThreadDeleteResponse,
  ThreadSectionMoveResponse,
} from "../protocol/generated";

export type ServerThreadsPhase = "idle" | "loading" | "ready" | "error";
export type ThreadSummary = ThreadListResponse["data"][number];
type ServerThreadTurn = ThreadResumeResponse["thread"]["turns"][number];
export type ThreadTurn = ServerThreadTurn & {
  readonly clientItemsView?: "partial";
};

export interface ThreadModelSettings {
  readonly model: string;
  readonly effort: string | null;
  readonly serviceTier: string | null;
}

export interface RestoredThread {
  readonly metadata: ThreadResumeResponse["thread"];
  readonly modelSettings: ThreadModelSettings;
  readonly turns: readonly ThreadTurn[];
}

export interface ServerThreadsState {
  readonly threadListPhase: ServerThreadsPhase;
  readonly threadRestorePhase: ServerThreadsPhase;
  readonly resumedThreadId: string | null;
  readonly threads: readonly ThreadSummary[];
  readonly pinnedThreads: readonly ThreadSummary[];
  readonly nextThreadCursor: string | null;
  readonly nextPinnedThreadCursor: string | null;
  readonly restoredThread: RestoredThread | null;
  readonly loadingMoreThreads: boolean;
  readonly loadingMorePinnedThreads: boolean;
  readonly refreshingThreads: boolean;
  readonly pendingThreadIds: readonly string[];
  readonly removingThreadIds: readonly string[];
  readonly currentThreadDeleted: boolean;
  readonly threadListError: string | null;
  readonly threadRestoreError: string | null;
  readonly offline: boolean;
  readonly pinningAvailable: boolean;
  readonly lastSyncedAt: number | null;
}

export interface ServerThreadsControls extends ServerThreadsState {
  readonly archiveNotices: readonly ThreadSummary[];
  readonly archivedThreadListError: string | null;
  readonly archivedThreadListPhase: ServerThreadsPhase;
  readonly archivedThreads: readonly ThreadSummary[];
  readonly loadingMoreArchivedThreads: boolean;
  readonly nextArchivedThreadCursor: string | null;
  readonly refreshingArchivedThreads: boolean;
  readonly prepareStartedThread: (response: ThreadStartResponse) => () => void;
  readonly dismissArchiveNotice: (threadId: string) => void;
  readonly loadArchivedThreads: () => Promise<void>;
  readonly loadMoreArchivedThreads: () => Promise<void>;
  readonly loadMoreThreads: () => Promise<void>;
  readonly loadMorePinnedThreads: () => Promise<void>;
  readonly loadProjectThreads: (
    cwd: string,
    limit: number,
  ) => Promise<ProjectThreadPage>;
  readonly refreshArchivedThreads: () => Promise<void>;
  readonly refreshThreads: () => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly unarchiveThread: (threadId: string) => Promise<boolean>;
  readonly deleteThread: (threadId: string) => Promise<boolean>;
  readonly setThreadPinned: (
    threadId: string,
    pinned: boolean,
  ) => Promise<boolean>;
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
  listPinnedThreads(cursor?: string | null): ThreadRequest<ThreadListResponse>;
  readThread(threadId: string): ThreadRequest<ThreadReadResponse>;
  resumeThread(threadId: string): ThreadRequest<ThreadResumeResponse>;
  listThreadTurns(
    threadId: string,
    cursor: string,
  ): ThreadRequest<ThreadTurnsListResponse>;
  listThreadItems(
    threadId: string,
    turnId: string,
    cursor?: string | null,
  ): ThreadRequest<ThreadItemsListResponse>;
  unsubscribeThread(threadId: string): ThreadRequest<ThreadUnsubscribeResponse>;
  archiveThread(threadId: string): ThreadRequest<ThreadArchiveResponse>;
  unarchiveThread(threadId: string): ThreadRequest<ThreadUnarchiveResponse>;
  deleteThread(threadId: string): ThreadRequest<ThreadDeleteResponse>;
  setThreadPinned(
    threadId: string,
    pinned: boolean,
    beforeThreadId?: string | null,
  ): ThreadRequest<ThreadSectionMoveResponse>;
}

const IDLE_STATE = Object.freeze({
  threadListPhase: "idle",
  threadRestorePhase: "idle",
  resumedThreadId: null,
  threads: Object.freeze([]),
  pinnedThreads: Object.freeze([]),
  nextThreadCursor: null,
  nextPinnedThreadCursor: null,
  restoredThread: null,
  loadingMoreThreads: false,
  loadingMorePinnedThreads: false,
  refreshingThreads: false,
  pendingThreadIds: Object.freeze([]),
  removingThreadIds: Object.freeze([]),
  currentThreadDeleted: false,
  threadListError: null,
  threadRestoreError: null,
  offline: false,
  pinningAvailable: false,
  lastSyncedAt: null,
}) satisfies ServerThreadsState;

interface ArchivedThreadListState {
  readonly archivedThreadListError: string | null;
  readonly archivedThreadListPhase: ServerThreadsPhase;
  readonly archivedThreads: readonly ThreadSummary[];
  readonly loadingMoreArchivedThreads: boolean;
  readonly nextArchivedThreadCursor: string | null;
  readonly refreshingArchivedThreads: boolean;
}

const IDLE_ARCHIVED_THREAD_LIST_STATE = Object.freeze({
  archivedThreadListError: null,
  archivedThreadListPhase: "idle",
  archivedThreads: Object.freeze([]),
  loadingMoreArchivedThreads: false,
  nextArchivedThreadCursor: null,
  refreshingArchivedThreads: false,
}) satisfies ArchivedThreadListState;

const THREAD_LIST_FAILED = "无法加载最近会话";
const THREAD_RESTORE_FAILED = "无法恢复当前会话";
const THREAD_PAGE_FAILED = "无法加载更多会话";
const THREAD_REFRESH_FAILED = "无法刷新最近会话";
const ARCHIVED_THREAD_LIST_FAILED = "无法加载已归档会话";
const ARCHIVED_THREAD_PAGE_FAILED = "无法加载更多已归档会话";
const ARCHIVED_THREAD_REFRESH_FAILED = "无法刷新已归档会话";
const THREAD_ARCHIVE_FAILED = "无法归档会话";
const THREAD_UNARCHIVE_FAILED = "无法撤销归档";
const THREAD_DELETE_FAILED = "无法删除会话";
const THREAD_PIN_FAILED = "无法置顶会话";
const THREAD_UNPIN_FAILED = "无法取消置顶";
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
  const [archivedState, setArchivedState] = useState<ArchivedThreadListState>(
    IDLE_ARCHIVED_THREAD_LIST_STATE,
  );
  const [archiveNotices, setArchiveNotices] = useState<readonly ThreadSummary[]>(
    Object.freeze([]),
  );
  const sourceRef = useRef<ActiveSource | null>(null);
  const currentClientRef = useRef(client);
  currentClientRef.current = client;
  const loadingThreadsRef = useRef<ActiveSource | null>(null);
  const loadingPinnedThreadsRef = useRef<ActiveSource | null>(null);
  const refreshingThreadsRef = useRef<ActiveSource | null>(null);
  const loadingArchivedThreadsRef = useRef<ServerThreadsClient | null>(null);
  const refreshingArchivedThreadsRef = useRef<ServerThreadsClient | null>(null);
  const archivedListClientRef = useRef<ServerThreadsClient | null>(null);
  const archivedListServerIdRef = useRef<ServerId | null>(serverId);
  const archiveNoticesClientRef = useRef(client);
  const threadsRef = useRef(state.threads);
  threadsRef.current = state.threads;
  const preparedStartedThreadRef = useRef<PreparedStartedThread | null>(null);
  const retainedSelectionRef = useRef<RetainedSelection | null>(null);
  const retainedThreadListRef = useRef<RetainedThreadList | null>(null);

  useEffect(() => {
    loadingArchivedThreadsRef.current = null;
    refreshingArchivedThreadsRef.current = null;

    if (archiveNoticesClientRef.current !== client) {
      archiveNoticesClientRef.current = client;
      setArchiveNotices(Object.freeze([]));
    }

    if (archivedListServerIdRef.current !== serverId) {
      archivedListServerIdRef.current = serverId;
      archivedListClientRef.current = null;
      setArchivedState(IDLE_ARCHIVED_THREAD_LIST_STATE);
      return;
    }

    if (client === null) {
      setArchivedState((current) => ({
        ...current,
        archivedThreadListPhase:
          archivedListClientRef.current === null ? "idle" : "ready",
        loadingMoreArchivedThreads: false,
        refreshingArchivedThreads: false,
      }));
      return;
    }

    if (archivedListClientRef.current !== client) {
      setArchivedState((current) => ({
        ...current,
        archivedThreadListError: null,
        archivedThreadListPhase: "idle",
        loadingMoreArchivedThreads: false,
        refreshingArchivedThreads: false,
      }));
    }
  }, [client, serverId]);

  const prepareStartedThread = useCallback((response: ThreadStartResponse) => {
    if (client === null) {
      throw new TypeError("cannot prepare a started thread without a client");
    }
    const prepared = Object.freeze({
      client,
      restoredThread: Object.freeze({
        metadata: response.thread,
        modelSettings: modelSettingsFrom(response),
        turns: Object.freeze([]),
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
    loadingPinnedThreadsRef.current = null;
    refreshingThreadsRef.current = null;
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
        pinnedThreads: canRetainThreadList
          ? current.pinnedThreads
          : IDLE_STATE.pinnedThreads,
        nextThreadCursor: canRetainThreadList
          ? current.nextThreadCursor
          : null,
        nextPinnedThreadCursor: canRetainThreadList
          ? current.nextPinnedThreadCursor
          : null,
        restoredThread: canRetainSelection ? current.restoredThread : null,
        currentThreadDeleted: canRetainSelection
          ? current.currentThreadDeleted
          : false,
        offline: canRetainThreadList || canRetainSelection,
        pinningAvailable: canRetainThreadList && current.pinningAvailable,
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
          resumedThreadId: currentDeleted ? null : current.resumedThreadId,
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
            pinnedThreads: removeThreadById(current.pinnedThreads, threadId),
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
                pinnedThreads: isPinnedThread(response.thread)
                  ? appendThread(current.pinnedThreads, response.thread)
                  : current.pinnedThreads,
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
            setArchivedState((current) =>
              updateArchivedThreadMetadata(
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
          case "thread/settings/updated":
            setState((current) => {
              if (
                current.restoredThread?.metadata.id !== notification.params.threadId
              ) {
                return current;
              }
              return {
                ...current,
                restoredThread: Object.freeze({
                  ...current.restoredThread,
                  modelSettings: Object.freeze({
                    effort: notification.params.threadSettings.effort ?? null,
                    model: notification.params.threadSettings.model,
                    serviceTier: notification.params.threadSettings.serviceTier ?? null,
                  }),
                }),
              };
            });
            break;
          case "thread/archived":
            {
              const thread = threadsRef.current.find(
                ({ id }) => id === notification.params.threadId,
              );
              if (thread !== undefined) {
                setArchivedState((current) =>
                  insertLoadedArchivedThread(current, thread),
                );
              }
            }
            removeExternalThread(notification.params.threadId, false);
            break;
          case "thread/deleted":
            setArchivedState((current) =>
              removeArchivedThread(current, notification.params.threadId),
            );
            setArchiveNotices((current) =>
              removeThreadById(current, notification.params.threadId),
            );
            removeExternalThread(notification.params.threadId, true);
            break;
          case "thread/unarchived":
            setArchivedState((current) =>
              removeArchivedThread(current, notification.params.threadId),
            );
            setArchiveNotices((current) =>
              removeThreadById(current, notification.params.threadId),
            );
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
        pinnedThreads: canRetainThreadList
          ? current.pinnedThreads
          : IDLE_STATE.pinnedThreads,
        nextPinnedThreadCursor: canRetainThreadList
          ? current.nextPinnedThreadCursor
          : null,
        pinningAvailable: canRetainThreadList && current.pinningAvailable,
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
              const listedWithPinned = mergeThreadsByRecency(
                listedThreads,
                current.pinnedThreads,
              );
              const threads =
                restored === null ||
                restored.metadata.id !== source.currentThreadId ||
                removedThreadIds.has(restored.metadata.id)
                  ? listedWithPinned
                  : insertThreadByRecency(listedWithPinned, restored.metadata);
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

      void Promise.resolve()
        .then(() => source.client.listPinnedThreads().result)
        .then(
          (list) => {
            if (sourceRef.current !== source) {
              return;
            }
            const pinnedThreads = list.data.filter(
              ({ id }) => !removedThreadIds.has(id),
            );
            setState((current) => ({
              ...current,
              threads: mergeThreadsByRecency(current.threads, pinnedThreads),
              pinnedThreads: Object.freeze(pinnedThreads),
              nextPinnedThreadCursor: list.nextCursor ?? null,
              pinningAvailable: true,
            }));
          },
          () => {
            if (sourceRef.current !== source) {
              return;
            }
            setState((current) => ({
              ...current,
              pinnedThreads: IDLE_STATE.pinnedThreads,
              nextPinnedThreadCursor: null,
              pinningAvailable: false,
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
              resumedThreadId: currentThreadWasDeleted ? null : currentThreadId,
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

  const loadArchivedThreads = useCallback(async (): Promise<void> => {
    const requestClient = client;
    if (
      requestClient === null ||
      state.offline ||
      loadingArchivedThreadsRef.current !== null
    ) {
      return;
    }
    loadingArchivedThreadsRef.current = requestClient;
    setArchivedState((current) => ({
      ...current,
      archivedThreadListError: null,
      archivedThreadListPhase: "loading",
      loadingMoreArchivedThreads: false,
    }));
    try {
      const page = await requestClient.listRecentThreads({ archived: true }).result;
      if (currentClientRef.current !== requestClient) {
        return;
      }
      archivedListClientRef.current = requestClient;
      setArchivedState((current) => ({
        ...current,
        archivedThreadListError: null,
        archivedThreadListPhase: "ready",
        archivedThreads: Object.freeze(page.data),
        nextArchivedThreadCursor: page.nextCursor ?? null,
      }));
    } catch {
      if (currentClientRef.current === requestClient) {
        setArchivedState((current) => ({
          ...current,
          archivedThreadListError: ARCHIVED_THREAD_LIST_FAILED,
          archivedThreadListPhase:
            current.archivedThreads.length === 0 ? "error" : "ready",
        }));
      }
    } finally {
      if (loadingArchivedThreadsRef.current === requestClient) {
        loadingArchivedThreadsRef.current = null;
      }
    }
  }, [client, state.offline]);

  const loadMoreArchivedThreads = useCallback(async (): Promise<void> => {
    const requestClient = client;
    const cursor = archivedState.nextArchivedThreadCursor;
    if (
      requestClient === null ||
      state.offline ||
      archivedState.archivedThreadListPhase !== "ready" ||
      loadingArchivedThreadsRef.current !== null ||
      cursor === null
    ) {
      return;
    }
    loadingArchivedThreadsRef.current = requestClient;
    setArchivedState((current) => ({
      ...current,
      archivedThreadListError: null,
      loadingMoreArchivedThreads: true,
    }));
    try {
      const page = await requestClient.listRecentThreads({
        archived: true,
        cursor,
      }).result;
      if (currentClientRef.current !== requestClient) {
        return;
      }
      setArchivedState((current) => ({
        ...current,
        archivedThreads: mergeUniqueById(current.archivedThreads, page.data),
        loadingMoreArchivedThreads: false,
        nextArchivedThreadCursor: page.nextCursor ?? null,
      }));
    } catch {
      if (currentClientRef.current === requestClient) {
        setArchivedState((current) => ({
          ...current,
          archivedThreadListError: ARCHIVED_THREAD_PAGE_FAILED,
          loadingMoreArchivedThreads: false,
        }));
      }
    } finally {
      if (loadingArchivedThreadsRef.current === requestClient) {
        loadingArchivedThreadsRef.current = null;
      }
    }
  }, [
    archivedState.archivedThreadListPhase,
    archivedState.nextArchivedThreadCursor,
    client,
    state.offline,
  ]);

  const refreshArchivedThreads = useCallback(async (): Promise<void> => {
    const requestClient = client;
    if (
      requestClient === null ||
      state.offline ||
      archivedState.archivedThreadListPhase !== "ready" ||
      refreshingArchivedThreadsRef.current !== null
    ) {
      return;
    }
    refreshingArchivedThreadsRef.current = requestClient;
    setArchivedState((current) => ({
      ...current,
      archivedThreadListError: null,
      refreshingArchivedThreads: true,
    }));
    try {
      const page = await requestClient.listRecentThreads({ archived: true }).result;
      if (currentClientRef.current !== requestClient) {
        return;
      }
      setArchivedState((current) => ({
        ...current,
        archivedThreads: mergeUniqueById(page.data, current.archivedThreads),
        nextArchivedThreadCursor: page.nextCursor ?? null,
        refreshingArchivedThreads: false,
      }));
    } catch {
      if (currentClientRef.current === requestClient) {
        setArchivedState((current) => ({
          ...current,
          archivedThreadListError: ARCHIVED_THREAD_REFRESH_FAILED,
          refreshingArchivedThreads: false,
        }));
      }
    } finally {
      if (refreshingArchivedThreadsRef.current === requestClient) {
        refreshingArchivedThreadsRef.current = null;
      }
    }
  }, [archivedState.archivedThreadListPhase, client, state.offline]);

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

  const loadMorePinnedThreads = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    if (
      source === null ||
      state.threadListPhase !== "ready" ||
      state.offline ||
      !state.pinningAvailable ||
      loadingPinnedThreadsRef.current !== null ||
      state.nextPinnedThreadCursor === null
    ) {
      return;
    }
    loadingPinnedThreadsRef.current = source;
    const cursor = state.nextPinnedThreadCursor;
    setState((current) => ({
      ...current,
      loadingMorePinnedThreads: true,
      threadListError: null,
    }));
    try {
      const page = await source.client.listPinnedThreads(cursor).result;
      if (sourceRef.current !== source) {
        return;
      }
      setState((current) => ({
        ...current,
        loadingMorePinnedThreads: false,
        nextPinnedThreadCursor: page.nextCursor ?? null,
        pinnedThreads: mergeUniqueById(current.pinnedThreads, page.data),
        threads: mergeThreadsByRecency(current.threads, page.data),
      }));
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          loadingMorePinnedThreads: false,
          threadListError: THREAD_PAGE_FAILED,
        }));
      }
    } finally {
      if (loadingPinnedThreadsRef.current === source) {
        loadingPinnedThreadsRef.current = null;
      }
    }
  }, [
    state.nextPinnedThreadCursor,
    state.offline,
    state.pinningAvailable,
    state.threadListPhase,
  ]);

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
      const [page, pinnedPage] = await Promise.all([
        source.client.listRecentThreads().result,
        source.client.listPinnedThreads().result.then(
          (result) => result,
          () => null,
        ),
      ]);
      if (sourceRef.current !== source) {
        return;
      }
      setState((current) => {
        const refreshedThreads = mergeUniqueById(page.data, current.threads);
        return {
          ...current,
          threads: pinnedPage === null
            ? refreshedThreads
            : mergeThreadsByRecency(refreshedThreads, pinnedPage.data),
          pinnedThreads: pinnedPage === null
            ? current.pinnedThreads
            : Object.freeze(pinnedPage.data),
          nextThreadCursor: page.nextCursor ?? null,
          nextPinnedThreadCursor: pinnedPage === null
            ? current.nextPinnedThreadCursor
            : pinnedPage.nextCursor ?? null,
          pinningAvailable: current.pinningAvailable || pinnedPage !== null,
          refreshingThreads: false,
          lastSyncedAt: Date.now(),
        };
      });
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

  const setThreadPinned = useCallback(async (
    threadId: string,
    pinned: boolean,
  ): Promise<boolean> => {
    const source = sourceRef.current;
    const currentlyPinned = state.pinnedThreads.some(
      ({ id }) => id === threadId,
    );
    if (
      source === null ||
      state.threadListPhase !== "ready" ||
      state.offline ||
      !state.pinningAvailable ||
      !state.threads.some(({ id }) => id === threadId) ||
      state.pendingThreadIds.includes(threadId) ||
      currentlyPinned === pinned
    ) {
      return false;
    }
    setState((current) => ({
      ...current,
      pendingThreadIds: addPendingThread(current.pendingThreadIds, threadId),
      threadListError: null,
    }));
    try {
      await source.client.setThreadPinned(
        threadId,
        pinned,
        pinned ? state.pinnedThreads[0]?.id ?? null : null,
      ).result;
      const response = await source.client.readThread(threadId).result;
      if (sourceRef.current !== source) {
        return false;
      }
      setState((current) => {
        const nowPinned = isPinnedThread(response.thread);
        return {
          ...current,
          threads: insertThreadByRecency(current.threads, response.thread),
          pinnedThreads: nowPinned
            ? pinned
              ? Object.freeze([
                  response.thread,
                  ...current.pinnedThreads.filter(({ id }) => id !== threadId),
                ])
              : replaceThreadInOrder(current.pinnedThreads, response.thread)
            : removeThreadById(current.pinnedThreads, threadId),
          restoredThread: replaceRestoredThreadMetadata(
            current.restoredThread,
            response.thread,
          ),
          pendingThreadIds: removePendingThread(
            current.pendingThreadIds,
            threadId,
          ),
        };
      });
      return true;
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
          threadListError: pinned ? THREAD_PIN_FAILED : THREAD_UNPIN_FAILED,
        }));
      }
      return false;
    }
  }, [
    state.offline,
    state.pendingThreadIds,
    state.pinnedThreads,
    state.pinningAvailable,
    state.threadListPhase,
    state.threads,
  ]);

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
          pinnedThreads: removeThreadById(current.pinnedThreads, threadId),
          pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
          removingThreadIds: removePendingThread(
            current.removingThreadIds,
            threadId,
          ),
        }));
        setArchivedState((current) =>
          insertLoadedArchivedThread(current, thread),
        );
        setArchiveNotices((current) =>
          Object.freeze([
            ...current.filter(({ id }) => id !== thread.id),
            thread,
          ]),
        );
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

  const dismissArchiveNotice = useCallback((threadId: string): void => {
    setArchiveNotices((current) => removeThreadById(current, threadId));
  }, []);

  const unarchiveThread = useCallback(async (threadId: string): Promise<boolean> => {
    const source = sourceRef.current;
    if (
      source === null ||
      state.threadListPhase !== "ready" ||
      state.offline ||
      state.pendingThreadIds.includes(threadId) ||
      (
        !archiveNotices.some(({ id }) => id === threadId) &&
        !archivedState.archivedThreads.some(({ id }) => id === threadId)
      )
    ) {
      return false;
    }
    setState((current) => ({
      ...current,
      pendingThreadIds: addPendingThread(current.pendingThreadIds, threadId),
      threadListError: null,
    }));
    setArchivedState((current) => ({
      ...current,
      archivedThreadListError: null,
    }));
    try {
      const response = await source.client.unarchiveThread(threadId).result;
      if (sourceRef.current !== source) {
        return false;
      }
      setState((current) => ({
        ...current,
        threads: insertThreadByRecency(current.threads, response.thread),
        pinnedThreads: isPinnedThread(response.thread)
          ? appendThread(current.pinnedThreads, response.thread)
          : current.pinnedThreads,
        pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
      }));
      setArchivedState((current) => removeArchivedThread(current, threadId));
      setArchiveNotices((current) => removeThreadById(current, threadId));
      return true;
    } catch {
      if (sourceRef.current === source) {
        setState((current) => ({
          ...current,
          pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
          threadListError: THREAD_UNARCHIVE_FAILED,
        }));
        setArchivedState((current) => ({
          ...current,
          archivedThreadListError: THREAD_UNARCHIVE_FAILED,
        }));
      }
      return false;
    }
  }, [
    archiveNotices,
    archivedState.archivedThreads,
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
          pinnedThreads: removeThreadById(current.pinnedThreads, threadId),
          pendingThreadIds: removePendingThread(current.pendingThreadIds, threadId),
          removingThreadIds: removePendingThread(
            current.removingThreadIds,
            threadId,
          ),
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
    ...archivedState,
    archiveNotices,
    prepareStartedThread,
    dismissArchiveNotice,
    loadArchivedThreads,
    loadMoreArchivedThreads,
    loadMoreThreads,
    loadMorePinnedThreads,
    loadProjectThreads,
    refreshArchivedThreads,
    refreshThreads,
    archiveThread,
    unarchiveThread,
    deleteThread,
    setThreadPinned,
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
  const pinnedThreads = state.pinnedThreads.map((thread) =>
    thread.id === threadId ? update(thread) : thread,
  );
  const restored = state.restoredThread;
  const restoredThread =
    restored?.metadata.id === threadId
      ? Object.freeze({ ...restored, metadata: update(restored.metadata) })
      : restored;
  const pinnedChanged = pinnedThreads.some(
    (thread, index) => thread !== state.pinnedThreads[index],
  );
  if (!changed && !pinnedChanged && restoredThread === restored) {
    return state;
  }
  return {
    ...state,
    threads: changed ? Object.freeze(threads) : state.threads,
    pinnedThreads: pinnedChanged ? Object.freeze(pinnedThreads) : state.pinnedThreads,
    restoredThread,
  };
}

function updateArchivedThreadMetadata(
  state: ArchivedThreadListState,
  threadId: string,
  update: (thread: ThreadSummary) => ThreadSummary,
): ArchivedThreadListState {
  const threads = state.archivedThreads.map((thread) =>
    thread.id === threadId ? update(thread) : thread,
  );
  return threads.every((thread, index) => thread === state.archivedThreads[index])
    ? state
    : { ...state, archivedThreads: Object.freeze(threads) };
}

function insertLoadedArchivedThread(
  state: ArchivedThreadListState,
  thread: ThreadSummary,
): ArchivedThreadListState {
  return state.archivedThreadListPhase !== "ready"
    ? state
    : {
        ...state,
        archivedThreads: insertThreadByRecency(state.archivedThreads, thread),
      };
}

function removeArchivedThread(
  state: ArchivedThreadListState,
  threadId: string,
): ArchivedThreadListState {
  const threads = removeThreadById(state.archivedThreads, threadId);
  return threads === state.archivedThreads
    ? state
    : { ...state, archivedThreads: threads };
}

function removeThreadById(
  threads: readonly ThreadSummary[],
  threadId: string,
): readonly ThreadSummary[] {
  return threads.some(({ id }) => id === threadId)
    ? Object.freeze(threads.filter(({ id }) => id !== threadId))
    : threads;
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
      case "audio":
        return "[音频]";
      case "localAudio": {
        const name = input.path.split(/[\\/]/u).at(-1) || "音频";
        return `[音频 ${name}]`;
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

function mergeThreadsByRecency(
  existing: readonly ThreadSummary[],
  incoming: readonly ThreadSummary[],
): readonly ThreadSummary[] {
  return incoming.reduce<readonly ThreadSummary[]>(
    (threads, thread) => insertThreadByRecency(threads, thread),
    existing,
  );
}

function appendThread(
  existing: readonly ThreadSummary[],
  thread: ThreadSummary,
): readonly ThreadSummary[] {
  return Object.freeze([
    ...existing.filter(({ id }) => id !== thread.id),
    thread,
  ]);
}

function replaceThreadInOrder(
  existing: readonly ThreadSummary[],
  thread: ThreadSummary,
): readonly ThreadSummary[] {
  return existing.some(({ id }) => id === thread.id)
    ? Object.freeze(
        existing.map((item) => item.id === thread.id ? thread : item),
      )
    : appendThread(existing, thread);
}

function isPinnedThread(thread: ThreadSummary): boolean {
  return thread.section?.id === PINNED_THREAD_SECTION_ID;
}

function replaceRestoredThreadMetadata(
  restored: RestoredThread | null,
  thread: ThreadSummary,
): RestoredThread | null {
  return restored?.metadata.id === thread.id
    ? Object.freeze({ ...restored, metadata: thread })
    : restored;
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
  const restoredThread = Object.freeze({
    metadata: response.thread,
    modelSettings: modelSettingsFrom(response),
    turns: Object.freeze([...response.thread.turns]),
  });
  recordConversationProjection(
    response.thread,
    performance.now() - projectionStartedAt,
  );
  return restoredThread;
}

function modelSettingsFrom(
  response: Pick<
    ThreadStartResponse | ThreadResumeResponse,
    "model" | "reasoningEffort" | "serviceTier"
  >,
): ThreadModelSettings {
  return Object.freeze({
    effort: response.reasoningEffort ?? null,
    model: response.model,
    serviceTier: response.serviceTier ?? null,
  });
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
