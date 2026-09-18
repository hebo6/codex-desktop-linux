import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RequestHandle } from "../protocol/rpc";
import type {
  ServerNotification,
  ThreadListResponse,
  ThreadTurnsListResponse,
} from "../protocol/generated";
import { useSubAgents, type SubAgentClient } from "./useSubAgents";

const ROOT = { id: "root", sessionId: "session" };
type Thread = ThreadListResponse["data"][number];

function child(id = "child", status: Thread["status"] = { type: "active", activeFlags: [] }): Thread {
  return {
    id, sessionId: ROOT.sessionId, parentThreadId: ROOT.id,
    agentNickname: "Explorer", agentRole: "研究", cliVersion: "0.149.0",
    createdAt: 1, updatedAt: 1, cwd: "/workspace", ephemeral: false,
    modelProvider: "openai", preview: "检查实现", projectId: null, status, turns: [],
    source: { subAgent: { thread_spawn: {
      parent_thread_id: ROOT.id, depth: 1, agent_path: `/root/${id}`,
    } } },
  };
}

function turns(status: "completed" | "interrupted" | "failed"): ThreadTurnsListResponse {
  return { data: [{ id: "turn", items: [], itemsView: "notLoaded", status }], nextCursor: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function request<T>(result: Promise<T>): RequestHandle<T> {
  return { epoch: 1, id: 1, stage: "pending", result };
}

class FakeClient implements SubAgentClient {
  readonly handlers = new Set<(notification: ServerNotification) => void>();
  readonly list = vi.fn(async (_root: string, _cursor: string | null): Promise<ThreadListResponse> => ({
    data: [child()], nextCursor: null,
  }));
  readonly latest = vi.fn(async (_id: string): Promise<ThreadTurnsListResponse> => turns("completed"));
  listSubAgentThreads(id: string, cursor: string | null = null) {
    return request(this.list(id, cursor));
  }
  listLatestThreadTurn(id: string) { return request(this.latest(id)); }
  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(notification: ServerNotification) {
    for (const handler of this.handlers) { handler(notification); }
  }
  status(id: string, status: Thread["status"]) {
    this.emit({ method: "thread/status/changed", params: { threadId: id, status } });
  }
}

describe("useSubAgents", () => {
  it("分页恢复全部后代，主回合结束后继续更新子 agent 状态", async () => {
    const client = new FakeClient();
    client.list.mockImplementation(async (_id, cursor) => cursor === null
      ? { data: [child()], nextCursor: "page-2" }
      : { data: [{ ...child("nested", { type: "idle" }), parentThreadId: "child" }], nextCursor: null });
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents.map(({ status }) => status))
      .toEqual(["running", "completed"]));
    expect(client.list.mock.calls).toEqual([[ROOT.id, null], [ROOT.id, "page-2"]]);
    expect(result.current.agents[0]).toEqual({
      threadId: "child", name: "/root/child", role: "研究", status: "running",
    });
    act(() => {
      client.emit({ method: "turn/completed", params: {
        threadId: ROOT.id, turn: turns("completed").data[0]!,
      } });
      client.status("child", { type: "active", activeFlags: ["waitingOnApproval"] });
    });
    expect(result.current.agents[0]?.status).toBe("waitingOnApproval");
    act(() => client.status("child", { type: "idle" }));
    await waitFor(() => expect(result.current.agents[0]?.status).toBe("completed"));
    act(() => client.status("child", { type: "active", activeFlags: ["waitingOnUserInput"] }));
    expect(result.current.agents[0]?.status).toBe("waitingOnUserInput");
  });

  it("重放快照期间的状态通知，不让旧快照覆盖实时状态", async () => {
    const client = new FakeClient();
    const snapshot = deferred<ThreadListResponse>();
    client.list.mockReturnValueOnce(snapshot.promise).mockResolvedValue({
      data: [child("child", { type: "active", activeFlags: ["waitingOnApproval"] })], nextCursor: null,
    });
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    act(() => client.status("child", { type: "active", activeFlags: ["waitingOnApproval"] }));
    await act(async () => snapshot.resolve({ data: [child()], nextCursor: null }));
    expect(result.current.agents[0]?.status).toBe("waitingOnApproval");
  });

  it("已恢复的会话能发现新 agent 和嵌套后代，不接收其他会话", async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    client.list.mockResolvedValue({
      data: [child(), { ...child("nested"), parentThreadId: "child" }], nextCursor: null,
    });
    act(() => {
      client.emit({ method: "thread/started", params: {
        thread: { ...child("other"), sessionId: "other-session", parentThreadId: "other-root" },
      } });
      client.emit({ method: "thread/started", params: {
        thread: { ...child("nested"), parentThreadId: "child" },
      } });
    });
    await waitFor(() => expect(result.current.agents.map(({ threadId }) => threadId))
      .toEqual(["child", "nested"]));
    expect(client.list).toHaveBeenCalledTimes(2);
  });

  it("迟到的已完成结果不能覆盖新一轮运行，空闲也不等于完成", async () => {
    const client = new FakeClient();
    const latest = deferred<ThreadTurnsListResponse>();
    client.latest.mockReturnValue(latest.promise);
    client.list.mockResolvedValue({ data: [child("child", { type: "idle" })], nextCursor: null });
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents[0]?.status).toBe("idle"));
    act(() => client.status("child", { type: "active", activeFlags: [] }));
    await act(async () => latest.resolve(turns("completed")));
    expect(result.current.agents[0]?.status).toBe("running");
    client.latest.mockResolvedValue({ data: [], nextCursor: null });
    act(() => client.status("child", { type: "idle" }));
    await waitFor(() => expect(client.latest).toHaveBeenCalledTimes(2));
    expect(result.current.agents[0]?.status).toBe("idle");
  });

  it("没有 thread/started 时也能从协作活动发现新 agent", async () => {
    const client = new FakeClient();
    client.list.mockResolvedValueOnce({ data: [], nextCursor: null });
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await act(async () => {});
    expect(result.current.agents).toEqual([]);
    act(() => client.emit({ method: "item/completed", params: {
      threadId: ROOT.id, turnId: "parent-turn", completedAtMs: 1,
      item: { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "child", agentPath: "/root/child" },
    } }));
    await waitFor(() => expect(result.current.agents[0]?.status).toBe("running"));
  });

  it("仅收到未知后代的全局状态时查询关系，并保留父线程卸载后的子 agent", async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    client.list.mockResolvedValue({
      data: [child(), { ...child("nested"), parentThreadId: "child" }], nextCursor: null,
    });
    act(() => client.status("nested", { type: "active", activeFlags: [] }));
    await waitFor(() => expect(result.current.agents).toHaveLength(2));
    act(() => {
      client.emit({ method: "thread/closed", params: { threadId: ROOT.id } });
      client.status("nested", { type: "active", activeFlags: ["waitingOnUserInput"] });
    });
    expect(result.current.agents.map(({ status }) => status)).toEqual(["running", "waitingOnUserInput"]);
  });

  it("父会话删除后不允许在途快照恢复面板", async () => {
    const client = new FakeClient();
    const snapshot = deferred<ThreadListResponse>();
    client.list.mockReturnValue(snapshot.promise);
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    act(() => client.emit({ method: "thread/deleted", params: { threadId: ROOT.id } }));
    await act(async () => snapshot.resolve({ data: [child()], nextCursor: null }));
    expect(result.current.agents).toEqual([]);
    act(() => result.current.refresh());
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it("最新快照移除已经不在列表中的子 agent", async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    client.list.mockResolvedValue({ data: [], nextCursor: null });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.agents).toEqual([]));
  });

  it.each(["interrupted", "failed"] as const)("恢复最近回合的 %s 结果", async (status) => {
    const client = new FakeClient();
    client.list.mockResolvedValue({ data: [child("child", { type: "idle" })], nextCursor: null });
    client.latest.mockResolvedValue(turns(status));
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents[0]?.status)
      .toBe(status === "failed" ? "errored" : "interrupted"));
  });

  it("切换会话和连接时忽略旧请求，并释放通知订阅", async () => {
    const client = new FakeClient();
    const snapshot = deferred<ThreadListResponse>();
    client.list.mockReturnValueOnce(snapshot.promise);
    const { result, rerender, unmount } = renderHook(
      ({ source, root }) => useSubAgents(source, root),
      { initialProps: { source: client, root: ROOT } },
    );
    rerender({ source: client, root: { ...ROOT, id: "another-root" } });
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    const nextClient = new FakeClient();
    nextClient.list.mockResolvedValue({ data: [], nextCursor: null });
    rerender({ source: nextClient, root: ROOT });
    await act(async () => snapshot.resolve({ data: [child()], nextCursor: null }));
    expect(result.current.agents).toEqual([]);
    expect(client.handlers.size).toBe(0);
    unmount();
    expect(nextClient.handlers.size).toBe(0);
  });

  it("同步失败保留当前状态，重试成功后清除错误", async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    client.list.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.agents[0]?.status).toBe("running");
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("未加载不当作完成，删除子线程后移除对应条目", async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useSubAgents(client, ROOT));
    await waitFor(() => expect(result.current.agents).toHaveLength(1));
    act(() => client.emit({ method: "thread/closed", params: { threadId: "child" } }));
    expect(result.current.agents[0]?.status).toBe("notLoaded");
    act(() => client.emit({ method: "thread/deleted", params: { threadId: "child" } }));
    expect(result.current.agents).toEqual([]);
  });
});
