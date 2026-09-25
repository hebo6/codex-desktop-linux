import { describe, expect, it, vi } from "vitest";

import type { ServerNotification, ServerRequest } from "../protocol/generated";
import { KNOWN_SERVER_REQUEST_METHODS } from "../protocol/generated";
import { RpcServerRequestError } from "../protocol/rpc";
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

  it("覆盖全部服务端请求并自动回应当前时间", () => {
    const session = new FakeSession();
    new AppServerInteractionClient(session);
    expect([...session.handlers.keys()]).toEqual(KNOWN_SERVER_REQUEST_METHODS);
    expect(session.handlers.get("currentTime/read")?.({
      id: "clock", method: "currentTime/read", params: { threadId: "thread-1" },
    })).toEqual({ currentTimeAt: expect.any(Number) });
  });

  it.each([
    { request: { id: 1, method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "private_tool", arguments: { secret: "DO_NOT_KEEP" } } } as ServerRequest, reason: "dynamic_tool_unregistered", threadId: "thread-1" },
    { request: { id: 2, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: "DO_NOT_KEEP" } } as ServerRequest, reason: "external_auth_unavailable", threadId: null },
    { request: { id: 3, method: "attestation/generate", params: {} } as ServerRequest, reason: "attestation_unavailable", threadId: null },
  ])("未实现能力显式响应并公开安全失败原因：$reason", ({ request, reason, threadId }) => {
    const session = new FakeSession();
    const client = new AppServerInteractionClient(session);
    const listener = vi.fn();
    client.subscribe(listener);

    expect(() => session.handlers.get(request.method)?.(request)).toThrow(RpcServerRequestError);
    expect(() => session.handlers.get(request.method)?.(request)).toThrow(expect.objectContaining({ code: -32601 }));
    expect(client.getSnapshot().pending).toHaveLength(0);
    expect(client.getSnapshot().failures[0]).toMatchObject({ method: request.method, reason, threadId, message: expect.any(String) });
    expect(JSON.stringify(client.getSnapshot().failures)).not.toContain("DO_NOT_KEEP");
    expect(JSON.stringify(client.getSnapshot().failures)).not.toContain("private_tool");
    expect(listener).toHaveBeenCalled();
  });

  it("失败诊断有界且销毁时释放全部处理器", () => {
    const session = new FakeSession();
    const client = new AppServerInteractionClient(session);
    for (let index = 0; index < 105; index += 1) {
      expect(() => session.handlers.get("attestation/generate")?.({
        id: index, method: "attestation/generate", params: {},
      })).toThrow(RpcServerRequestError);
    }
    expect(client.getSnapshot().failures).toHaveLength(100);
    expect(client.getSnapshot().failures[0]?.key).toBe("number:5");
    client.dispose();
    expect(client.getSnapshot().failures).toHaveLength(0);
    expect(session.handlers.size).toBe(0);
  });

  it("销毁时使用当前 legacy 审批拒绝结构", async () => {
    const session = new FakeSession();
    const client = new AppServerInteractionClient(session);
    const request = {
      id: 9,
      method: "execCommandApproval",
      params: {
        callId: "call-1",
        command: ["pnpm", "test"],
        conversationId: "thread-1",
        cwd: "/workspace/project",
        parsedCmd: [],
      },
    } as ServerRequest;
    const result = session.handlers.get(request.method)?.(request) as Promise<unknown>;

    client.dispose();

    await expect(result).resolves.toEqual({
      decision: { denied: { rejection: "用户拒绝了请求" } },
    });
  });
});
