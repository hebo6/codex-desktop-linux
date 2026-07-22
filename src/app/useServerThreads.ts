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
import type { ServerThreadCache } from "../transport/offlineCache";

export type ServerThreadsPhase = "idle" | "loading" | "ready" | "error";
export type ThreadSummary = ThreadListResponse["data"][number];
export type ThreadTurn = ThreadTurnsListResponse["data"][number];

export interface RestoredThread {
  readonly metadata: ThreadResumeResponse["thread"];
  readonly turns: readonly ThreadTurn[];
  readonly nextCursor: string | null;
}

export interface ServerThreadsState {
  readonly phase: ServerThreadsPhase;
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
  readonly error: string | null;
  readonly offline: boolean;
  readonly lastSyncedAt: number | null;
}

export interface ServerThreadsControls extends ServerThreadsState {
  readonly prepareStartedThread: (response: ThreadStartResponse) => () => void;
  readonly loadMoreThreads: () => Promise<void>;
  readonly refreshThreads: () => Promise<void>;
  readonly loadOlderTurns: () => Promise<void>;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly undoArchive: () => Promise<boolean>;
  readonly deleteThread: (threadId: string) => Promise<boolean>;
}

interface ThreadRequest<T> {
  readonly result: Promise<T>;
}

export interface ServerThreadsClient {
  subscribeNotifications(
    handler: (notification: ServerNotification) => void,
  ): () => void;
  listRecentThreads(
    options?: { readonly archived?: boolean; readonly cursor?: string | null },
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
  phase: "idle",
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
  error: null,
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

export function useServerThreads(
  client: ServerThreadsClient | null,
  currentThreadId: string | null,
  cache: ServerThreadCache | null = null,
  serverId: ServerId | null = null,
): ServerThreadsControls {
  const [state, setState] = useState<ServerThreadsState>(IDLE_STATE);
  const sourceRef = useRef<ActiveSource | null>(null);
  const loadingThreadsRef = useRef<ActiveSource | null>(null);
  const refreshingThreadsRef = useRef<ActiveSource | null>(null);
  const loadingTurnsRef = useRef<ActiveSource | null>(null);
  const preparedStartedThreadRef = useRef<PreparedStartedThread | null>(null);

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
      if (cache === null || serverId === null) {
        setState(IDLE_STATE);
        return;
      }
      let active = true;
      setState({ ...IDLE_STATE, phase: "loading" });
      void cache.load(serverId, currentThreadId).then(
        (cached) => {
          if (!active) return;
          if (cached === null) {
            setState(IDLE_STATE);
            return;
          }
          const cachedRestoredThread = cached.restoredThread !== null && (
            currentThreadId === null || cached.restoredThread.metadata.id === currentThreadId
          ) ? cached.restoredThread : null;
          const restoredThread = cachedRestoredThread === null ? null : Object.freeze({
            ...cachedRestoredThread,
            nextCursor: null,
          });
          setState({
            phase: "ready",
            threads: cached.threads,
            nextThreadCursor: null,
            restoredThread,
            loadingMoreThreads: false,
            refreshingThreads: false,
            loadingOlderTurns: false,
            pendingThreadIds: Object.freeze([]),
            removingThreadIds: Object.freeze([]),
            currentThreadDeleted: false,
            archivedThread: null,
            error: null,
            offline: true,
            lastSyncedAt: cached.syncedAtMs,
          });
        },
        () => {
          if (active) setState(IDLE_STATE);
        },
      );
      return () => { active = false; };
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
        if (current.phase !== "ready") {
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
          current.phase === "ready" &&
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
          setState((current) => ({ ...current, error: THREAD_SYNC_FAILED }));
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
              current.phase === "ready"
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
    const preparedStartedThread = preparedStartedThreadRef.current;
    if (
      preparedStartedThread?.client === client &&
      preparedStartedThread.restoredThread.metadata.id === currentThreadId
    ) {
      preparedStartedThreadRef.current = null;
      setState((current) => ({
        ...current,
        phase: "ready",
        threads: insertThreadByRecency(
          current.threads,
          preparedStartedThread.restoredThread.metadata,
        ),
        restoredThread: preparedStartedThread.restoredThread,
        loadingMoreThreads: false,
        refreshingThreads: false,
        loadingOlderTurns: false,
        currentThreadDeleted: false,
        error: null,
        offline: false,
        lastSyncedAt: Date.now(),
      }));
    } else {
      if (preparedStartedThread !== null) {
        preparedStartedThreadRef.current = null;
      }
      setState({ ...IDLE_STATE, phase: "loading" });
      void loadInitialState(source).then(
        ({ list, restoredThread }) => {
          if (sourceRef.current !== source) {
            return;
          }
          const currentThreadWasDeleted =
            source.currentThreadId !== null &&
            removedThreadIds.has(source.currentThreadId);
          setState({
            phase: "ready",
            threads: Object.freeze(
              list.data.filter(({ id }) => !removedThreadIds.has(id)),
            ),
            nextThreadCursor: list.nextCursor ?? null,
            restoredThread: currentThreadWasDeleted ? null : restoredThread,
            loadingMoreThreads: false,
            refreshingThreads: false,
            loadingOlderTurns: false,
            pendingThreadIds: Object.freeze([]),
            removingThreadIds: Object.freeze([]),
            currentThreadDeleted: currentThreadWasDeleted,
            archivedThread: null,
            error: null,
            offline: false,
            lastSyncedAt: Date.now(),
          });
        },
        (failure: InitialLoadFailure) => {
          if (sourceRef.current !== source) {
            return;
          }
          setState({
            ...IDLE_STATE,
            phase: "error",
            error:
              failure.stage === "restore"
                ? THREAD_RESTORE_FAILED
                : THREAD_LIST_FAILED,
          });
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
  }, [cache, client, currentThreadId, serverId]);

  useEffect(() => {
    if (
      cache === null ||
      client === null ||
      serverId === null ||
      state.phase !== "ready" ||
      state.offline
    ) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void cache.save({
        serverId,
        threads: state.threads,
        nextThreadCursor: state.nextThreadCursor,
        currentThreadId: state.restoredThread?.metadata.id ?? null,
        restoredThread: state.restoredThread,
      }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [cache, client, serverId, state.nextThreadCursor, state.offline, state.phase, state.restoredThread, state.threads]);

  const loadMoreThreads = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    if (
      source === null ||
      state.phase !== "ready" ||
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
      error: null,
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
          error: THREAD_PAGE_FAILED,
        }));
      }
    } finally {
      if (loadingThreadsRef.current === source) {
        loadingThreadsRef.current = null;
      }
    }
  }, [state.nextThreadCursor, state.phase]);

  const refreshThreads = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    if (
      source === null ||
      state.phase !== "ready" ||
      refreshingThreadsRef.current !== null
    ) {
      return;
    }
    refreshingThreadsRef.current = source;
    setState((current) => ({
      ...current,
      refreshingThreads: true,
      error: null,
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
          error: THREAD_REFRESH_FAILED,
        }));
      }
    } finally {
      if (refreshingThreadsRef.current === source) {
        refreshingThreadsRef.current = null;
      }
    }
  }, [state.phase]);

  const loadOlderTurns = useCallback(async (): Promise<void> => {
    const source = sourceRef.current;
    const restored = state.restoredThread;
    if (
      source === null ||
      state.phase !== "ready" ||
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
      error: null,
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
          error: TURN_PAGE_FAILED,
        }));
      }
    } finally {
      if (loadingTurnsRef.current === source) {
        loadingTurnsRef.current = null;
      }
    }
  }, [state.phase, state.restoredThread]);

  const archiveThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const source = sourceRef.current;
      const threadIndex = state.threads.findIndex(({ id }) => id === threadId);
      if (
        source === null ||
        state.phase !== "ready" ||
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
        error: null,
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
            error: THREAD_ARCHIVE_FAILED,
          }));
        }
        return false;
      }
    },
    [state.pendingThreadIds, state.phase, state.threads],
  );

  const undoArchive = useCallback(async (): Promise<boolean> => {
    const source = sourceRef.current;
    const thread = state.archivedThread;
    if (
      source === null ||
      state.phase !== "ready" ||
      thread === null ||
      state.pendingThreadIds.includes(thread.id)
    ) {
      return false;
    }
    setState((current) => ({
      ...current,
      pendingThreadIds: addPendingThread(current.pendingThreadIds, thread.id),
      error: null,
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
          error: THREAD_UNARCHIVE_FAILED,
        }));
      }
      return false;
    }
  }, [state.archivedThread, state.pendingThreadIds, state.phase]);

  const deleteThread = useCallback(
    async (threadId: string): Promise<boolean> => {
      const source = sourceRef.current;
      if (
        source === null ||
        state.phase !== "ready" ||
        !state.threads.some(({ id }) => id === threadId) ||
        state.pendingThreadIds.includes(threadId)
      ) {
        return false;
      }
      setState((current) => ({
        ...current,
        pendingThreadIds: addPendingThread(current.pendingThreadIds, threadId),
        error: null,
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
            error: THREAD_DELETE_FAILED,
          }));
        }
        return false;
      }
    },
    [state.pendingThreadIds, state.phase, state.threads],
  );

  return {
    ...state,
    prepareStartedThread,
    loadMoreThreads,
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
  if (state.phase !== "ready") {
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

interface InitialLoadFailure {
  readonly stage: "list" | "restore";
}

async function loadInitialState(source: ActiveSource): Promise<{
  readonly list: ThreadListResponse;
  readonly restoredThread: RestoredThread | null;
}> {
  const listPromise = Promise.resolve()
    .then(() => source.client.listRecentThreads().result)
    .catch(() => {
      throw { stage: "list" } satisfies InitialLoadFailure;
    });
  const currentThreadId = source.currentThreadId;
  const restorePromise =
    currentThreadId === null
      ? Promise.resolve<RestoredThread | null>(null)
      : Promise.resolve()
          .then(() => source.client.resumeThread(currentThreadId).result)
          .then((response) => restoredThreadFrom(response))
          .catch(() => {
            throw { stage: "restore" } satisfies InitialLoadFailure;
          });
  const [listResult, restoreResult] = await Promise.allSettled([
    listPromise,
    restorePromise,
  ]);
  if (listResult.status === "rejected") {
    throw { stage: "list" } satisfies InitialLoadFailure;
  }
  if (restoreResult.status === "rejected") {
    throw { stage: "restore" } satisfies InitialLoadFailure;
  }
  return {
    list: listResult.value,
    restoredThread: restoreResult.value,
  };
}

function restoredThreadFrom(response: ThreadResumeResponse): RestoredThread {
  const initialPage = response.initialTurnsPage;
  if (initialPage === undefined || initialPage === null) {
    throw new TypeError("missing initial turns page");
  }
  return Object.freeze({
    metadata: response.thread,
    turns: Object.freeze([...initialPage.data].reverse()),
    nextCursor: initialPage.nextCursor ?? null,
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
