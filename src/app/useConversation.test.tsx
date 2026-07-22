import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationClient, StartTurnOptions } from "../appServer";
import type {
  ServerNotification,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadSettingsUpdateResponse,
  TurnInterruptResponse,
  TurnStartResponse,
  TurnSteerResponse,
  ReviewStartResponse,
} from "../protocol/generated";
import type { RequestHandle } from "../protocol/rpc";
import { reduceConversationNotification, useConversation } from "./useConversation";
import type { ConversationState } from "./useConversation";
import type { RestoredThread, ThreadTurn } from "./useServerThreads";

const RUNNING_TURN = {
  id: "turn-1",
  items: [{ id: "agent-1", type: "agentMessage", text: "开" }],
  itemsView: "full",
  status: "inProgress",
} satisfies ThreadTurn;

class FakeConversationClient implements ConversationClient {
  readonly startThreadCalls: ThreadStartParams[] = [];
  readonly startTurnCalls: Array<{ threadId: string; options: StartTurnOptions }> = [];
  readonly steerCalls: Array<{
    threadId: string;
    turnId: string;
    options: StartTurnOptions;
  }> = [];
  readonly interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  readonly serviceTierCalls: Array<{ threadId: string; serviceTier: string }> = [];
  threadStartResponse!: ThreadStartResponse;
  turnStartResponse!: TurnStartResponse;
  notificationHandler: ((notification: ServerNotification) => void) | null = null;

  startThread(params: ThreadStartParams = {}) {
    this.startThreadCalls.push(params);
    return handle(Promise.resolve(this.threadStartResponse));
  }

  startTurn(threadId: string, options: StartTurnOptions) {
    this.startTurnCalls.push({ threadId, options });
    return handle(Promise.resolve(this.turnStartResponse));
  }

  setServiceTier(threadId: string, serviceTier: string) {
    this.serviceTierCalls.push({ threadId, serviceTier });
    return handle(Promise.resolve({} satisfies ThreadSettingsUpdateResponse));
  }

  steerTurn(threadId: string, turnId: string, options: StartTurnOptions) {
    this.steerCalls.push({ threadId, turnId, options });
    return handle(Promise.resolve({ turnId } satisfies TurnSteerResponse));
  }

  interruptTurn(threadId: string, turnId: string) {
    this.interruptCalls.push({ threadId, turnId });
    return handle(Promise.resolve({} satisfies TurnInterruptResponse));
  }

  compactThread() {
    return handle(Promise.resolve({}));
  }

  reviewUncommittedChanges() {
    return handle(Promise.resolve({} as ReviewStartResponse));
  }

  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.notificationHandler = handler;
    return () => {
      this.notificationHandler = null;
    };
  }
}

function handle<T>(result: Promise<T>): RequestHandle<T> {
  return { epoch: 1, id: "request", stage: "pending", result };
}

function restored(turns: readonly ThreadTurn[]): RestoredThread {
  return {
    metadata: {
      cliVersion: "1.0.0",
      createdAt: 100,
      cwd: "/workspace",
      ephemeral: false,
      id: "thread-1",
      modelProvider: "openai",
      preview: "任务",
      sessionId: "session-1",
      source: "appServer",
      status: { type: "active", activeFlags: [] },
      turns: [...turns],
      updatedAt: 200,
    },
    modelSettings: { effort: "medium", model: "gpt-5", serviceTier: null },
    turns,
    nextCursor: null,
  };
}

describe("useConversation", () => {
  it("按增量追加并以完成快照校正且保持 ID 幂等", () => {
    const initial: ConversationState = {
      turns: [RUNNING_TURN],
      activeTurnId: RUNNING_TURN.id,
      submitting: false,
      stopping: false,
      error: null,
    };
    const delta = {
      method: "item/agentMessage/delta",
      params: {
        delta: "始",
        itemId: "agent-1",
        threadId: "thread-1",
        turnId: RUNNING_TURN.id,
      },
    } as ServerNotification;
    const completedItem = {
      method: "item/completed",
      params: {
        completedAtMs: 1,
        item: { id: "agent-1", type: "agentMessage", text: "最终内容" },
        threadId: "thread-1",
        turnId: RUNNING_TURN.id,
      },
    } as ServerNotification;

    const streaming = reduceConversationNotification(initial, delta);
    expect(streaming.turns[0]?.items[0]).toMatchObject({ text: "开始" });
    const completed = reduceConversationNotification(streaming, completedItem);
    const duplicate = reduceConversationNotification(completed, completedItem);
    expect(duplicate.turns[0]?.items).toHaveLength(1);
    expect(duplicate.turns[0]?.items[0]).toMatchObject({ text: "最终内容" });
  });

  it("完成通知只更新回合状态并保留已流式接收的内容", () => {
    const initial: ConversationState = {
      turns: [RUNNING_TURN],
      activeTurnId: RUNNING_TURN.id,
      submitting: false,
      stopping: false,
      error: null,
    };
    const notification = {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: RUNNING_TURN.id,
          items: [],
          itemsView: "notLoaded",
          status: "completed",
          completedAt: 104,
          durationMs: 3_500,
        },
      },
    } as ServerNotification;

    const completed = reduceConversationNotification(initial, notification);

    expect(completed.turns[0]).toMatchObject({
      status: "completed",
      completedAt: 104,
      durationMs: 3_500,
      items: RUNNING_TURN.items,
    });
    expect(completed.activeTurnId).toBeNull();
  });

  it("空白页先创建 thread 再创建 turn", async () => {
    const client = new FakeConversationClient();
    client.threadStartResponse = {
      thread: restored([]).metadata,
    } as ThreadStartResponse;
    client.turnStartResponse = { turn: RUNNING_TURN };
    const onThreadCreated = vi.fn(async () => undefined);
    const { result } = renderHook(() =>
      useConversation({
        client,
        currentThreadId: null,
        restoredThread: null,
        onThreadCreated,
      }),
    );

    await act(async () => {
      expect(await result.current.sendText("新任务")).toBe(true);
    });

    expect(onThreadCreated).toHaveBeenCalledWith(client.threadStartResponse);
    expect(client.startTurnCalls[0]).toMatchObject({ threadId: "thread-1" });
    expect(client.startTurnCalls[0]?.options.input).toEqual([
      { type: "text", text: "新任务" },
    ]);
    expect(result.current.activeTurnId).toBe(RUNNING_TURN.id);
  });

  it("新会话把显式 Fast 速率传给 thread 和首个 turn", async () => {
    const client = new FakeConversationClient();
    client.threadStartResponse = {
      thread: restored([]).metadata,
    } as ThreadStartResponse;
    client.turnStartResponse = { turn: RUNNING_TURN };
    const { result } = renderHook(() =>
      useConversation({
        client,
        currentThreadId: null,
        restoredThread: null,
        onThreadCreated: vi.fn(async () => undefined),
      }),
    );

    await act(async () => {
      expect(await result.current.sendInput(
        [{ type: "text", text: "快速处理" }],
        { serviceTier: "priority" },
      )).toBe(true);
    });

    expect(client.startThreadCalls[0]).toMatchObject({ serviceTier: "priority" });
    expect(client.startTurnCalls[0]?.options).toMatchObject({ serviceTier: "priority" });
  });

  it("已有会话只通过线程设置更新 Fast 速率", async () => {
    const client = new FakeConversationClient();
    const snapshot = restored([]);
    const { result } = renderHook(() =>
      useConversation({
        client,
        currentThreadId: "thread-1",
        restoredThread: snapshot,
        onThreadCreated: vi.fn(async () => undefined),
      }),
    );

    await waitFor(() => expect(result.current.activeTurnId).toBeNull());
    await act(async () => {
      expect(await result.current.setServiceTier("priority")).toBe(true);
    });

    expect(client.serviceTierCalls).toEqual([
      { threadId: "thread-1", serviceTier: "priority" },
    ]);
  });

  it("新建线程的空恢复快照不会覆盖首个回合", async () => {
    const client = new FakeConversationClient();
    client.threadStartResponse = {
      thread: restored([]).metadata,
    } as ThreadStartResponse;
    client.turnStartResponse = { turn: RUNNING_TURN };
    const { result, rerender } = renderHook(
      ({ currentThreadId, restoredThread }) =>
        useConversation({
          client,
          currentThreadId,
          restoredThread,
          onThreadCreated: vi.fn(async () => undefined),
        }),
      {
        initialProps: {
          currentThreadId: null as string | null,
          restoredThread: null as RestoredThread | null,
        },
      },
    );

    await act(async () => {
      expect(await result.current.sendText("新任务")).toBe(true);
    });
    expect(result.current.turns).toEqual([RUNNING_TURN]);

    rerender({
      currentThreadId: "thread-1",
      restoredThread: restored([]),
    });

    await waitFor(() => expect(result.current.turns).toEqual([RUNNING_TURN]));
    expect(result.current.activeTurnId).toBe(RUNNING_TURN.id);
  });

  it("同一帧内只提交一次纯文本增量渲染", async () => {
    const client = new FakeConversationClient();
    let pendingFrame: FrameRequestCallback | null = null;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        pendingFrame = callback;
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const snapshot = restored([RUNNING_TURN]);
    const { result } = renderHook(() =>
      useConversation({
        client,
        currentThreadId: "thread-1",
        restoredThread: snapshot,
        onThreadCreated: vi.fn(async () => undefined),
      }),
    );
    await waitFor(() => expect(result.current.turns).toHaveLength(1));

    act(() => {
      client.notificationHandler?.({
        method: "item/agentMessage/delta",
        params: {
          delta: "始",
          itemId: "agent-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      } as ServerNotification);
      client.notificationHandler?.({
        method: "item/agentMessage/delta",
        params: {
          delta: "结束",
          itemId: "agent-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      } as ServerNotification);
    });

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(result.current.turns[0]?.items[0]).toMatchObject({ text: "开" });
    act(() => pendingFrame?.(16));
    expect(result.current.turns[0]?.items[0]).toMatchObject({ text: "开始结束" });
  });

  it("运行中发送 steer 并能停止当前回合", async () => {
    const client = new FakeConversationClient();
    const snapshot = restored([RUNNING_TURN]);
    const { result } = renderHook(() =>
      useConversation({
        client,
        currentThreadId: "thread-1",
        restoredThread: snapshot,
        onThreadCreated: vi.fn(async () => undefined),
      }),
    );
    await waitFor(() => expect(result.current.activeTurnId).toBe(RUNNING_TURN.id));

    await act(async () => {
      expect(await result.current.sendText("追加说明")).toBe(true);
      expect(await result.current.stop()).toBe(true);
    });

    expect(client.steerCalls).toHaveLength(1);
    expect(client.interruptCalls).toEqual([
      { threadId: "thread-1", turnId: RUNNING_TURN.id },
    ]);
  });
});
