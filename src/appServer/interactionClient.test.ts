import { describe, expect, it, vi } from "vitest";

import type { ServerNotification, ServerRequest } from "../protocol/generated";
import { AppServerInteractionClient } from "./interactionClient";

class FakeSession {
  readonly handlers = new Map<string, (request: ServerRequest) => unknown | Promise<unknown>>();
  notificationHandler: ((notification: ServerNotification) => void) | null = null;
  registerServerRequestHandler(method: string, handler: (request: ServerRequest) => unknown | Promise<unknown>) {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }
  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.notificationHandler = handler;
    return () => { this.notificationHandler = null; };
  }
}

describe("AppServerInteractionClient", () => {
  it("按到达顺序排队审批并等待 resolved 通知移除", async () => {
    const session = new FakeSession();
    const client = new AppServerInteractionClient(session);
    const listener = vi.fn();
    client.subscribe(listener);
    const request = {
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
    } as ServerRequest;
    const result = session.handlers.get(request.method)?.(request) as Promise<unknown>;

    expect(client.getSnapshot().pending).toHaveLength(1);
    const key = client.getSnapshot().pending[0]!.key;
    expect(client.respond(key, { decision: "accept" })).toBe(true);
    await expect(result).resolves.toEqual({ decision: "accept" });
    expect(client.getSnapshot().pending[0]?.responding).toBe(true);

    session.notificationHandler?.({
      method: "serverRequest/resolved",
      params: { requestId: 7, threadId: "thread-1" },
    } as ServerNotification);
    expect(client.getSnapshot().pending).toHaveLength(0);
    expect(listener).toHaveBeenCalled();
  });

  it("其他窗口先处理时以拒绝结果结束本地等待", async () => {
    const session = new FakeSession();
    const client = new AppServerInteractionClient(session);
    const request = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
    } as ServerRequest;
    const result = session.handlers.get(request.method)?.(request) as Promise<unknown>;
    session.notificationHandler?.({
      method: "serverRequest/resolved",
      params: { requestId: "approval-1", threadId: "thread-1" },
    } as ServerNotification);
    await expect(result).resolves.toEqual({ decision: "decline" });
    expect(client.getSnapshot().resolvedElsewhereCount).toBe(1);
  });

  it("自动回应时间和未知动态工具", async () => {
    const session = new FakeSession();
    new AppServerInteractionClient(session);
    await expect(Promise.resolve(session.handlers.get("currentTime/read")?.({} as ServerRequest))).resolves.toMatchObject({ currentTimeAt: expect.any(Number) });
    await expect(Promise.resolve(session.handlers.get("item/tool/call")?.({} as ServerRequest))).resolves.toEqual({ contentItems: [], success: false });
  });
});
