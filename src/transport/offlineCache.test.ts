import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import {
  createServerThreadCache,
  parseThreadCacheSnapshot,
  type SaveThreadCacheInput,
} from "./offlineCache";
import type { TauriIpc } from "./tauriIpc";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

function thread() {
  return {
    cliVersion: "1.0.0",
    createdAt: 1,
    cwd: "/workspace",
    ephemeral: false,
    id: "thread-1",
    modelProvider: "openai",
    name: "缓存会话",
    preview: "缓存内容",
    sessionId: "session-1",
    source: "appServer" as const,
    status: { type: "idle" as const },
    turns: [],
    updatedAt: 2,
  };
}

function turn() {
  return {
    completedAt: 20,
    durationMs: 10_000,
    id: "turn-1",
    items: [],
    itemsView: "full" as const,
    startedAt: 10,
    status: "completed" as const,
  };
}

describe("offlineCache transport", () => {
  it("校验并解析缓存投影", () => {
    const parsed = parseThreadCacheSnapshot({
      threads: [thread()],
      nextThreadCursor: null,
      restoredThread: { metadata: thread(), turns: [], nextCursor: null },
      syncedAtMs: 100,
    });
    expect(parsed?.threads[0]?.id).toBe("thread-1");
    expect(parsed?.restoredThread?.metadata.name).toBe("缓存会话");
  });

  it("拒绝损坏的缓存协议内容", () => {
    expect(() => parseThreadCacheSnapshot({ threads: [{}], restoredThread: null, syncedAtMs: 1 })).toThrow("invalid cached thread list");
  });

  it("读写离线缓存时移除回合时间且不修改输入", async () => {
    const cachedThread = { ...thread(), turns: [turn()] };
    const input = {
      currentThreadId: cachedThread.id,
      nextThreadCursor: null,
      restoredThread: {
        metadata: cachedThread,
        nextCursor: null,
        turns: [turn()],
      },
      serverId: SERVER_ID,
      threads: [cachedThread],
    } satisfies SaveThreadCacheInput;
    const invoke = vi.fn(async (_command: string, _payload: unknown) => null);
    const cache = createServerThreadCache({ invoke } as Pick<TauriIpc, "invoke">);

    await cache.save(input);

    const payload = invoke.mock.calls[0]?.[1] as { request: SaveThreadCacheInput };
    expect(payload.request.threads[0]?.turns[0]).not.toHaveProperty("startedAt");
    expect(payload.request.threads[0]?.turns[0]).not.toHaveProperty("completedAt");
    expect(payload.request.threads[0]?.turns[0]).not.toHaveProperty("durationMs");
    expect(payload.request.restoredThread?.metadata.turns[0]).not.toHaveProperty("completedAt");
    expect(payload.request.restoredThread?.turns[0]).not.toHaveProperty("completedAt");
    expect(input.restoredThread.turns[0]?.completedAt).toBe(20);

    const parsed = parseThreadCacheSnapshot({
      nextThreadCursor: null,
      restoredThread: input.restoredThread,
      syncedAtMs: 100,
      threads: input.threads,
    });
    expect(parsed?.threads[0]?.turns[0]).not.toHaveProperty("completedAt");
    expect(parsed?.restoredThread?.metadata.turns[0]).not.toHaveProperty("completedAt");
    expect(parsed?.restoredThread?.turns[0]).not.toHaveProperty("completedAt");
  });

  it("只通过受限 Tauri 命令读写缓存", async () => {
    const invoke = vi.fn(async (command: string) => command === "load_thread_cache" ? null : null);
    const cache = createServerThreadCache({ invoke } as Pick<TauriIpc, "invoke">);
    await cache.load(SERVER_ID, null);
    await cache.save({ serverId: SERVER_ID, threads: [], nextThreadCursor: null, currentThreadId: null, restoredThread: null });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["load_thread_cache", "save_thread_cache"]);
  });
});
