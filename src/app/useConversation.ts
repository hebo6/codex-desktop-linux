import { useCallback, useEffect, useRef, useState } from "react";

import type { ConversationClient } from "../appServer";
import type {
  ServerNotification,
  ThreadStartResponse,
  TurnStartParams,
} from "../protocol/generated";
import type { RestoredThread, ThreadTurn } from "./useServerThreads";

export interface ConversationState {
  readonly turns: readonly ThreadTurn[];
  readonly activeTurnId: string | null;
  readonly submitting: boolean;
  readonly stopping: boolean;
  readonly error: string | null;
}

export interface ConversationControls extends ConversationState {
  readonly shellCommandActive: boolean;
  readonly sendInput: (
    input: TurnStartParams["input"],
    configuration?: ConversationTurnConfiguration,
  ) => Promise<boolean>;
  readonly queueInput: (input: TurnStartParams["input"]) => Promise<boolean>;
  readonly sendText: (text: string) => Promise<boolean>;
  readonly runShellCommand: (
    command: string,
    configuration?: ConversationTurnConfiguration,
  ) => Promise<boolean>;
  readonly setServiceTier: (serviceTier: string) => Promise<boolean>;
  readonly stop: () => Promise<boolean>;
  readonly runImmediateCommand: (command: "compact" | "review") => Promise<boolean>;
}

export interface ConversationTurnConfiguration {
  readonly cwd?: string | null;
  readonly effort?: string | null;
  readonly model?: string | null;
  readonly permissions?: string | null;
  readonly serviceTier?: string | null;
}

export interface UseConversationOptions {
  readonly client: ConversationClient | null;
  readonly currentThreadId: string | null;
  readonly restoredThread: RestoredThread | null;
  readonly onThreadCreated: (response: ThreadStartResponse) => Promise<void>;
}

interface ConversationSource {
  readonly client: ConversationClient | null;
  readonly threadId: string | null;
}

interface StandaloneShellExecution {
  readonly client: ConversationClient;
  readonly operation: symbol;
  readonly threadId: string;
  readonly turnId: string | null;
}

const EMPTY_STATE = Object.freeze({
  turns: Object.freeze([]),
  activeTurnId: null,
  submitting: false,
  stopping: false,
  error: null,
}) satisfies ConversationState;

export function useConversation({
  client,
  currentThreadId,
  restoredThread,
  onThreadCreated,
}: UseConversationOptions): ConversationControls {
  const [state, setState] = useState<ConversationState>(EMPTY_STATE);
  const currentThreadIdRef = useRef(currentThreadId);
  const clientRef = useRef(client);
  const stateSourceRef = useRef<ConversationSource>({
    client,
    threadId: currentThreadId,
  });
  const submissionRef = useRef<symbol | null>(null);
  const stopRef = useRef<symbol | null>(null);
  const serviceTierRef = useRef<symbol | null>(null);
  const standaloneShellExecutionRef = useRef<StandaloneShellExecution | null>(null);
  const [standaloneShellExecution, setStandaloneShellExecution] =
    useState<StandaloneShellExecution | null>(null);
  currentThreadIdRef.current = currentThreadId;
  clientRef.current = client;

  const updateStandaloneShellExecution = useCallback(
    (execution: StandaloneShellExecution | null) => {
      standaloneShellExecutionRef.current = execution;
      setStandaloneShellExecution(execution);
    },
    [],
  );

  useEffect(() => {
    const previousSource = stateSourceRef.current;
    const sameSource =
      previousSource.client === client &&
      previousSource.threadId === currentThreadId;
    stateSourceRef.current = { client, threadId: currentThreadId };
    const matchingRestoredThread =
      restoredThread?.metadata.id === currentThreadId ? restoredThread : null;
    if (matchingRestoredThread === null) {
      setState((current) =>
        current.submitting || current.stopping
          ? { ...EMPTY_STATE, submitting: current.submitting, stopping: current.stopping }
          : EMPTY_STATE,
      );
      return;
    }
    setState((current) => {
      const turns = sameSource
        ? mergeRestoredTurns(matchingRestoredThread.turns, current.turns)
        : Object.freeze([...matchingRestoredThread.turns]);
      return {
        turns,
        activeTurnId: activeTurnId(turns),
        submitting: current.submitting,
        stopping: current.stopping,
        error: sameSource ? current.error : null,
      };
    });
  }, [client, currentThreadId, restoredThread]);

  useEffect(() => {
    if (client === null) {
      return;
    }
    let frame: number | null = null;
    let queued: ServerNotification[] = [];
    const apply = (notifications: readonly ServerNotification[]) => {
      if (notifications.length === 0) {
        return;
      }
      setState((current) =>
        notifications.reduce(reduceConversationNotification, current),
      );
    };
    const flush = () => {
      frame = null;
      const pending = queued;
      queued = [];
      apply(pending);
    };
    const unsubscribe = client.subscribeNotifications((notification) => {
      const threadId = notificationThreadId(notification);
      if (threadId === null || threadId !== currentThreadIdRef.current) {
        return;
      }
      const standaloneShell = standaloneShellExecutionRef.current;
      if (
        standaloneShell !== null &&
        standaloneShell.client === client &&
        standaloneShell.threadId === threadId
      ) {
        if (
          notification.method === "turn/started" &&
          standaloneShell.turnId === null
        ) {
          updateStandaloneShellExecution({
            ...standaloneShell,
            turnId: notification.params.turn.id,
          });
        } else if (
          notification.method === "turn/completed" &&
          (
            standaloneShell.turnId === null ||
            standaloneShell.turnId === notification.params.turn.id
          )
        ) {
          updateStandaloneShellExecution(null);
        }
      }
      if (isTextDeltaNotification(notification)) {
        queued.push(notification);
        frame ??= window.requestAnimationFrame(flush);
        return;
      }
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      const pending = [...queued, notification];
      queued = [];
      apply(pending);
    });
    return () => {
      unsubscribe();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      queued = [];
    };
  }, [client, currentThreadId, updateStandaloneShellExecution]);

  useEffect(() => {
    const standaloneShell = standaloneShellExecutionRef.current;
    if (
      standaloneShell !== null &&
      (
        standaloneShell.client !== client ||
        standaloneShell.threadId !== currentThreadId
      )
    ) {
      updateStandaloneShellExecution(null);
    }
  }, [client, currentThreadId, updateStandaloneShellExecution]);

  const ensureThread = useCallback(async (
    activeClient: ConversationClient,
    configuration: ConversationTurnConfiguration,
    operation: symbol,
  ): Promise<string | null> => {
    let threadId = currentThreadIdRef.current;
    if (threadId !== null) {
      return threadId;
    }
    const response = await activeClient.startThread({
      historyMode: "paginated",
      ...(configuration.cwd === undefined ? {} : { cwd: configuration.cwd }),
      ...(configuration.model === undefined ? {} : { model: configuration.model }),
      ...(configuration.permissions === undefined
        ? {}
        : { permissions: configuration.permissions }),
      ...(configuration.serviceTier === undefined
        ? {}
        : { serviceTier: configuration.serviceTier }),
    }).result;
    if (
      submissionRef.current !== operation ||
      clientRef.current !== activeClient ||
      currentThreadIdRef.current !== null
    ) {
      return null;
    }
    threadId = response.thread.id;
    currentThreadIdRef.current = threadId;
    await onThreadCreated(response);
    return (
      submissionRef.current === operation &&
      clientRef.current === activeClient &&
      currentThreadIdRef.current === threadId
    )
      ? threadId
      : null;
  }, [onThreadCreated]);

  const shellCommandActive = standaloneShellExecution !== null;

  const sendInput = useCallback(
    async (
      input: TurnStartParams["input"],
      configuration: ConversationTurnConfiguration = {},
    ): Promise<boolean> => {
      if (
        client === null ||
        input.length === 0 ||
        state.submitting ||
        shellCommandActive
      ) {
        return false;
      }
      const operation = Symbol("conversation-submit");
      submissionRef.current = operation;
      setState((current) => ({ ...current, submitting: true, error: null }));
      try {
        const threadId = await ensureThread(client, configuration, operation);
        if (threadId === null) {
          return false;
        }
        const options = {
          clientUserMessageId: crypto.randomUUID(),
          input,
          ...configuration,
        };
        if (
          submissionRef.current !== operation ||
          clientRef.current !== client ||
          currentThreadIdRef.current !== threadId
        ) {
          return false;
        }
        stateSourceRef.current = { client, threadId };
        if (state.activeTurnId === null) {
          const response = await client.startTurn(threadId, options).result;
          if (
            submissionRef.current !== operation ||
            clientRef.current !== client ||
            currentThreadIdRef.current !== threadId
          ) {
            return false;
          }
          setState((current) => ({
            ...withTurn(current, response.turn),
            submitting: false,
            error: null,
          }));
        } else {
          await client.steerTurn(threadId, state.activeTurnId, options).result;
          if (
            submissionRef.current !== operation ||
            clientRef.current !== client ||
            currentThreadIdRef.current !== threadId
          ) {
            return false;
          }
          setState((current) => ({ ...current, submitting: false, error: null }));
        }
        return true;
      } catch {
        if (submissionRef.current === operation) {
          setState((current) => ({
            ...current,
            submitting: false,
            error: "发送结果不确定，请重新读取会话状态后再决定是否重试",
          }));
        }
        return false;
      } finally {
        if (submissionRef.current === operation) {
          submissionRef.current = null;
        }
      }
    }, [
      client,
      ensureThread,
      shellCommandActive,
      state.activeTurnId,
      state.submitting,
    ],
  );

  const sendText = useCallback(
    (text: string): Promise<boolean> => {
      const normalized = text.trim();
      return normalized.length === 0
        ? Promise.resolve(false)
        : sendInput([{ type: "text", text: normalized }]);
    },
    [sendInput],
  );

  const queueInput = useCallback(async (
    input: TurnStartParams["input"],
  ): Promise<boolean> => {
    const threadId = currentThreadIdRef.current;
    if (
      client === null ||
      threadId === null ||
      input.length === 0 ||
      state.activeTurnId === null ||
      state.submitting ||
      state.stopping ||
      shellCommandActive
    ) {
      return false;
    }
    const operation = Symbol("conversation-queue");
    submissionRef.current = operation;
    setState((current) => ({ ...current, submitting: true, error: null }));
    try {
      stateSourceRef.current = { client, threadId };
      await client.queueTurn(threadId, {
        clientUserMessageId: crypto.randomUUID(),
        input,
      }).result;
      if (
        submissionRef.current !== operation ||
        clientRef.current !== client ||
        currentThreadIdRef.current !== threadId
      ) {
        return false;
      }
      setState((current) => ({ ...current, submitting: false, error: null }));
      return true;
    } catch {
      if (submissionRef.current === operation) {
        setState((current) => ({
          ...current,
          submitting: false,
          error: "排队结果不确定，请确认后续回合是否开始再决定是否重试",
        }));
      }
      return false;
    } finally {
      if (submissionRef.current === operation) {
        submissionRef.current = null;
      }
    }
  }, [
    client,
    shellCommandActive,
    state.activeTurnId,
    state.stopping,
    state.submitting,
  ]);

  const runShellCommand = useCallback(async (
    command: string,
    configuration: ConversationTurnConfiguration = {},
  ): Promise<boolean> => {
    const normalized = command.trim();
    if (
      client === null ||
      normalized.length === 0 ||
      state.submitting ||
      state.stopping
    ) {
      return false;
    }
    const operation = Symbol("conversation-shell-command");
    submissionRef.current = operation;
    setState((current) => ({ ...current, submitting: true, error: null }));
    let accepted = false;
    try {
      const threadId = await ensureThread(client, configuration, operation);
      if (threadId === null) {
        return false;
      }
      stateSourceRef.current = { client, threadId };
      if (state.activeTurnId === null) {
        updateStandaloneShellExecution({
          client,
          operation,
          threadId,
          turnId: null,
        });
      }
      await client.runShellCommand(threadId, normalized).result;
      if (
        submissionRef.current !== operation ||
        clientRef.current !== client ||
        currentThreadIdRef.current !== threadId
      ) {
        return false;
      }
      accepted = true;
      setState((current) => ({ ...current, submitting: false, error: null }));
      return true;
    } catch {
      if (submissionRef.current === operation) {
        setState((current) => ({
          ...current,
          submitting: false,
          error: "无法执行 Shell 命令，当前草稿未受影响",
        }));
      }
      return false;
    } finally {
      if (
        !accepted &&
        standaloneShellExecutionRef.current?.operation === operation
      ) {
        updateStandaloneShellExecution(null);
      }
      if (submissionRef.current === operation) {
        submissionRef.current = null;
      }
    }
  }, [
    client,
    ensureThread,
    state.activeTurnId,
    state.stopping,
    state.submitting,
    updateStandaloneShellExecution,
  ]);

  const setServiceTier = useCallback(async (serviceTier: string): Promise<boolean> => {
    const threadId = currentThreadIdRef.current;
    if (
      client === null ||
      threadId === null ||
      state.activeTurnId !== null ||
      state.submitting ||
      state.stopping ||
      serviceTierRef.current !== null
    ) {
      return false;
    }
    const operation = Symbol("conversation-service-tier");
    serviceTierRef.current = operation;
    setState((current) => ({ ...current, error: null }));
    try {
      await client.setServiceTier(threadId, serviceTier).result;
      return serviceTierRef.current === operation &&
        clientRef.current === client &&
        currentThreadIdRef.current === threadId;
    } catch {
      if (serviceTierRef.current === operation) {
        setState((current) => ({
          ...current,
          error: "无法更新当前会话的 Fast 模式",
        }));
      }
      return false;
    } finally {
      if (serviceTierRef.current === operation) {
        serviceTierRef.current = null;
      }
    }
  }, [client, state.activeTurnId, state.stopping, state.submitting]);

  const stop = useCallback(async (): Promise<boolean> => {
    const threadId = currentThreadIdRef.current;
    const turnId = state.activeTurnId;
    if (client === null || threadId === null || turnId === null || state.stopping) {
      return false;
    }
    const operation = Symbol("conversation-stop");
    stopRef.current = operation;
    setState((current) => ({ ...current, stopping: true, error: null }));
    try {
      await client.interruptTurn(threadId, turnId).result;
      if (
        stopRef.current !== operation ||
        clientRef.current !== client ||
        currentThreadIdRef.current !== threadId
      ) {
        return false;
      }
      setState((current) => ({ ...current, stopping: false }));
      return true;
    } catch {
      if (stopRef.current === operation) {
        setState((current) => ({
          ...current,
          stopping: false,
          error: "无法停止当前回合，请重新读取会话状态",
        }));
      }
      return false;
    } finally {
      if (stopRef.current === operation) {
        stopRef.current = null;
      }
    }
  }, [client, state.activeTurnId, state.stopping]);

  const runImmediateCommand = useCallback(async (
    command: "compact" | "review",
  ): Promise<boolean> => {
    const threadId = currentThreadIdRef.current;
    if (
      client === null ||
      threadId === null ||
      state.activeTurnId !== null ||
      state.submitting
    ) {
      return false;
    }
    const operation = Symbol("conversation-command");
    submissionRef.current = operation;
    setState((current) => ({ ...current, submitting: true, error: null }));
    try {
      const request = command === "compact"
        ? client.compactThread(threadId)
        : client.reviewUncommittedChanges(threadId);
      await request.result;
      if (
        submissionRef.current !== operation ||
        clientRef.current !== client ||
        currentThreadIdRef.current !== threadId
      ) {
        return false;
      }
      setState((current) => ({ ...current, submitting: false }));
      return true;
    } catch {
      if (submissionRef.current === operation) {
        setState((current) => ({
          ...current,
          submitting: false,
          error: command === "compact" ? "无法压缩当前上下文" : "无法开始代码审查",
        }));
      }
      return false;
    } finally {
      if (submissionRef.current === operation) {
        submissionRef.current = null;
      }
    }
  }, [client, state.activeTurnId, state.submitting]);

  return {
    ...state,
    shellCommandActive,
    sendInput,
    queueInput,
    sendText,
    runShellCommand,
    setServiceTier,
    stop,
    runImmediateCommand,
  };
}

export function reduceConversationNotification(
  state: ConversationState,
  notification: ServerNotification,
): ConversationState {
  switch (notification.method) {
    case "turn/started":
      return { ...withTurn(state, notification.params.turn), activeTurnId: notification.params.turn.id };
    case "turn/completed":
      return {
        ...withTurn(state, notification.params.turn),
        activeTurnId:
          state.activeTurnId === notification.params.turn.id ? null : state.activeTurnId,
        stopping: false,
      };
    case "item/started":
    case "item/completed":
      return withItem(state, notification.params.turnId, notification.params.item);
    case "item/agentMessage/delta":
      return updateItem(state, notification.params.turnId, notification.params.itemId, (item) =>
        item?.type === "agentMessage"
          ? { ...item, text: item.text + notification.params.delta }
          : { id: notification.params.itemId, type: "agentMessage", text: notification.params.delta },
      );
    case "item/plan/delta":
      return updateItem(state, notification.params.turnId, notification.params.itemId, (item) =>
        item?.type === "plan"
          ? { ...item, text: item.text + notification.params.delta }
          : { id: notification.params.itemId, type: "plan", text: notification.params.delta },
      );
    case "item/commandExecution/outputDelta":
      return updateItem(state, notification.params.turnId, notification.params.itemId, (item) =>
        item?.type === "commandExecution"
          ? {
              ...item,
              aggregatedOutput: (item.aggregatedOutput ?? "") + notification.params.delta,
            }
          : item,
      );
    case "item/fileChange/patchUpdated":
      return updateItem(state, notification.params.turnId, notification.params.itemId, (item) =>
        item?.type === "fileChange" ? { ...item, changes: notification.params.changes } : item,
      );
    case "item/reasoning/summaryPartAdded":
      return updateReasoningPart(
        state,
        notification.params.turnId,
        notification.params.itemId,
        "summary",
        notification.params.summaryIndex,
        "",
      );
    case "item/reasoning/summaryTextDelta":
      return updateReasoningPart(
        state,
        notification.params.turnId,
        notification.params.itemId,
        "summary",
        notification.params.summaryIndex,
        notification.params.delta,
      );
    case "item/reasoning/textDelta":
      return updateReasoningPart(
        state,
        notification.params.turnId,
        notification.params.itemId,
        "content",
        notification.params.contentIndex,
        notification.params.delta,
      );
    default:
      return state;
  }
}

function withTurn(state: ConversationState, turn: ThreadTurn): ConversationState {
  const index = state.turns.findIndex(({ id }) => id === turn.id);
  const turns = [...state.turns];
  const existing = index < 0 ? undefined : turns[index];
  const nextTurn = existing === undefined
    ? turn
    : mergeTurnProjection(existing, turn);
  if (index < 0) {
    turns.push(nextTurn);
  } else {
    turns[index] = nextTurn;
  }
  return { ...state, turns: Object.freeze(turns), activeTurnId: activeTurnId(turns) };
}

function mergeTurnProjection(
  existing: ThreadTurn,
  incoming: ThreadTurn,
): ThreadTurn {
  if (incoming.itemsView === undefined || incoming.itemsView === "full") {
    return incoming;
  }
  if (incoming.clientItemsView === "partial") {
    return incoming;
  }
  if (incoming.itemsView === "notLoaded") {
    return {
      ...incoming,
      items: existing.items,
      itemsView: existing.itemsView ?? "full",
    };
  }
  const existingIds = new Set(existing.items.map(({ id }) => id));
  const incomingById = new Map(incoming.items.map((item) => [item.id, item]));
  return {
    ...incoming,
    items: [
      ...existing.items.map((item) => incomingById.get(item.id) ?? item),
      ...incoming.items.filter(({ id }) => !existingIds.has(id)),
    ],
    itemsView: existing.itemsView === "full" ? "full" : "summary",
    ...(existing.clientItemsView === "partial"
      ? { clientItemsView: "partial" as const }
      : {}),
  };
}

function withItem(
  state: ConversationState,
  turnId: string,
  item: ThreadTurn["items"][number],
): ConversationState {
  return updateItem(state, turnId, item.id, () => item);
}

function updateItem(
  state: ConversationState,
  turnId: string,
  itemId: string,
  update: (
    item: ThreadTurn["items"][number] | undefined,
  ) => ThreadTurn["items"][number] | undefined,
): ConversationState {
  const turnIndex = state.turns.findIndex(({ id }) => id === turnId);
  const turns = [...state.turns];
  const turn =
    turnIndex < 0
      ? ({ id: turnId, items: [], itemsView: "full", status: "inProgress" } satisfies ThreadTurn)
      : turns[turnIndex];
  if (turn === undefined) {
    return state;
  }
  const itemIndex = turn.items.findIndex(({ id }) => id === itemId);
  const items = [...turn.items];
  const nextItem = update(itemIndex < 0 ? undefined : items[itemIndex]);
  if (nextItem === undefined) {
    return state;
  }
  if (itemIndex < 0) {
    items.push(nextItem);
  } else {
    items[itemIndex] = nextItem;
  }
  const nextTurn = { ...turn, items };
  if (turnIndex < 0) {
    turns.push(nextTurn);
  } else {
    turns[turnIndex] = nextTurn;
  }
  return {
    ...state,
    turns: Object.freeze(turns),
    activeTurnId: activeTurnId(turns),
  };
}

function updateReasoningPart(
  state: ConversationState,
  turnId: string,
  itemId: string,
  field: "summary" | "content",
  index: number,
  delta: string,
): ConversationState {
  return updateItem(state, turnId, itemId, (existing) => {
    const item =
      existing?.type === "reasoning"
        ? existing
        : { id: itemId, type: "reasoning" as const };
    const parts = [...(item[field] ?? [])];
    while (parts.length <= index) {
      parts.push("");
    }
    parts[index] = (parts[index] ?? "") + delta;
    return { ...item, [field]: parts };
  });
}

function activeTurnId(turns: readonly ThreadTurn[]): string | null {
  return turns.findLast(({ status }) => status === "inProgress")?.id ?? null;
}

function mergeRestoredTurns(
  restoredTurns: readonly ThreadTurn[],
  currentTurns: readonly ThreadTurn[],
): readonly ThreadTurn[] {
  const currentById = new Map(currentTurns.map((turn) => [turn.id, turn]));
  const restoredIds = new Set(restoredTurns.map(({ id }) => id));
  return Object.freeze([
    ...restoredTurns.map((turn) => {
      const current = currentById.get(turn.id);
      return current === undefined ? turn : mergeTurnProjection(current, turn);
    }),
    ...currentTurns.filter(({ id }) => !restoredIds.has(id)),
  ]);
}

function notificationThreadId(notification: ServerNotification): string | null {
  const params: unknown = notification.params;
  if (typeof params !== "object" || params === null || !("threadId" in params)) {
    return null;
  }
  return typeof params.threadId === "string" ? params.threadId : null;
}

function isTextDeltaNotification(notification: ServerNotification): boolean {
  return notification.method === "item/agentMessage/delta" ||
    notification.method === "item/plan/delta" ||
    notification.method === "item/commandExecution/outputDelta" ||
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/reasoning/textDelta";
}
