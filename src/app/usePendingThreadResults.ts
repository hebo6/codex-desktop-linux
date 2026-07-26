import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ServerId } from "../configuration";
import type { ServerNotification } from "../protocol/generated";
import {
  pendingThreadResultStore as persistentPendingThreadResultStore,
  type PendingThreadResultStore,
} from "../transport/pendingThreadResults";
import {
  windowFocusSource as defaultWindowFocusSource,
  type WindowFocusSource,
} from "../transport/windowFocus";
import type { ServerThreadsClient, ThreadTurn } from "./useServerThreads";

interface PendingResultState {
  readonly serverId: ServerId | null;
  readonly turns: ReadonlyMap<string, string>;
}

interface PendingResultOverrides {
  readonly serverId: ServerId | null;
  readonly turns: Map<string, string | null>;
}

export interface UsePendingThreadResultsOptions {
  readonly activeThreadId: string | null;
  readonly activeThreadReady: boolean;
  readonly activeTurns: readonly Pick<ThreadTurn, "id" | "status">[];
  readonly client: Pick<ServerThreadsClient, "subscribeNotifications"> | null;
  readonly serverId: ServerId | null;
  readonly store?: PendingThreadResultStore;
  readonly windowFocusSource?: WindowFocusSource;
}

export interface PendingThreadResults {
  readonly pendingThreadIds: ReadonlySet<string>;
  readonly clear: (threadId: string) => void;
}

const EMPTY_PENDING_THREAD_IDS: ReadonlySet<string> = new Set();

export function usePendingThreadResults({
  activeThreadId,
  activeThreadReady,
  activeTurns,
  client,
  serverId,
  store = persistentPendingThreadResultStore,
  windowFocusSource = defaultWindowFocusSource,
}: UsePendingThreadResultsOptions): PendingThreadResults {
  const [state, setState] = useState<PendingResultState>({
    serverId: null,
    turns: new Map(),
  });
  const overridesRef = useRef<PendingResultOverrides>({
    serverId: null,
    turns: new Map(),
  });
  const acknowledgementsRef = useRef(new Set<string>());
  const windowFocused = useWindowFocused(windowFocusSource);
  const modalLayerOpen = useModalLayerOpen();
  const pendingTurns = state.serverId === serverId
    ? state.turns
    : EMPTY_PENDING_TURNS;

  const replacePending = useCallback((
    targetServerId: ServerId,
    threadId: string,
    turnId: string | null,
  ) => {
    const overrides = overridesRef.current;
    if (overrides.serverId === targetServerId) {
      overrides.turns.set(threadId, turnId);
    }
    setState((current) => {
      const turns = new Map(
        current.serverId === targetServerId ? current.turns : [],
      );
      if (turnId === null) {
        turns.delete(threadId);
      } else {
        turns.set(threadId, turnId);
      }
      return { serverId: targetServerId, turns };
    });
  }, []);

  const removePendingTurn = useCallback((
    targetServerId: ServerId,
    threadId: string,
    turnId: string,
  ) => {
    const overrides = overridesRef.current;
    if (
      overrides.serverId === targetServerId
      && overrides.turns.get(threadId) === turnId
    ) {
      overrides.turns.set(threadId, null);
    }
    setState((current) => {
      if (
        current.serverId !== targetServerId
        || current.turns.get(threadId) !== turnId
      ) {
        return current;
      }
      const turns = new Map(current.turns);
      turns.delete(threadId);
      return { ...current, turns };
    });
  }, []);

  useEffect(() => {
    overridesRef.current = { serverId, turns: new Map() };
    setState({ serverId, turns: new Map() });
    acknowledgementsRef.current.clear();
    if (serverId === null) {
      return;
    }
    let disposed = false;
    void store.list(serverId).then(
      (results) => {
        if (disposed || overridesRef.current.serverId !== serverId) {
          return;
        }
        const turns = new Map(
          results.map(({ threadId, turnId }) => [threadId, turnId]),
        );
        for (const [threadId, turnId] of overridesRef.current.turns) {
          if (turnId === null) {
            turns.delete(threadId);
          } else {
            turns.set(threadId, turnId);
          }
        }
        setState({ serverId, turns });
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [serverId, store]);

  const clear = useCallback((threadId: string) => {
    if (serverId === null) {
      return;
    }
    replacePending(serverId, threadId, null);
    void store.clear(serverId, threadId).catch(() => undefined);
  }, [replacePending, serverId, store]);

  useEffect(() => {
    if (client === null || serverId === null) {
      return;
    }
    return client.subscribeNotifications((notification) => {
      if (
        notification.method === "thread/archived"
        || notification.method === "thread/deleted"
      ) {
        const threadId = notification.params.threadId;
        replacePending(serverId, threadId, null);
        void store.clear(serverId, threadId).catch(() => undefined);
        return;
      }
      if (notification.method === "turn/started") {
        const threadId = notification.params.threadId;
        replacePending(serverId, threadId, null);
        void store.clear(serverId, threadId).catch(() => undefined);
        return;
      }
      if (
        notification.method !== "turn/completed"
        || notification.params.turn.status !== "completed"
      ) {
        return;
      }
      const { threadId, turn } = notification.params;
      replacePending(serverId, threadId, turn.id);
      void store.record(serverId, threadId, turn.id).catch(() => undefined);
    });
  }, [client, replacePending, serverId, store]);

  const activePendingTurnId = activeThreadId === null
    ? undefined
    : pendingTurns.get(activeThreadId);
  const activeResultRendered =
    activePendingTurnId !== undefined
    && activeTurns.some(
      (turn) =>
        turn.id === activePendingTurnId
        && turn.status === "completed",
    );
  const activeConversationVisible =
    activeThreadId !== null
    && activeThreadReady
    && windowFocused
    && !modalLayerOpen;

  useEffect(() => {
    if (
      serverId === null
      || activeThreadId === null
      || activePendingTurnId === undefined
      || !activeConversationVisible
      || !activeResultRendered
    ) {
      return;
    }
    const acknowledgementKey =
      `${serverId}\u0000${activeThreadId}\u0000${activePendingTurnId}`;
    if (acknowledgementsRef.current.has(acknowledgementKey)) {
      return;
    }
    acknowledgementsRef.current.add(acknowledgementKey);
    void store
      .acknowledge(serverId, activeThreadId, activePendingTurnId)
      .catch(() => undefined)
      .then(() => {
        acknowledgementsRef.current.delete(acknowledgementKey);
        removePendingTurn(serverId, activeThreadId, activePendingTurnId);
      });
  }, [
    activeConversationVisible,
    activePendingTurnId,
    activeResultRendered,
    activeThreadId,
    removePendingTurn,
    serverId,
    store,
  ]);

  const pendingThreadIds = useMemo<ReadonlySet<string>>(() => {
    if (pendingTurns.size === 0) {
      return EMPTY_PENDING_THREAD_IDS;
    }
    const visible = new Set(pendingTurns.keys());
    if (activeConversationVisible && activeThreadId !== null) {
      visible.delete(activeThreadId);
    }
    return visible;
  }, [activeConversationVisible, activeThreadId, pendingTurns]);

  return { pendingThreadIds, clear };
}

const EMPTY_PENDING_TURNS: ReadonlyMap<string, string> = new Map();

function useWindowFocused(source: WindowFocusSource): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let disposed = false;
    let focusEventReceived = false;
    let release: (() => void) | null = null;
    void source.subscribe((nextFocused) => {
      focusEventReceived = true;
      if (!disposed) {
        setFocused(nextFocused);
      }
    }).then(
      (unsubscribe) => {
        if (disposed) {
          unsubscribe();
        } else {
          release = unsubscribe;
        }
      },
      () => undefined,
    );
    void source.current().then(
      (currentFocused) => {
        if (!disposed && !focusEventReceived) {
          setFocused(currentFocused);
        }
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      release?.();
    };
  }, [source]);
  return focused;
}

function useModalLayerOpen(): boolean {
  const readModalLayer = () =>
    document.querySelector('[aria-modal="true"]') !== null;
  const [open, setOpen] = useState(readModalLayer);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setOpen(readModalLayer());
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-modal"],
      childList: true,
      subtree: true,
    });
    setOpen(readModalLayer());
    return () => observer.disconnect();
  }, []);
  return open;
}
