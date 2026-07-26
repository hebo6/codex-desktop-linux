import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import {
  createPendingThreadResultStore,
  parsePendingThreadResults,
} from "./pendingThreadResults";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

describe("pendingThreadResults", () => {
  it("串行读写并使用精确完成回合确认结果", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce([{ threadId: "thread-1", turnId: "turn-1" }])
      .mockResolvedValue(undefined);
    const store = createPendingThreadResultStore({ invoke });

    await expect(store.list(SERVER_ID)).resolves.toEqual([
      { threadId: "thread-1", turnId: "turn-1" },
    ]);
    await store.record(SERVER_ID, "thread-1", "turn-2");
    await store.acknowledge(SERVER_ID, "thread-1", "turn-2");
    await store.clear(SERVER_ID, "thread-1");

    expect(invoke.mock.calls).toEqual([
      ["list_pending_thread_results", { request: { serverId: SERVER_ID } }],
      ["record_pending_thread_result", {
        request: {
          serverId: SERVER_ID,
          threadId: "thread-1",
          turnId: "turn-2",
        },
      }],
      ["acknowledge_pending_thread_result", {
        request: {
          serverId: SERVER_ID,
          threadId: "thread-1",
          turnId: "turn-2",
        },
      }],
      ["clear_pending_thread_result", {
        request: { serverId: SERVER_ID, threadId: "thread-1" },
      }],
    ]);
  });

  it("拒绝宽松或不完整的持久化结果", () => {
    expect(() => parsePendingThreadResults(undefined)).toThrow(TypeError);
    expect(() =>
      parsePendingThreadResults([{ threadId: "thread-1", turnId: "" }])
    ).toThrow(TypeError);
    expect(() =>
      parsePendingThreadResults([{
        threadId: "thread-1",
        turnId: "turn-1",
        unread: true,
      }])
    ).toThrow(TypeError);
  });
});
