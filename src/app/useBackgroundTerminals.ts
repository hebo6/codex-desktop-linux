import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BackgroundTerminalClient } from "../appServer";
import type {
  ServerNotification,
  ThreadBackgroundTerminalsListResponse,
} from "../protocol/generated";

type BackgroundTerminal =
  ThreadBackgroundTerminalsListResponse["data"][number];

export interface ObservedBackgroundTerminal extends BackgroundTerminal {
  readonly observedAt: number;
}

interface BackgroundTerminalState {
  readonly byThread: ReadonlyMap<string, readonly ObservedBackgroundTerminal[]>;
  readonly errorsByThread: ReadonlyMap<string, string>;
  readonly loadedThreadIds: ReadonlySet<string>;
  readonly terminatingKeys: ReadonlySet<string>;
}

const EMPTY_STATE = Object.freeze({
  byThread: new Map<string, readonly ObservedBackgroundTerminal[]>(),
  errorsByThread: new Map<string, string>(),
  loadedThreadIds: new Set<string>(),
  terminatingKeys: new Set<string>(),
}) satisfies BackgroundTerminalState;

export function useBackgroundTerminals(
  client: BackgroundTerminalClient | null,
  currentThreadId: string | null,
) {
  const [state, setState] = useState<BackgroundTerminalState>(EMPTY_STATE);
  const clientRef = useRef(client);
  const currentThreadIdRef = useRef(currentThreadId);
  const connectionGenerationRef = useRef(0);
  const refreshSequencesRef = useRef(new Map<string, number>());
  clientRef.current = client;
  currentThreadIdRef.current = currentThreadId;

  const refreshThread = useCallback((
    target: BackgroundTerminalClient,
    threadId: string,
    connectionGeneration: number,
  ) => {
    const sequence = (refreshSequencesRef.current.get(threadId) ?? 0) + 1;
    refreshSequencesRef.current.set(threadId, sequence);
    void listAllBackgroundTerminals(target, threadId).then(
      (terminals) => {
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== target ||
          refreshSequencesRef.current.get(threadId) !== sequence
        ) {
          return;
        }
        setState((current) =>
          replaceThreadTerminals(current, threadId, terminals),
        );
      },
      () => {
        if (
          connectionGeneration !== connectionGenerationRef.current ||
          clientRef.current !== target ||
          refreshSequencesRef.current.get(threadId) !== sequence
        ) {
          return;
        }
        setState((current) =>
          withThreadError(
            current,
            threadId,
            "无法同步服务器上的运行中命令",
          ),
        );
      },
    );
  }, []);

  useEffect(() => {
    const generation = ++connectionGenerationRef.current;
    refreshSequencesRef.current.clear();
    setState(EMPTY_STATE);
    if (client === null) {
      return;
    }
    const retryTimers = new Set<number>();
    const release = client.subscribeNotifications((notification) => {
      if (generation !== connectionGenerationRef.current) {
        return;
      }
      const changedThreadId = terminalSnapshotThreadId(notification);
      if (changedThreadId !== null) {
        refreshThread(client, changedThreadId, generation);
        if (
          notification.method === "item/started" &&
          notification.params.item.type === "commandExecution"
        ) {
          const timer = window.setTimeout(() => {
            retryTimers.delete(timer);
            if (generation === connectionGenerationRef.current) {
              refreshThread(client, changedThreadId, generation);
            }
          }, 250);
          retryTimers.add(timer);
        }
      } else if (
        notification.method === "thread/deleted" ||
        notification.method === "thread/closed"
      ) {
        refreshSequencesRef.current.set(
          notification.params.threadId,
          (refreshSequencesRef.current.get(notification.params.threadId) ?? 0) + 1,
        );
      }
      setState((current) => reduceBackgroundTerminalNotification(
        current,
        notification,
      ));
    });
    return () => {
      release();
      for (const timer of retryTimers) {
        window.clearTimeout(timer);
      }
      retryTimers.clear();
    };
  }, [client, refreshThread]);

  useEffect(() => {
    if (client === null || currentThreadId === null) {
      return;
    }
    refreshThread(
      client,
      currentThreadId,
      connectionGenerationRef.current,
    );
  }, [client, currentThreadId, refreshThread]);

  const terminate = useCallback(async (processId: string): Promise<boolean> => {
    const target = clientRef.current;
    const threadId = currentThreadIdRef.current;
    if (target === null || threadId === null) {
      return false;
    }
    const key = terminalKey(threadId, processId);
    setState((current) => {
      const terminatingKeys = new Set(current.terminatingKeys);
      terminatingKeys.add(key);
      return {
        ...clearThreadError(current, threadId),
        terminatingKeys,
      };
    });
    try {
      const response = await target.terminateBackgroundTerminal(
        threadId,
        processId,
      ).result;
      if (
        clientRef.current !== target ||
        currentThreadIdRef.current !== threadId
      ) {
        return false;
      }
      if (!response.terminated) {
        setState((current) =>
          withThreadError(current, threadId, "命令已经结束或无法终止"),
        );
        return false;
      }
      setState((current) =>
        removeTerminal(current, threadId, undefined, processId),
      );
      return true;
    } catch {
      if (
        clientRef.current === target &&
        currentThreadIdRef.current === threadId
      ) {
        setState((current) =>
          withThreadError(current, threadId, "无法终止运行中的命令"),
        );
      }
      return false;
    } finally {
      setState((current) => {
        if (!current.terminatingKeys.has(key)) {
          return current;
        }
        const terminatingKeys = new Set(current.terminatingKeys);
        terminatingKeys.delete(key);
        return { ...current, terminatingKeys };
      });
    }
  }, []);

  const counts = useMemo(() => {
    const values = new Map<string, number>();
    for (const [threadId, terminals] of state.byThread) {
      if (terminals.length > 0) {
        values.set(threadId, terminals.length);
      }
    }
    return values as ReadonlyMap<string, number>;
  }, [state.byThread]);
  const currentTerminals = currentThreadId === null
    ? []
    : state.byThread.get(currentThreadId) ?? [];
  const error = currentThreadId === null
    ? null
    : state.errorsByThread.get(currentThreadId) ?? null;
  const loaded = currentThreadId !== null &&
    state.loadedThreadIds.has(currentThreadId);
  const terminatingProcessIds = useMemo(() => {
    if (currentThreadId === null) {
      return new Set<string>() as ReadonlySet<string>;
    }
    const processIds = new Set<string>();
    for (const terminal of currentTerminals) {
      if (state.terminatingKeys.has(terminalKey(
        currentThreadId,
        terminal.processId,
      ))) {
        processIds.add(terminal.processId);
      }
    }
    return processIds as ReadonlySet<string>;
  }, [currentTerminals, currentThreadId, state.terminatingKeys]);

  return {
    counts,
    currentTerminals,
    error,
    loaded,
    terminate,
    terminatingProcessIds,
  } as const;
}

async function listAllBackgroundTerminals(
  client: BackgroundTerminalClient,
  threadId: string,
): Promise<readonly BackgroundTerminal[]> {
  const terminals: BackgroundTerminal[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await client.listBackgroundTerminals(
      threadId,
      cursor,
    ).result;
    terminals.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor !== null && cursor !== undefined);
  return terminals;
}

function reduceBackgroundTerminalNotification(
  state: BackgroundTerminalState,
  notification: ServerNotification,
): BackgroundTerminalState {
  switch (notification.method) {
    case "item/started": {
      const item = notification.params.item;
      if (
        item.type !== "commandExecution" ||
        item.status !== "inProgress" ||
        item.processId === null ||
        item.processId === undefined
      ) {
        return state;
      }
      return upsertTerminal(state, notification.params.threadId, {
        command: item.command,
        cpuPercent: null,
        cwd: item.cwd,
        itemId: item.id,
        observedAt: Date.now(),
        osPid: null,
        processId: item.processId,
        rssKb: null,
      });
    }
    case "item/completed":
      return notification.params.item.type === "commandExecution"
        ? removeTerminal(
            state,
            notification.params.threadId,
            notification.params.item.id,
          )
        : state;
    case "thread/deleted":
    case "thread/closed":
      return removeThread(state, notification.params.threadId);
    default:
      return state;
  }
}

function terminalSnapshotThreadId(
  notification: ServerNotification,
): string | null {
  switch (notification.method) {
    case "item/started":
    case "item/completed":
      return notification.params.item.type === "commandExecution"
        ? notification.params.threadId
        : null;
    case "turn/completed":
      return notification.params.turn.items.some(
        (item) =>
          item.type === "commandExecution" && item.status === "inProgress",
      )
        ? notification.params.threadId
        : null;
    default:
      return null;
  }
}

function replaceThreadTerminals(
  state: BackgroundTerminalState,
  threadId: string,
  terminals: readonly BackgroundTerminal[],
): BackgroundTerminalState {
  const previous = new Map(
    (state.byThread.get(threadId) ?? []).map((terminal) => [
      terminal.processId,
      terminal,
    ]),
  );
  const observedAt = Date.now();
  const next = terminals.map((terminal) => ({
    ...terminal,
    observedAt: previous.get(terminal.processId)?.observedAt ?? observedAt,
  }));
  const byThread = new Map(state.byThread);
  if (next.length === 0) {
    byThread.delete(threadId);
  } else {
    byThread.set(threadId, Object.freeze(next));
  }
  const loadedThreadIds = new Set(state.loadedThreadIds);
  loadedThreadIds.add(threadId);
  return {
    ...clearThreadError(state, threadId),
    byThread,
    loadedThreadIds,
  };
}

function upsertTerminal(
  state: BackgroundTerminalState,
  threadId: string,
  terminal: ObservedBackgroundTerminal,
): BackgroundTerminalState {
  const current = state.byThread.get(threadId) ?? [];
  const previous = current.find(
    ({ processId }) => processId === terminal.processId,
  );
  const next = [
    ...current.filter(({ processId }) => processId !== terminal.processId),
    {
      ...terminal,
      observedAt: previous?.observedAt ?? terminal.observedAt,
    },
  ];
  const byThread = new Map(state.byThread);
  byThread.set(threadId, Object.freeze(next));
  return {
    ...clearThreadError(state, threadId),
    byThread,
  };
}

function removeTerminal(
  state: BackgroundTerminalState,
  threadId: string,
  itemId?: string,
  processId?: string,
): BackgroundTerminalState {
  const current = state.byThread.get(threadId);
  if (current === undefined) {
    return state;
  }
  const next = current.filter((terminal) =>
    itemId !== undefined
      ? terminal.itemId !== itemId
      : terminal.processId !== processId
  );
  if (next.length === current.length) {
    return state;
  }
  const byThread = new Map(state.byThread);
  if (next.length === 0) {
    byThread.delete(threadId);
  } else {
    byThread.set(threadId, Object.freeze(next));
  }
  return { ...state, byThread };
}

function removeThread(
  state: BackgroundTerminalState,
  threadId: string,
): BackgroundTerminalState {
  const byThread = new Map(state.byThread);
  const errorsByThread = new Map(state.errorsByThread);
  const loadedThreadIds = new Set(state.loadedThreadIds);
  byThread.delete(threadId);
  errorsByThread.delete(threadId);
  loadedThreadIds.delete(threadId);
  return {
    ...state,
    byThread,
    errorsByThread,
    loadedThreadIds,
  };
}

function withThreadError(
  state: BackgroundTerminalState,
  threadId: string,
  error: string,
): BackgroundTerminalState {
  const errorsByThread = new Map(state.errorsByThread);
  errorsByThread.set(threadId, error);
  return { ...state, errorsByThread };
}

function clearThreadError(
  state: BackgroundTerminalState,
  threadId: string,
): BackgroundTerminalState {
  if (!state.errorsByThread.has(threadId)) {
    return state;
  }
  const errorsByThread = new Map(state.errorsByThread);
  errorsByThread.delete(threadId);
  return { ...state, errorsByThread };
}

function terminalKey(threadId: string, processId: string): string {
  return `${threadId}\u0000${processId}`;
}
