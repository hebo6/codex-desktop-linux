import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConversationClient } from "../appServer";
import type { ServerNotification } from "../protocol/generated";
import { useTurnPlan } from "./useTurnPlan";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

class FakeNotificationClient {
  readonly handlers = new Set<(notification: ServerNotification) => void>();

  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(notification: ServerNotification) {
    for (const handler of this.handlers) {
      handler(notification);
    }
  }
}

describe("useTurnPlan", () => {
  it("展示最新任务计划并在回合完成后清除", () => {
    const client = new FakeNotificationClient() as unknown as ConversationClient;
    const { result } = renderHook(() =>
      useTurnPlan(client, THREAD_ID, [THREAD_ID])
    );

    act(() => {
      (client as unknown as FakeNotificationClient).emit(planUpdated([
        { status: "inProgress", step: "检查实现" },
        { status: "pending", step: "运行测试" },
      ]));
    });
    expect(result.current).toMatchObject({
      explanation: "先确认现状",
      turnId: TURN_ID,
      steps: [
        { status: "inProgress", step: "检查实现" },
        { status: "pending", step: "运行测试" },
      ],
    });

    act(() => {
      (client as unknown as FakeNotificationClient).emit(planUpdated([
        { status: "completed", step: "检查实现" },
        { status: "inProgress", step: "运行测试" },
      ]));
    });
    expect(result.current?.steps).toEqual([
      { status: "completed", step: "检查实现" },
      { status: "inProgress", step: "运行测试" },
    ]);

    act(() => {
      (client as unknown as FakeNotificationClient).emit({
        method: "turn/completed",
        params: {
          threadId: THREAD_ID,
          turn: {
            id: TURN_ID,
            items: [],
            itemsView: "notLoaded",
            status: "completed",
          },
        },
      } as ServerNotification);
    });
    expect(result.current).toBeNull();
  });

  it("新回合开始和关闭会话时不保留旧计划", () => {
    const source = new FakeNotificationClient();
    const client = source as unknown as ConversationClient;
    const { result } = renderHook(() =>
      useTurnPlan(client, THREAD_ID, [THREAD_ID])
    );

    act(() => source.emit(planUpdated([
      { status: "pending", step: "旧计划" },
    ])));
    act(() => source.emit({
      method: "turn/started",
      params: {
        threadId: THREAD_ID,
        turn: {
          id: "turn-2",
          items: [],
          itemsView: "full",
          status: "inProgress",
        },
      },
    } as ServerNotification));
    expect(result.current).toBeNull();

    act(() => source.emit(planUpdated([
      { status: "pending", step: "临时计划" },
    ])));
    act(() => source.emit({
      method: "thread/closed",
      params: { threadId: THREAD_ID },
    } as ServerNotification));
    expect(result.current).toBeNull();
  });
});

function planUpdated(
  plan: readonly {
    readonly status: "completed" | "inProgress" | "pending";
    readonly step: string;
  }[],
): ServerNotification {
  return {
    method: "turn/plan/updated",
    params: {
      explanation: "先确认现状",
      plan: [...plan],
      threadId: THREAD_ID,
      turnId: TURN_ID,
    },
  };
}
