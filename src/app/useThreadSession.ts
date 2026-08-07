import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ServerNotification,
  ThreadResumeResponse,
} from "../protocol/generated";
import { recordConversationProjection } from "../diagnostics/conversationLoadDiagnostics";
import { reduceConversationNotification } from "./useConversation";
import type {
  RestoredThread,
  ServerThreadsClient,
  ThreadModelSettings,
  ThreadTurn,
} from "./useServerThreads";

export type ThreadSessionPhase = "idle" | "loading" | "ready" | "error";

export interface ThreadSessionState {
  readonly phase: ThreadSessionPhase;
  readonly restoredThread: RestoredThread | null;
  readonly resumedThreadId: string | null;
  readonly olderTurnsCursor: string | null;
  readonly turnItemPages: ReadonlyMap<string, TurnItemPageState>;
  readonly loadingOlderTurns: boolean;
  readonly olderTurnsError: string | null;
  readonly deleted: boolean;
  readonly offline: boolean;
  readonly error: string | null;
}

export interface ThreadSessionControls {
  readonly state: ThreadSessionState;
  readonly loadOlderTurns: () => Promise<boolean>;
  readonly loadTurnItemPage: (turnId: string) => Promise<boolean>;
}

export interface TurnItemPageState {
  readonly items: readonly ThreadTurn["items"][number][];
  readonly nextCursor: string | null;
  readonly complete: boolean;
  readonly loading: boolean;
  readonly error: boolean;
}

interface ThreadSubscriptionSource {
  readonly client: ServerThreadsClient;
  readonly threadId: string;
}

interface RestoredThreadPage {
  readonly restoredThread: RestoredThread;
  readonly olderTurnsCursor: string | null;
}

class UnsupportedThreadHistoryModeError extends Error {}

const IDLE_STATE = Object.freeze({
  phase: "idle",
  restoredThread: null,
  resumedThreadId: null,
  olderTurnsCursor: null,
  turnItemPages: new Map<string, TurnItemPageState>(),
  loadingOlderTurns: false,
  olderTurnsError: null,
  deleted: false,
  offline: false,
  error: null,
}) satisfies ThreadSessionState;

export function useThreadSession(
  client: ServerThreadsClient | null,
  threadId: string | null,
  preparedState: ThreadSessionState | null = null,
): ThreadSessionControls {
  const [state, setState] = useState<ThreadSessionState>(
    preparedState ?? IDLE_STATE,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const sourceRef = useRef<ThreadSubscriptionSource | null>(null);
  const leaseRef = useRef<ThreadSubscriptionSource | null>(null);
  const readySubscriptionRef = useRef<ThreadSubscriptionSource | null>(null);
  const resumeRequestRef = useRef<{
    readonly source: ThreadSubscriptionSource;
    readonly result: Promise<RestoredThreadPage>;
  } | null>(null);
  const olderTurnsRequestRef = useRef<{
    readonly source: ThreadSubscriptionSource;
    readonly cursor: string;
    readonly result: Promise<boolean>;
  } | null>(null);
  const turnItemRequestsRef = useRef(new Map<string, {
    readonly source: ThreadSubscriptionSource;
    readonly cursor: string | null;
    readonly result: Promise<boolean>;
  }>());
  const retainedThreadIdRef = useRef<string | null>(null);
  const preparedStateRef = useRef(preparedState);
  useEffect(() => {
    if (threadId === null) {
      sourceRef.current = null;
      retainedThreadIdRef.current = null;
      setState(IDLE_STATE);
      return;
    }
    if (client === null) {
      sourceRef.current = null;
      setState((current) =>
        retainedThreadIdRef.current === threadId && current.restoredThread !== null
          ? { ...current, offline: true }
          : {
              ...IDLE_STATE,
              phase: "loading",
              offline: true,
            },
      );
      return;
    }

    const source = { client, threadId };
    sourceRef.current = source;
    leaseRef.current = source;
    const prepared = preparedStateRef.current;
    preparedStateRef.current = null;
    const explicitlyPreparedThread =
      prepared?.resumedThreadId === threadId &&
      prepared.restoredThread?.metadata.id === threadId
        ? prepared.restoredThread
        : null;
    const retainedSubscriptionState =
      sameSubscriptionSource(readySubscriptionRef.current, source)
        ? state
        : null;
    const preparedSession = explicitlyPreparedThread === null
      ? retainedSubscriptionState
      : prepared;
    const preparedThread = explicitlyPreparedThread
      ?? retainedSubscriptionState?.restoredThread
      ?? null;
    const retainedThread =
      retainedThreadIdRef.current === threadId
        ? state.restoredThread
        : null;
    const retainedSession =
      retainedThread === null ? null : state;
    setState({
      phase: preparedThread === null ? "loading" : "ready",
      restoredThread: preparedThread ?? retainedThread,
      resumedThreadId: preparedThread === null ? null : threadId,
      olderTurnsCursor:
        (preparedSession ?? retainedSession)?.olderTurnsCursor ?? null,
      turnItemPages:
        (preparedSession ?? retainedSession)?.turnItemPages ?? IDLE_STATE.turnItemPages,
      loadingOlderTurns: false,
      olderTurnsError: null,
      deleted: false,
      offline: preparedThread === null && retainedThread !== null,
      error: null,
    });
    if (preparedThread !== null) {
      retainedThreadIdRef.current = threadId;
      readySubscriptionRef.current = source;
    }

    let resumePending = preparedThread === null;
    let notificationsDuringResume: ServerNotification[] = [];
    let frame: number | null = null;
    let queued: ServerNotification[] = [];
    const applyNotifications = (notifications: readonly ServerNotification[]) => {
      if (notifications.length === 0) {
        return;
      }
      setState((current) =>
        notifications.reduce(
          (next, notification) =>
            reduceThreadNotification(next, threadId, notification),
          current,
        )
      );
    };
    const flushNotifications = () => {
      frame = null;
      const pending = queued;
      queued = [];
      applyNotifications(pending);
    };
    const releaseNotifications = client.subscribeNotifications((notification) => {
      if (
        sourceRef.current !== source ||
        notificationThreadId(notification) !== threadId
      ) {
        return;
      }
      if (resumePending) {
        notificationsDuringResume.push(notification);
        return;
      }
      if (isProjectionDelta(notification)) {
        queued.push(notification);
        frame ??= window.requestAnimationFrame(flushNotifications);
        return;
      }
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      const pending = [...queued, notification];
      queued = [];
      applyNotifications(pending);
    });

    if (preparedThread === null) {
      const existingResume = resumeRequestRef.current;
      const resumeResult = sameSubscriptionSource(existingResume?.source ?? null, source)
        ? existingResume!.result
        : Promise.resolve()
          .then(() => client.resumeThread(threadId).result)
          .then(restoredThreadPageFrom);
      if (resumeResult !== existingResume?.result) {
        const request = { source, result: resumeResult };
        resumeRequestRef.current = request;
        void resumeResult.then(
          () => {
            if (resumeRequestRef.current === request) {
              resumeRequestRef.current = null;
            }
          },
          () => {
            if (resumeRequestRef.current === request) {
              resumeRequestRef.current = null;
            }
          },
        );
      }
      void resumeResult
        .then(
          ({ restoredThread, olderTurnsCursor }) => {
            if (sourceRef.current !== source) {
              return;
            }
            resumePending = false;
            retainedThreadIdRef.current = threadId;
            readySubscriptionRef.current = source;
            const turnItemPages = stateRef.current.turnItemPages;
            const resumedState: ThreadSessionState = {
              phase: "ready",
              restoredThread: applyTurnItemPages(restoredThread, turnItemPages),
              resumedThreadId: threadId,
              olderTurnsCursor,
              turnItemPages,
              loadingOlderTurns: false,
              olderTurnsError: null,
              deleted: false,
              offline: false,
              error: null,
            };
            const pending = notificationsDuringResume;
            notificationsDuringResume = [];
            setState(pending.reduce(
              (current, notification) =>
                reduceThreadNotification(current, threadId, notification),
              resumedState,
            ));
          },
          (error: unknown) => {
            if (sourceRef.current !== source) {
              return;
            }
            resumePending = false;
            const pending = notificationsDuringResume;
            notificationsDuringResume = [];
            setState((current) => {
              const reconciled = pending.reduce(
                (next, notification) =>
                  reduceThreadNotification(next, threadId, notification),
                current,
              );
              return {
                ...reconciled,
                phase: reconciled.restoredThread === null ? "error" : "ready",
                offline: reconciled.restoredThread !== null,
                error: error instanceof UnsupportedThreadHistoryModeError
                  ? "当前会话使用 legacy 历史格式，无法加载完整历史"
                  : "无法恢复当前会话",
              };
            });
          },
        );
    }

    return () => {
      releaseNotifications();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      queued = [];
      notificationsDuringResume = [];
      if (leaseRef.current === source) {
        leaseRef.current = null;
      }
      queueMicrotask(() => {
        if (sameSubscriptionSource(leaseRef.current, source)) {
          return;
        }
        unsubscribeSafely(client, threadId);
        if (sameSubscriptionSource(readySubscriptionRef.current, source)) {
          readySubscriptionRef.current = null;
        }
      });
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, [client, threadId]);

  const loadOlderTurns = useCallback((): Promise<boolean> => {
    const source = sourceRef.current;
    const current = stateRef.current;
    const cursor = current.olderTurnsCursor;
    if (
      source === null ||
      cursor === null ||
      current.restoredThread === null ||
      current.offline
    ) {
      return Promise.resolve(false);
    }
    const existing = olderTurnsRequestRef.current;
    if (
      sameSubscriptionSource(existing?.source ?? null, source) &&
      existing?.cursor === cursor
    ) {
      return existing.result;
    }

    const result = (async () => {
      setState((latest) => ({
        ...latest,
        loadingOlderTurns: true,
        olderTurnsError: null,
      }));
      try {
        const page = await source.client.listThreadTurns(
          source.threadId,
          cursor,
        ).result;
        if (sourceRef.current !== source) {
          return false;
        }
        const loadedTurnIds = new Set(
          stateRef.current.restoredThread?.turns.map(({ id }) => id) ?? [],
        );
        const loadedOlderTurns = page.data
          .toReversed()
          .filter(({ id }) => !loadedTurnIds.has(id));
        setState((latest) => {
          if (latest.restoredThread === null) {
            return latest;
          }
          const currentTurnIds = new Set(
            latest.restoredThread.turns.map(({ id }) => id),
          );
          const olderTurns = page.data
            .toReversed()
            .filter(({ id }) => !currentTurnIds.has(id))
            .map((turn) => {
              const itemPage = latest.turnItemPages.get(turn.id);
              return itemPage === undefined
                ? turn
                : mergeTurnItemPage(turn, itemPage.items, itemPage.complete);
            });
          const next = {
            ...latest,
            restoredThread: Object.freeze({
              ...latest.restoredThread,
              turns: Object.freeze([
                ...olderTurns,
                ...latest.restoredThread.turns,
              ]),
            }),
            olderTurnsCursor: page.nextCursor ?? null,
            loadingOlderTurns: false,
            olderTurnsError: null,
          };
          stateRef.current = next;
          return next;
        });
        return loadedOlderTurns.length > 0;
      } catch {
        if (sourceRef.current === source) {
          setState((latest) => ({
            ...latest,
            loadingOlderTurns: false,
            olderTurnsError: "无法加载更早内容",
          }));
        }
        return false;
      }
    })();
    const request = { source, cursor, result };
    olderTurnsRequestRef.current = request;
    void result.finally(() => {
      if (olderTurnsRequestRef.current === request) {
        olderTurnsRequestRef.current = null;
      }
    });
    return result;
  }, []);

  const loadTurnItemPage = useCallback((turnId: string): Promise<boolean> => {
    const source = sourceRef.current;
    const current = stateRef.current;
    const turn = current.restoredThread?.turns.find(({ id }) => id === turnId);
    const pageState = current.turnItemPages.get(turnId);
    if (
      source === null ||
      turn === undefined ||
      turn.status === "inProgress" ||
      turn.itemsView === "full" ||
      pageState?.complete === true ||
      current.offline
    ) {
      return Promise.resolve(false);
    }
    const cursor = pageState?.nextCursor ?? null;
    const existing = turnItemRequestsRef.current.get(turnId);
    if (
      existing !== undefined &&
      sameSubscriptionSource(existing.source, source) &&
      existing.cursor === cursor
    ) {
      return existing.result;
    }

    const result = (async () => {
      setState((latest) => withTurnItemPageState(latest, turnId, (page) => ({
        ...page,
        loading: true,
        error: false,
      })));
      try {
        const page = await source.client.listThreadItems(
          source.threadId,
          turnId,
          cursor,
        ).result;
        if (sourceRef.current !== source) {
          return false;
        }
        const items = page.data.map((entry) => {
          if (entry.turnId !== turnId) {
            throw new TypeError("thread/items/list 返回了其他回合的项目");
          }
          return entry.item;
        });
        const nextCursor = page.nextCursor ?? null;
        if (cursor !== null && nextCursor === cursor) {
          throw new TypeError("thread/items/list 返回了未推进的游标");
        }
        setState((latest) => {
          if (latest.restoredThread === null) {
            return latest;
          }
          const currentPage = latest.turnItemPages.get(turnId)
            ?? emptyTurnItemPageState();
          const loadedItems = mergeUniqueItems(currentPage.items, items);
          const complete = nextCursor === null;
          const turns = latest.restoredThread.turns.map((candidate) =>
            candidate.id === turnId
              ? mergeTurnItemPage(candidate, loadedItems, complete)
              : candidate
          );
          const turnItemPages = new Map(latest.turnItemPages);
          turnItemPages.set(turnId, Object.freeze({
            items: Object.freeze(loadedItems),
            nextCursor,
            complete,
            loading: false,
            error: false,
          }));
          const next = {
            ...latest,
            restoredThread: Object.freeze({
              ...latest.restoredThread,
              turns: Object.freeze(turns),
            }),
            turnItemPages,
          };
          stateRef.current = next;
          return next;
        });
        return true;
      } catch {
        if (sourceRef.current === source) {
          setState((latest) => withTurnItemPageState(latest, turnId, (page) => ({
            ...page,
            loading: false,
            error: true,
          })));
        }
        return false;
      }
    })();
    const request = { source, cursor, result };
    turnItemRequestsRef.current.set(turnId, request);
    void result.finally(() => {
      if (turnItemRequestsRef.current.get(turnId) === request) {
        turnItemRequestsRef.current.delete(turnId);
      }
    });
    return result;
  }, []);

  return useMemo(
    () => ({ state, loadOlderTurns, loadTurnItemPage }),
    [loadOlderTurns, loadTurnItemPage, state],
  );
}

function sameSubscriptionSource(
  left: ThreadSubscriptionSource | null,
  right: ThreadSubscriptionSource,
): boolean {
  return left?.client === right.client && left.threadId === right.threadId;
}

function reduceThreadNotification(
  state: ThreadSessionState,
  threadId: string,
  notification: ServerNotification,
): ThreadSessionState {
  if (notificationThreadId(notification) !== threadId) {
    return state;
  }
  switch (notification.method) {
    case "thread/name/updated":
      return state.restoredThread === null
        ? state
        : {
            ...state,
            restoredThread: Object.freeze({
              ...state.restoredThread,
              metadata: Object.freeze({
                ...state.restoredThread.metadata,
                name: notification.params.threadName ?? null,
              }),
            }),
          };
    case "thread/settings/updated":
      return state.restoredThread === null
        ? state
        : {
            ...state,
            restoredThread: Object.freeze({
              ...state.restoredThread,
              modelSettings: Object.freeze({
                effort: notification.params.threadSettings.effort ?? null,
                model: notification.params.threadSettings.model,
                serviceTier:
                  notification.params.threadSettings.serviceTier ?? null,
              }),
            }),
          };
    case "thread/status/changed":
      return state.restoredThread === null
        ? state
        : {
            ...state,
            restoredThread: Object.freeze({
              ...state.restoredThread,
              metadata: Object.freeze({
                ...state.restoredThread.metadata,
                status: notification.params.status,
              }),
            }),
          };
    case "thread/deleted":
      return {
        phase: "ready",
        restoredThread: null,
        resumedThreadId: null,
        olderTurnsCursor: null,
        turnItemPages: IDLE_STATE.turnItemPages,
        loadingOlderTurns: false,
        olderTurnsError: null,
        deleted: true,
        offline: false,
        error: null,
      };
    default: {
      if (state.restoredThread === null) {
        return state;
      }
      const projection = reduceConversationNotification(
        {
          turns: state.restoredThread.turns,
          activeTurnId: null,
          submitting: false,
          stopping: false,
          error: null,
        },
        notification,
      );
      return projection.turns === state.restoredThread.turns
        ? state
        : {
            ...state,
            restoredThread: Object.freeze({
              ...state.restoredThread,
              turns: projection.turns,
            }),
          };
    }
  }
}

function notificationThreadId(notification: ServerNotification): string | null {
  const params: unknown = notification.params;
  if (typeof params !== "object" || params === null || !("threadId" in params)) {
    return null;
  }
  return typeof params.threadId === "string" ? params.threadId : null;
}

function isProjectionDelta(notification: ServerNotification): boolean {
  return notification.method === "item/agentMessage/delta" ||
    notification.method === "item/plan/delta" ||
    notification.method === "item/commandExecution/outputDelta" ||
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/reasoning/textDelta";
}

async function restoredThreadPageFrom(
  response: ThreadResumeResponse,
): Promise<RestoredThreadPage> {
  if (response.thread.historyMode !== "paginated") {
    throw new UnsupportedThreadHistoryModeError();
  }
  const initialPage = response.initialTurnsPage;
  if (initialPage === null || initialPage === undefined) {
    throw new TypeError("thread/resume 未返回 initialTurnsPage");
  }
  const projectionStartedAt = performance.now();
  const restoredThread = Object.freeze({
    metadata: response.thread,
    modelSettings: modelSettingsFrom(response),
    turns: Object.freeze(initialPage.data.toReversed()),
  });
  recordConversationProjection(
    response.thread,
    performance.now() - projectionStartedAt,
    restoredThread.turns,
  );
  return Object.freeze({
    restoredThread,
    olderTurnsCursor: initialPage.nextCursor ?? null,
  });
}

function emptyTurnItemPageState(): TurnItemPageState {
  return {
    items: Object.freeze([]),
    nextCursor: null,
    complete: false,
    loading: false,
    error: false,
  };
}

function withTurnItemPageState(
  state: ThreadSessionState,
  turnId: string,
  update: (page: TurnItemPageState) => TurnItemPageState,
): ThreadSessionState {
  const turnItemPages = new Map(state.turnItemPages);
  turnItemPages.set(
    turnId,
    Object.freeze(update(turnItemPages.get(turnId) ?? emptyTurnItemPageState())),
  );
  return { ...state, turnItemPages };
}

function mergeUniqueItems(
  existing: readonly ThreadTurn["items"][number][],
  incoming: readonly ThreadTurn["items"][number][],
): ThreadTurn["items"][number][] {
  const items = [...existing];
  const indexes = new Map(items.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const index = indexes.get(item.id);
    if (index === undefined) {
      indexes.set(item.id, items.length);
      items.push(item);
    } else {
      items[index] = item;
    }
  }
  return items;
}

function mergeTurnItemPage(
  turn: ThreadTurn,
  loadedItems: readonly ThreadTurn["items"][number][],
  complete: boolean,
): ThreadTurn {
  const loadedIds = new Set(loadedItems.map(({ id }) => id));
  const { clientItemsView: _clientItemsView, ...serverTurn } = turn;
  return Object.freeze({
    ...serverTurn,
    items: complete
      ? [...loadedItems]
      : [
          ...loadedItems,
          ...turn.items.filter(({ id }) => !loadedIds.has(id)),
        ],
    itemsView: complete ? "full" : "summary",
    ...(complete ? {} : { clientItemsView: "partial" as const }),
  });
}

function applyTurnItemPages(
  restoredThread: RestoredThread,
  pages: ReadonlyMap<string, TurnItemPageState>,
): RestoredThread {
  if (pages.size === 0) {
    return restoredThread;
  }
  return Object.freeze({
    ...restoredThread,
    turns: Object.freeze(restoredThread.turns.map((turn) => {
      const page = pages.get(turn.id);
      return page === undefined
        ? turn
        : mergeTurnItemPage(turn, page.items, page.complete);
    })),
  });
}

function modelSettingsFrom(
  response: Pick<
    ThreadResumeResponse,
    "model" | "reasoningEffort" | "serviceTier"
  >,
): ThreadModelSettings {
  return Object.freeze({
    effort: response.reasoningEffort ?? null,
    model: response.model,
    serviceTier: response.serviceTier ?? null,
  });
}

function unsubscribeSafely(client: ServerThreadsClient, threadId: string): void {
  try {
    void client.unsubscribeThread(threadId).result.catch(() => undefined);
  } catch {
    // 清理失败由连接诊断记录，不覆盖其它标签的状态
  }
}
