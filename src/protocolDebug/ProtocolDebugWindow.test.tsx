import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolTraceBatch } from "../transport/protocolTrace";
import { ProtocolDebugWindow } from "./ProtocolDebugWindow";

const traceMocks = vi.hoisted(() => ({
  clear: vi.fn(async () => undefined),
  subscribe: vi.fn(),
}));

vi.mock("../transport/protocolTrace", () => ({
  clearProtocolTrace: traceMocks.clear,
  subscribeProtocolTrace: traceMocks.subscribe,
}));

describe("ProtocolDebugWindow", () => {
  let deliver: (batch: ProtocolTraceBatch) => void;

  beforeEach(() => {
    traceMocks.clear.mockClear();
    traceMocks.subscribe.mockReset();
    traceMocks.subscribe.mockImplementation(async (
      onBatch: (batch: ProtocolTraceBatch) => void,
    ) => {
      deliver = onBatch;
      return vi.fn();
    });
  });

  it("通过弹性拖拽区分隔标题和右侧窗口按钮", () => {
    render(<ProtocolDebugWindow />);

    const titlebar = screen.getByText("协议检查器").closest("header");
    const dragRegion = titlebar?.querySelector(":scope > span");

    expect(titlebar).not.toBeNull();
    expect(dragRegion).not.toBeNull();
    expect(getComputedStyle(titlebar!).display).toBe("flex");
    expect(getComputedStyle(dragRegion!).flexGrow).toBe("1");
  });

  it("展示追踪消息、配对方法和脱敏后的 JSON", async () => {
    render(<ProtocolDebugWindow />);
    await waitFor(() => expect(traceMocks.subscribe).toHaveBeenCalledTimes(1));

    act(() => deliver(batch()));

    expect(screen.getAllByText("thread/list")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /turn\/start/u }));
    expect(screen.getAllByText("客户端 → 服务端")).not.toHaveLength(0);
    expect(screen.getByText(/\[已脱敏\]/u)).toBeVisible();
    expect(screen.getByText(/2 条 ·/u)).toBeVisible();
  });

  it("过滤方向并通过后端清空内存追踪", async () => {
    render(<ProtocolDebugWindow />);
    await waitFor(() => expect(traceMocks.subscribe).toHaveBeenCalledTimes(1));
    act(() => deliver(batch()));

    fireEvent.change(screen.getByRole("combobox", { name: "方向" }), {
      target: { value: "inbound" },
    });
    expect(screen.queryByText("turn/start")).not.toBeInTheDocument();
    expect(screen.getAllByText("thread/list")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() => expect(traceMocks.clear).toHaveBeenCalledTimes(1));
    expect(screen.getByText("等待 app-server 协议消息")).toBeVisible();
  });
});

function batch(): ProtocolTraceBatch {
  return {
    reset: false,
    entries: [
      {
        sequence: 1,
        timestampMs: 1_700_000_000_000,
        direction: "outbound",
        scope: "configured",
        serverId: "11111111-1111-4111-8111-111111111111",
        connectionId: "pool-11111111-1111-4111-8111-111111111111",
        transport: "localStdio",
        connectionPath: "localStdio",
        windowLabel: "main",
        kind: "request",
        method: "turn/start",
        requestId: "request-1",
        payload: "{\"id\":\"request-1\",\"method\":\"turn/start\",\"token\":\"[已脱敏]\"}",
        originalBytes: 75,
        truncated: false,
      },
      {
        sequence: 2,
        timestampMs: 1_700_000_000_010,
        direction: "inbound",
        scope: "configured",
        serverId: "11111111-1111-4111-8111-111111111111",
        connectionId: "pool-11111111-1111-4111-8111-111111111111",
        transport: "localStdio",
        connectionPath: "localStdio",
        windowLabel: "main",
        kind: "response",
        method: "thread/list",
        requestId: "request-2",
        durationMs: 8.4,
        payload: "{\"id\":\"request-2\",\"result\":{}}",
        originalBytes: 33,
        truncated: false,
      },
    ],
    oldestSequence: 1,
    retainedCount: 2,
    retainedBytes: 108,
    evictedCount: 0,
  };
}
