import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ServerNotification,
  ThreadItemsListResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
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
  readonly loadingOlderTurns: boolean;
  readonly olderTurnsError: string | null;
  readonly deleted: boolean;
  readonly offline: boolean;
  readonly error: string | null;
}

export interface ThreadSessionControls {
  readonly state: ThreadSessionState;
  readonly loadOlderTurns: () => Promise<boolean>;
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
          .then((response) => restoredThreadPageFrom(client, response));
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
            const resumedState: ThreadSessionState = {
              phase: "ready",
              restoredThread,
              resumedThreadId: threadId,
              olderTurnsCursor,
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
        const hydratedTurns = await hydrateTurns(
          source.client,
          source.threadId,
          page.data,
        );
        if (sourceRef.current !== source) {
          return false;
        }
        const loadedTurnIds = new Set(
          stateRef.current.restoredThread?.turns.map(({ id }) => id) ?? [],
        );
        const loadedOlderTurns = hydratedTurns
          .toReversed()
          .filter(({ id }) => !loadedTurnIds.has(id));
        setState((latest) => {
          if (latest.restoredThread === null) {
            return latest;
          }
          const currentTurnIds = new Set(
            latest.restoredThread.turns.map(({ id }) => id),
          );
          const olderTurns = hydratedTurns
            .toReversed()
            .filter(({ id }) => !currentTurnIds.has(id));
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

  return useMemo(
    () => ({ state, loadOlderTurns }),
    [loadOlderTurns, state],
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
  client: ServerThreadsClient,
  response: ThreadResumeResponse,
): Promise<RestoredThreadPage> {
  if (response.thread.historyMode !== "paginated") {
    throw new UnsupportedThreadHistoryModeError();
  }
  const initialPage = response.initialTurnsPage;
  if (initialPage === null || initialPage === undefined) {
    throw new TypeError("thread/resume 未返回 initialTurnsPage");
  }
  const hydratedTurns = await hydrateTurns(
    client,
    response.thread.id,
    initialPage.data,
  );
  const projectionStartedAt = performance.now();
  const restoredThread = Object.freeze({
    metadata: response.thread,
    modelSettings: modelSettingsFrom(response),
    turns: Object.freeze(hydratedTurns.toReversed()),
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

async function hydrateTurns(
  client: ServerThreadsClient,
  threadId: string,
  turns: ThreadTurnsListResponse["data"],
): Promise<ThreadTurn[]> {
  return Promise.all(
    turns.map(async (turn) => {
      const hydratedTurn: ThreadTurn = {
        ...turn,
        items: await loadAllTurnItems(client, threadId, turn.id),
        itemsView: "full",
      };
      return Object.freeze(hydratedTurn);
    }),
  );
}

async function loadAllTurnItems(
  client: ServerThreadsClient,
  threadId: string,
  turnId: string,
): Promise<ThreadTurn["items"][number][]> {
  const items: ThreadTurn["items"][number][] = [];
  let cursor: string | null = null;
  do {
    const page: ThreadItemsListResponse =
      await client.listThreadItems(threadId, turnId, cursor).result;
    for (const entry of page.data) {
      if (entry.turnId !== turnId) {
        throw new TypeError("thread/items/list 返回了其他回合的项目");
      }
      items.push(entry.item);
    }
    const nextCursor: string | null = page.nextCursor ?? null;
    if (nextCursor !== null && nextCursor === cursor) {
      throw new TypeError("thread/items/list 返回了未推进的游标");
    }
    cursor = nextCursor;
  } while (cursor !== null);
  return items;
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
