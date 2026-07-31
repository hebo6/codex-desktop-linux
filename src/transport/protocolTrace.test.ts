import { describe, expect, it, vi } from "vitest";

import {
  openProtocolDebugWindow,
  parseProtocolTraceBatch,
  subscribeProtocolTrace,
} from "./protocolTrace";
import type { TauriIpc } from "./tauriIpc";

const ENTRY = {
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
  method: "thread/list",
  requestId: "rpc:client:1:1",
  payload: "{\"id\":\"rpc:client:1:1\",\"method\":\"thread/list\"}",
  originalBytes: 52,
  truncated: false,
} as const;

describe("协议追踪传输", () => {
  it("解析经过约束的追踪批次", () => {
    expect(parseProtocolTraceBatch({
      reset: false,
      entries: [ENTRY],
      oldestSequence: 1,
      retainedCount: 1,
      retainedBytes: ENTRY.payload.length,
      evictedCount: 0,
    })).toEqual({
      reset: false,
      entries: [ENTRY],
      oldestSequence: 1,
      retainedCount: 1,
      retainedBytes: ENTRY.payload.length,
      evictedCount: 0,
    });
  });

  it("拒绝乱序或带未知字段的批次", () => {
    expect(parseProtocolTraceBatch({
      reset: false,
      entries: [
        { ...ENTRY, sequence: 2 },
        { ...ENTRY, sequence: 1 },
      ],
      oldestSequence: 1,
      retainedCount: 2,
      retainedBytes: 10,
      evictedCount: 0,
    })).toBeNull();
    expect(parseProtocolTraceBatch({
      reset: false,
      entries: [{ ...ENTRY, authorization: "secret" }],
      oldestSequence: 1,
      retainedCount: 1,
      retainedBytes: 10,
      evictedCount: 0,
    })).toBeNull();
  });

  it("请求后端打开协议检查器窗口", async () => {
    const ipc = ipcStub();
    ipc.invoke.mockResolvedValueOnce(undefined);

    await openProtocolDebugWindow(ipc);

    expect(ipc.invoke).toHaveBeenCalledWith(
      "open_protocol_debug_window",
      {},
    );
  });

  it("退订时使用后端返回的订阅标识", async () => {
    const ipc = ipcStub();
    ipc.invoke.mockResolvedValueOnce(7).mockResolvedValueOnce(undefined);
    const unsubscribe = await subscribeProtocolTrace(vi.fn(), ipc);

    unsubscribe();

    expect(ipc.invoke).toHaveBeenLastCalledWith(
      "unsubscribe_protocol_trace",
      { request: { subscriptionId: 7 } },
    );
  });
});

function ipcStub() {
  return {
    createEventChannel: vi.fn(() => ({ channel: "channel" })),
    invoke: vi.fn(),
  } satisfies TauriIpc as TauriIpc & {
    readonly invoke: ReturnType<typeof vi.fn>;
  };
}
