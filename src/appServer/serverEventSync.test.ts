import { describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { ServerNotification } from "../protocol/generated";
import type { SendRequestOptions } from "../protocol/rpc";
import type { AppServerSession } from "./session";
import { ServerEventStore } from "./serverEventState";
import { ServerEventSync } from "./serverEventSync";

function harness() {
  const store = new ServerEventStore();
  const listeners = new Set<(notification: ServerNotification) => void>();
  const pending: { options: SendRequestOptions<unknown>; resolve: (value: unknown) => void; reject: () => void }[] = [];
  const sendRequest = vi.fn((options: SendRequestOptions<unknown>) => ({
    id: pending.length, epoch: 1, stage: "pending" as const,
    result: new Promise((resolve, reject) => pending.push({ options, resolve, reject })),
  }));
  const sync = new ServerEventSync({
    sendRequest: sendRequest as AppServerSession["sendRequest"],
    subscribeNotifications: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  }, store);
  return {
    store, sync, pending, sendRequest,
    emit: (notification: ServerNotification) => {
      store.consume(notification);
      for (const listener of listeners) listener(notification);
    },
  };
}

const queued = (id: string) => ({ id, clientUserMessageId: id, input: [{ type: "text", text: id }] });

describe("ServerEventSync", () => {
  it("分页读取完整队列，迟到的旧版本不能覆盖变更通知", async () => {
    const h = harness();
    const result = h.sync.refreshQueue("thread");
    h.emit({ method: "thread/queue/changed", params: { threadId: "thread" } });
    expect(h.pending).toHaveLength(1);
    h.pending[0]!.resolve({ data: [queued("old")], nextCursor: null });
    await waitFor(() => expect(h.pending).toHaveLength(2));
    h.pending[1]!.resolve({ data: [queued("a")], nextCursor: "page-2" });
    await waitFor(() => expect(h.pending).toHaveLength(3));
    expect(h.pending[2]!.options.params).toMatchObject({ cursor: "page-2" });
    h.pending[2]!.resolve({ data: [queued("b")], nextCursor: null });
    await result;
    expect(h.store.getSnapshot().queuesByThread.thread?.entries.map(({ id }) => id)).toEqual(["a", "b"]);
    h.sync.dispose();
  });

  it("目标清除推送优先于更早发起的目标快照", async () => {
    const h = harness();
    const result = h.sync.refreshGoal("thread");
    h.emit({ method: "thread/goal/cleared", params: { threadId: "thread" } });
    h.pending[0]!.resolve({ goal: { threadId: "thread", objective: "旧目标", status: "active", tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 } });
    await result;
    expect(h.store.getSnapshot().goalsByThread.thread?.goal).toBeNull();
    h.sync.dispose();
  });

  it("撤回期间的旧目标查询结束后重新读取新目标", async () => {
    const h = harness();
    const result = h.sync.refreshGoal("thread");
    h.emit({ method: "thread/reverted", params: { threadId: "thread" } });
    const restored = h.sync.refreshGoal("thread");
    expect(restored).toBe(result);
    h.pending[0]!.resolve({ goal: null });
    await waitFor(() => expect(h.pending).toHaveLength(2));
    h.pending[1]!.resolve({ goal: { threadId: "thread", objective: "新目标", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
    await result;
    expect(h.store.getSnapshot().goalsByThread.thread?.goal?.objective).toBe("新目标");
    h.sync.dispose();
  });

  it("删除和断线使在途快照失效，不会继续分页或复活会话", async () => {
    const h = harness();
    const result = h.sync.refreshQueue("thread");
    h.emit({ method: "thread/deleted", params: { threadId: "thread" } });
    h.pending[0]!.resolve({ data: [queued("old")], nextCursor: "more" });
    await result;
    expect(h.pending).toHaveLength(1);
    expect(h.store.getSnapshot().queuesByThread.thread).toBeUndefined();
    const projects = h.sync.refreshProjects();
    h.store.disconnect();
    h.pending[1]!.resolve({ data: [{ id: "p", name: "P", roots: [], metadata: {}, position: 1, createdAt: 1, updatedAt: 1 }], nextCursor: "more" });
    await projects;
    expect(h.pending).toHaveLength(2);
    expect(h.store.getSnapshot().projectsSnapshot.entries).toEqual([]);
    h.sync.dispose();
  });

  it("重复游标停止读取并显示同步错误", async () => {
    const h = harness();
    const result = h.sync.refreshQueue("thread");
    h.pending[0]!.resolve({ data: [], nextCursor: "same" });
    await waitFor(() => expect(h.pending).toHaveLength(2));
    h.pending[1]!.resolve({ data: [], nextCursor: "same" });
    await result;
    expect(h.store.getSnapshot().queuesByThread.thread).toMatchObject({ status: "error", error: "无法同步待发送队列" });
    h.sync.dispose();
  });
});
