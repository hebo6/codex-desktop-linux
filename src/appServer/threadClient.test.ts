import { describe, expect, it } from "vitest";

import type {
  RequestHandle,
  ServerNotificationHandler,
  SendRequestOptions,
} from "../protocol/rpc";
import type { ServerNotification } from "../protocol/generated";
import {
  AppServerThreadClient,
  RECENT_THREAD_PAGE_SIZE,
} from "./threadClient";

class RecordingSession {
  readonly requests: SendRequestOptions<unknown>[] = [];
  readonly notificationHandlers = new Set<ServerNotificationHandler>();

  sendRequest<T>(options: SendRequestOptions<T>): RequestHandle<T> {
    this.requests.push(options as SendRequestOptions<unknown>);
    return {
      epoch: 1,
      id: `request-${this.requests.length}`,
      stage: "pending",
      result: new Promise<T>(() => undefined),
    };
  }

  subscribeNotifications(handler: ServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  emit(notification: ServerNotification): void {
    for (const handler of this.notificationHandlers) {
      void handler(notification);
    }
  }
}

describe("AppServerThreadClient", () => {
  it("转发服务端会话事实通知并支持退订", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);
    const received: ServerNotification[] = [];

    const release = client.subscribeNotifications((notification) => {
      received.push(notification);
    });
    session.emit({
      method: "thread/deleted",
      params: { threadId: "thread-1" },
    });
    release();
    session.emit({
      method: "thread/archived",
      params: { threadId: "thread-2" },
    });

    expect(received).toEqual([
      { method: "thread/deleted", params: { threadId: "thread-1" } },
    ]);
  });

  it("按最近更新时间分页列出活动和归档会话", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);

    client.listRecentThreads();
    client.listRecentThreads({ archived: true, cursor: "next-page" });
    client.listRecentThreads({ cwd: "/workspace/project", limit: 6 });

    expect(
      session.requests.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "thread/list",
        params: {
          archived: false,
          limit: RECENT_THREAD_PAGE_SIZE,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
      },
      {
        method: "thread/list",
        params: {
          archived: true,
          cursor: "next-page",
          limit: RECENT_THREAD_PAGE_SIZE,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
      },
      {
        method: "thread/list",
        params: {
          archived: false,
          cwd: "/workspace/project",
          limit: 6,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
      },
    ]);
  });

  it("读取会话时默认不加载 turn", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);

    client.readThread("thread-1");
    client.readThread("thread-2", true);

    expect(
      session.requests.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: "thread/read",
        params: { includeTurns: false, threadId: "thread-1" },
      },
      {
        method: "thread/read",
        params: { includeTurns: true, threadId: "thread-2" },
      },
    ]);
  });

  it("恢复时请求完整 turn 历史", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);

    client.resumeThread("thread-1");

    expect(session.requests.map(({ method, params }) => ({ method, params }))).toEqual([{
      method: "thread/resume",
      params: { threadId: "thread-1" },
    }]);
  });

  it("取消当前会话的服务端订阅", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);

    client.unsubscribeThread("thread-1");

    expect(session.requests[0]).toMatchObject({
      method: "thread/unsubscribe",
      params: { threadId: "thread-1" },
    });
  });

  it("使用 v2 方法归档、撤销和删除会话", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);

    client.archiveThread("thread-1");
    client.unarchiveThread("thread-2");
    client.deleteThread("thread-3");

    expect(
      session.requests.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      { method: "thread/archive", params: { threadId: "thread-1" } },
      { method: "thread/unarchive", params: { threadId: "thread-2" } },
      { method: "thread/delete", params: { threadId: "thread-3" } },
    ]);
  });

  it("每个方法使用对应 Schema 响应校验器", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);
    client.listRecentThreads();
    client.readThread("thread-1");
    client.resumeThread("thread-1");
    client.unsubscribeThread("thread-1");
    client.archiveThread("thread-1");
    client.unarchiveThread("thread-1");
    client.deleteThread("thread-1");
    client.forkThread("thread-1", "turn-3");

    for (const request of session.requests) {
      const result = request.validateResult(null);
      expect(result.ok).toBe(false);
    }
  });

  it("按指定回合边界创建轻量分支", () => {
    const session = new RecordingSession();
    const client = new AppServerThreadClient(session);

    client.forkThread("thread-1", "turn-3");

    expect(session.requests[0]).toMatchObject({
      method: "thread/fork",
      params: {
        excludeTurns: true,
        lastTurnId: "turn-3",
        threadId: "thread-1",
      },
    });
  });
});
