import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import type { ServerNotification } from "../protocol/generated";
import type {
  PendingThreadResult,
  PendingThreadResultStore,
} from "../transport/pendingThreadResults";
import type { WindowFocusSource } from "../transport/windowFocus";
import { usePendingThreadResults } from "./usePendingThreadResults";
import type { ThreadTurn } from "./useServerThreads";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

function testStore(initial: readonly PendingThreadResult[] = []) {
  let persisted = new Map(initial.map(({ threadId, turnId }) => [threadId, turnId]));
  const store: PendingThreadResultStore = {
    list: vi.fn(async () =>
      [...persisted].map(([threadId, turnId]) => ({ threadId, turnId }))
    ),
    record: vi.fn(async (_serverId, threadId, turnId) => {
      persisted.set(threadId, turnId);
    }),
    acknowledge: vi.fn(async (_serverId, threadId, turnId) => {
      if (persisted.get(threadId) === turnId) {
        persisted.delete(threadId);
      }
    }),
    clear: vi.fn(async (_serverId, threadId) => {
      persisted.delete(threadId);
    }),
  };
  return store;
}

function notificationSource() {
  const handlers = new Set<(notification: ServerNotification) => void>();
  return {
    client: {
      subscribeNotifications(handler: (notification: ServerNotification) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
    emit(notification: ServerNotification) {
      for (const handler of handlers) {
        handler(notification);
      }
    },
  };
}

function focusSource(initial: boolean) {
  let focused = initial;
  const handlers = new Set<(next: boolean) => void>();
  const source: WindowFocusSource = {
    current: vi.fn(async () => focused),
    subscribe: vi.fn(async (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
  };
  return {
    source,
    set(next: boolean) {
      focused = next;
      for (const handler of handlers) {
        handler(next);
      }
    },
  };
}

function completed(threadId: string, turnId: string): ServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        items: [],
        itemsView: "full",
        status: "completed",
      },
    },
  };
}

function completedTurn(turnId: string): ThreadTurn {
  return {
    id: turnId,
    items: [],
    itemsView: "full",
    status: "completed",
  };
}

describe("usePendingThreadResults", () => {
  it("记录后台完成结果并在内容呈现后精确确认", async () => {
    const store = testStore();
    const notifications = notificationSource();
    const focus = focusSource(true);
    const { result, rerender } = renderHook(
      ({ activeThreadId, activeTurns }) =>
        usePendingThreadResults({
          activeThreadId,
          activeThreadReady: true,
          activeTurns,
          client: notifications.client,
          serverId: SERVER_ID,
          store,
          windowFocusSource: focus.source,
        }),
      {
        initialProps: {
          activeThreadId: "thread-a",
          activeTurns: [] as readonly ThreadTurn[],
        },
      },
    );

    await waitFor(() => expect(focus.source.current).toHaveBeenCalledOnce());
    act(() => notifications.emit(completed("thread-b", "turn-b")));

    expect(result.current.pendingThreadIds).toContain("thread-b");
    expect(store.record).toHaveBeenCalledWith(
      SERVER_ID,
      "thread-b",
      "turn-b",
    );

    rerender({
      activeThreadId: "thread-b",
      activeTurns: [completedTurn("turn-b")],
    });

    expect(result.current.pendingThreadIds).not.toContain("thread-b");
    await waitFor(() =>
      expect(store.acknowledge).toHaveBeenCalledWith(
        SERVER_ID,
        "thread-b",
        "turn-b",
      )
    );
  });

  it("窗口重新聚焦前保留当前会话的完成结果", async () => {
    const store = testStore();
    const notifications = notificationSource();
    const focus = focusSource(false);
    const { result, rerender } = renderHook(
      ({ activeTurns }) =>
        usePendingThreadResults({
          activeThreadId: "thread-a",
          activeThreadReady: true,
          activeTurns,
          client: notifications.client,
          serverId: SERVER_ID,
          store,
          windowFocusSource: focus.source,
        }),
      { initialProps: { activeTurns: [] as readonly ThreadTurn[] } },
    );

    act(() => notifications.emit(completed("thread-a", "turn-a")));
    rerender({ activeTurns: [completedTurn("turn-a")] });

    expect(result.current.pendingThreadIds).toContain("thread-a");

    act(() => focus.set(true));

    expect(result.current.pendingThreadIds).not.toContain("thread-a");
    await waitFor(() => expect(store.acknowledge).toHaveBeenCalledOnce());
  });

  it("模态浮层关闭前不确认结果且新回合清除旧结果", async () => {
    const store = testStore([{ threadId: "thread-a", turnId: "turn-a" }]);
    const notifications = notificationSource();
    const focus = focusSource(true);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    const { result } = renderHook(() =>
      usePendingThreadResults({
        activeThreadId: "thread-a",
        activeThreadReady: true,
        activeTurns: [completedTurn("turn-a")],
        client: notifications.client,
        serverId: SERVER_ID,
        store,
        windowFocusSource: focus.source,
      })
    );

    await waitFor(() =>
      expect(result.current.pendingThreadIds).toContain("thread-a")
    );
    expect(store.acknowledge).not.toHaveBeenCalled();

    act(() => {
      notifications.emit({
        method: "turn/started",
        params: {
          threadId: "thread-a",
          turn: {
            id: "turn-next",
            items: [],
            itemsView: "full",
            status: "inProgress",
          },
        },
      });
    });

    expect(result.current.pendingThreadIds).not.toContain("thread-a");
    expect(store.clear).toHaveBeenCalledWith(SERVER_ID, "thread-a");
    modal.remove();
  });
});
