import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PendingInteraction } from "../appServer/interactionClient";
import type { ServerNotification } from "../protocol/generated";
import type { ThreadTurn } from "./useServerThreads";
import { useUserInputNotifications } from "./useUserInputNotifications";

const QUESTION = {
  id: "question-1",
  type: "agentMessage",
  delivery: "async",
  text: "不应出现在通知中的正文",
  questions: [{ title: "不应出现在通知中的问题", options: ["选项一", "选项二"] }],
} satisfies ThreadTurn["items"][number];

const REQUEST: PendingInteraction = {
  key: "number:1",
  responding: false,
  threadId: "thread-1",
  request: {
    id: 1,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "input-1",
      isBlocking: true,
      questions: [{ id: "choice", header: "方向", question: "同步问题正文" }],
    },
  },
};

function notificationSource() {
  const handlers = new Set<(notification: ServerNotification) => void>();
  return {
    client: {
      subscribeNotifications(handler: (notification: ServerNotification) => void) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
    },
    emit(notification: ServerNotification) {
      for (const handler of handlers) handler(notification);
    },
  };
}

function completed(
  item: ThreadTurn["items"][number] = QUESTION,
  threadId = "thread-1",
): ServerNotification {
  return {
    method: "item/completed",
    params: { threadId, turnId: "turn-1", item, completedAtMs: 1 },
  };
}

function setup() {
  const source = notificationSource();
  const props: Parameters<typeof useUserInputNotifications>[0] = {
    client: source.client,
    enabled: true,
    notificationService: {
      permission: vi.fn(async () => "granted" as const),
      requestPermission: vi.fn(async () => "granted" as const),
      show: vi.fn(async () => true),
    },
    pending: [],
    subscribedThreadIds: ["thread-1", "thread-2"],
    windowId: "main",
  };
  const hook = renderHook(useUserInputNotifications, { initialProps: props });
  return { ...hook, props, source, show: props.notificationService.show };
}

describe("useUserInputNotifications", () => {
  it("异步提问只在完成时通知一次，不泄露问题正文，后台标签同样通知", () => {
    const { source, show } = setup();
    act(() => source.emit({
      method: "item/started",
      params: { threadId: "thread-2", turnId: "turn-1", item: QUESTION, startedAtMs: 1 },
    }));
    expect(show).not.toHaveBeenCalled();

    act(() => {
      source.emit(completed(QUESTION, "thread-2"));
      source.emit(completed(QUESTION, "thread-2"));
    });
    expect(show).toHaveBeenCalledExactlyOnceWith({
      title: "Codex 需要你的回答",
      body: "返回对应窗口查看并回答问题",
      tag: "question:main:thread-2",
    });

    act(() => source.emit(completed({ ...QUESTION, id: "question-2" }, "thread-2")));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("普通消息、未打开的会话和回合历史快照不触发提问通知", () => {
    const { source, show } = setup();
    act(() => {
      source.emit(completed({ ...QUESTION, delivery: null }));
      source.emit(completed({ ...QUESTION, questions: [] }));
      source.emit(completed({ type: "agentMessage", id: "text", text: "普通异步消息", delivery: "async" }));
      source.emit(completed(QUESTION, "unopened-thread"));
      source.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [QUESTION], itemsView: "full", status: "completed" },
        },
      });
    });
    expect(show).not.toHaveBeenCalled();
  });

  it("关闭期间收到的提问和已通知问题不会在重新开启或重渲染时补发", () => {
    const { props, source, show, rerender } = setup();
    rerender({ ...props, enabled: false, pending: [REQUEST] });
    act(() => source.emit(completed()));
    expect(show).not.toHaveBeenCalled();

    rerender({ ...props, pending: [REQUEST], subscribedThreadIds: [...props.subscribedThreadIds] });
    act(() => source.emit(completed()));
    expect(show).not.toHaveBeenCalled();

    act(() => source.emit(completed({ ...QUESTION, id: "question-2" })));
    expect(show).toHaveBeenCalledOnce();
    rerender({ ...props, pending: [REQUEST] });
    expect(show).toHaveBeenCalledOnce();
  });

  it("同步提问到达时通知，提交、其他交互更新和已在响应的请求不重复提醒", () => {
    const { props, show, rerender } = setup();
    const approval: PendingInteraction = {
      key: "number:2", responding: false, threadId: "thread-1",
      request: {
        id: 2, method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1", startedAtMs: 1 },
      },
    };
    rerender({ ...props, pending: [REQUEST] });
    expect(show).toHaveBeenCalledOnce();
    rerender({ ...props, pending: [{ ...REQUEST, responding: true }, approval] });
    expect(show).toHaveBeenCalledOnce();
    rerender({ ...props, pending: [approval] });
    rerender({ ...props, pending: [approval, { ...REQUEST, responding: true }] });
    expect(show).toHaveBeenCalledOnce();
  });

  it("切换连接后不消费旧连接消息，重新建立的连接独立去重，卸载时取消订阅", () => {
    const { props, source, show, rerender, unmount } = setup();
    act(() => source.emit(completed()));
    expect(show).toHaveBeenCalledOnce();

    const next = notificationSource();
    rerender({ ...props, client: next.client });
    act(() => {
      source.emit(completed({ ...QUESTION, id: "stale" }));
      next.emit(completed());
    });
    expect(show).toHaveBeenCalledTimes(2);
    unmount();
    act(() => next.emit(completed({ ...QUESTION, id: "after-unmount" })));
    expect(show).toHaveBeenCalledTimes(2);
  });
});
