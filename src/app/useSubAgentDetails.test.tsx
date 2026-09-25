import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadTurnsListResponse } from "../protocol/generated";
import type { RequestHandle } from "../protocol/rpc";
import type { SubAgentStatus } from "./subAgentState";
import { useSubAgentDetails, type SubAgentDetailsClient } from "./useSubAgentDetails";

const COMPLETED: ThreadTurnsListResponse = {
  data: [{
    id: "turn-1", status: "completed", itemsView: "summary", durationMs: 12_000,
    items: [{ id: "answer", type: "agentMessage", text: "已检查协议", phase: "final_answer" }],
  }],
  nextCursor: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

class FakeClient implements SubAgentDetailsClient {
  readonly latest = vi.fn(async (_id: string, _view?: "notLoaded" | "summary") => COMPLETED);
  listLatestThreadTurn(id: string, view?: "notLoaded" | "summary"): RequestHandle<ThreadTurnsListResponse> {
    return { epoch: 1, id: 1, stage: "pending", result: this.latest(id, view) };
  }
}

afterEach(() => vi.useRealTimers());

describe("useSubAgentDetails", () => {
  it("读取最近回合摘要，并保留输出、耗时和失败原因", async () => {
    const client = new FakeClient();
    const failed: ThreadTurnsListResponse = {
      ...COMPLETED,
      data: [{ ...COMPLETED.data[0]!, status: "failed", error: {
        message: "额度不足", additionalDetails: "稍后重试", codexErrorInfo: "usageLimitExceeded",
      } }],
    };
    client.latest.mockResolvedValue(failed);
    const { result } = renderHook(() => useSubAgentDetails(client, "agent", "errored", true));
    expect(result.current.loading).toBe(true);
    await act(async () => {});
    expect(client.latest).toHaveBeenCalledExactlyOnceWith("agent", "summary");
    expect(result.current.turn).toEqual(failed.data[0]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it.each(["running", "waitingOnApproval", "waitingOnUserInput"] as const)(
    "%s 时顺序刷新，慢请求不重叠，卸载后停止请求",
    async (status) => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const pending = deferred<ThreadTurnsListResponse>();
      client.latest.mockReturnValueOnce(pending.promise);
      const { result, unmount } = renderHook(() => useSubAgentDetails(client, "agent", status, true));
      act(() => result.current.refresh());
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(client.latest).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(COMPLETED));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(client.latest).toHaveBeenCalledTimes(2);
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(client.latest).toHaveBeenCalledTimes(2);
    },
  );

  it("结束时立即重新读取，迟到的运行中响应不能覆盖最终结果", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const pending = deferred<ThreadTurnsListResponse>();
    client.latest.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ status }: { status: SubAgentStatus }) => useSubAgentDetails(client, "agent", status, true),
      { initialProps: { status: "running" } },
    );
    rerender({ status: "errored" });
    await act(async () => {});
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
    await act(async () => pending.resolve({ data: [], nextCursor: null }));
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(client.latest).toHaveBeenCalledTimes(2);
  });

  it("切换 agent、连接或断开时，不混入旧请求结果", async () => {
    const client = new FakeClient();
    const pending = deferred<ThreadTurnsListResponse>();
    client.latest.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ source, id }: { source: SubAgentDetailsClient | null; id: string }) =>
        useSubAgentDetails(source, id, "idle", true),
      { initialProps: { source: client as SubAgentDetailsClient | null, id: "old" } },
    );
    client.latest.mockResolvedValue({ data: [], nextCursor: null });
    rerender({ source: client, id: "new" });
    await act(async () => pending.resolve(COMPLETED));
    expect(result.current.turn).toBeNull();
    const nextClient = new FakeClient();
    rerender({ source: nextClient, id: "new" });
    await act(async () => {});
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
    rerender({ source: null, id: "new" });
    expect(result.current.turn).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("读取失败保留已知内容，重试成功后清除读取错误", async () => {
    const client = new FakeClient();
    const { result } = renderHook(() => useSubAgentDetails(client, "agent", "idle", true));
    await act(async () => {});
    client.latest.mockRejectedValueOnce(new Error("offline"));
    await act(async () => result.current.refresh());
    expect(result.current.error).toBe("无法读取子 agent 详情");
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
    await act(async () => result.current.refresh());
    expect(result.current.error).toBeNull();
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
  });

  it("面板收起时保留已加载内容并停止刷新，重新展开读取新摘要", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const { result, rerender } = renderHook(
      ({ enabled }) => useSubAgentDetails(client, "agent", "running", enabled),
      { initialProps: { enabled: false } },
    );
    expect(client.latest).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => {});
    const pending = deferred<ThreadTurnsListResponse>();
    client.latest.mockReturnValueOnce(pending.promise);
    act(() => result.current.refresh());
    rerender({ enabled: false });
    await act(async () => pending.resolve({ data: [], nextCursor: null }));
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
    expect(result.current.loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(client.latest).toHaveBeenCalledTimes(2);
    client.latest.mockRejectedValueOnce(new Error("offline"));
    rerender({ enabled: true });
    await act(async () => {});
    expect(client.latest).toHaveBeenCalledTimes(3);
    expect(result.current.turn).toEqual(COMPLETED.data[0]);
    expect(result.current.error).toBe("无法读取子 agent 详情");
  });
});
