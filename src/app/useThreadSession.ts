import { useEffect, useRef, useState } from "react";

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
} from "./useServerThreads";

export type ThreadSessionPhase = "idle" | "loading" | "ready" | "error";

export interface ThreadSessionState {
  readonly phase: ThreadSessionPhase;
  readonly restoredThread: RestoredThread | null;
  readonly resumedThreadId: string | null;
  readonly deleted: boolean;
  readonly offline: boolean;
  readonly error: string | null;
}

interface ThreadSubscriptionSource {
  readonly client: ServerThreadsClient;
  readonly threadId: string;
}

const IDLE_STATE = Object.freeze({
  phase: "idle",
  restoredThread: null,
  resumedThreadId: null,
  deleted: false,
  offline: false,
  error: null,
}) satisfies ThreadSessionState;

export function useThreadSession(
  client: ServerThreadsClient | null,
  threadId: string | null,
  preparedState: ThreadSessionState | null = null,
): ThreadSessionState {
  const [state, setState] = useState<ThreadSessionState>(
    preparedState ?? IDLE_STATE,
  );
  const sourceRef = useRef<ThreadSubscriptionSource | null>(null);
  const leaseRef = useRef<ThreadSubscriptionSource | null>(null);
  const readySubscriptionRef = useRef<ThreadSubscriptionSource | null>(null);
  const resumeRequestRef = useRef<{
    readonly source: ThreadSubscriptionSource;
    readonly result: Promise<RestoredThread>;
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
    const retainedSubscription =
      sameSubscriptionSource(readySubscriptionRef.current, source)
        ? state.restoredThread
        : null;
    const preparedThread = explicitlyPreparedThread ?? retainedSubscription;
    const retained =
      retainedThreadIdRef.current === threadId
        ? state.restoredThread
        : null;
    setState({
      phase: preparedThread === null ? "loading" : "ready",
      restoredThread: preparedThread ?? retained,
      resumedThreadId: preparedThread === null ? null : threadId,
      deleted: false,
      offline: preparedThread === null && retained !== null,
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
          .then(restoredThreadFrom);
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
          (restoredThread) => {
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
        () => {
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
              error: "无法恢复当前会话",
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

  return state;
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
