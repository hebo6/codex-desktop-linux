import { describe, expect, it, vi } from "vitest";

import type { ServerNotification } from "../protocol/generated";
import type { RequestHandle, SendRequestOptions } from "../protocol/rpc";
import { AppServerConversationClient } from "./conversationClient";

class RecordingSession {
  readonly requests: SendRequestOptions<unknown>[] = [];
  notificationHandler: ((notification: ServerNotification) => void) | null = null;

  sendRequest<T>(options: SendRequestOptions<T>): RequestHandle<T> {
    this.requests.push(options as SendRequestOptions<unknown>);
    return {
      epoch: 1,
      id: `request-${this.requests.length}`,
      stage: "pending",
      result: new Promise<T>(() => undefined),
    };
  }

  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.notificationHandler = handler;
    return vi.fn();
  }
}

describe("AppServerConversationClient", () => {
  it("映射 thread 和 turn 生命周期请求", () => {
    const session = new RecordingSession();
    const client = new AppServerConversationClient(session);
    const input = [{ type: "text" as const, text: "继续" }];

    client.startThread({ cwd: "/workspace" });
    client.startTurn("thread-1", {
      clientUserMessageId: "message-1",
      input,
      serviceTier: "priority",
    });
    client.setServiceTier("thread-1", "priority");
    client.steerTurn("thread-1", "turn-1", {
      clientUserMessageId: "message-2",
      input,
    });
    client.interruptTurn("thread-1", "turn-1");

    expect(session.requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "thread/start", params: { cwd: "/workspace" } },
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          clientUserMessageId: "message-1",
          input,
          serviceTier: "priority",
        },
      },
      {
        method: "thread/settings/update",
        params: { threadId: "thread-1", serviceTier: "priority" },
      },
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          clientUserMessageId: "message-2",
          input,
        },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);
    for (const request of session.requests) {
      expect(request.validateResult(null).ok).toBe(false);
    }
  });

  it("透传已校验的服务端通知订阅", () => {
    const session = new RecordingSession();
    const client = new AppServerConversationClient(session);
    const handler = vi.fn();
    const release = client.subscribeNotifications(handler);
    const notification = {
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", items: [], status: "inProgress" },
      },
    } as ServerNotification;

    session.notificationHandler?.(notification);

    expect(handler).toHaveBeenCalledWith(notification);
    expect(release).toEqual(expect.any(Function));
  });
});
