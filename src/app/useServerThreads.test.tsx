import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  ServerNotification,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadTurnsListResponse,
  ThreadUnsubscribeResponse,
  ThreadArchiveResponse,
  ThreadUnarchiveResponse,
  ThreadDeleteResponse,
} from "../protocol/generated";
import { useServerThreads } from "./useServerThreads";
import type { ServerThreadsClient } from "./useServerThreads";
import type { ServerId } from "../configuration";
import type { ServerThreadCache } from "../transport/offlineCache";

const THREAD_ONE = {
  cliVersion: "1.0.0",
  createdAt: 100,
  cwd: "/workspace/one",
  ephemeral: false,
  id: "thread-1",
  modelProvider: "openai",
  preview: "第一个会话",
  sessionId: "session-1",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 200,
} satisfies ThreadListResponse["data"][number];
const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

const THREAD_TWO = {
  ...THREAD_ONE,
  id: "thread-2",
  preview: "第二个会话",
  sessionId: "session-2",
  updatedAt: 190,
} satisfies ThreadListResponse["data"][number];

const THREAD_THREE = {
  ...THREAD_ONE,
  id: "thread-3",
  preview: "第三个会话",
  sessionId: "session-3",
  updatedAt: 180,
} satisfies ThreadListResponse["data"][number];

const TURN_ZERO = {
  id: "turn-0",
  items: [],
  itemsView: "full",
  status: "completed",
} satisfies ThreadTurnsListResponse["data"][number];

const TURN_ONE = {
  ...TURN_ZERO,
  id: "turn-1",
} satisfies ThreadTurnsListResponse["data"][number];

const TURN_TWO = {
  ...TURN_ZERO,
  id: "turn-2",
} satisfies ThreadTurnsListResponse["data"][number];

class FakeThreadClient implements ServerThreadsClient {
  readonly notificationHandlers = new Set<
    (notification: ServerNotification) => void
  >();
  readonly listCalls: unknown[] = [];
  readonly readCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  readonly turnsCalls: Array<{ threadId: string; cursor: string }> = [];
  readonly listResults: Array<Promise<ThreadListResponse>> = [];
  readonly readResults: Array<Promise<ThreadReadResponse>> = [];
  readonly resumeResults: Array<Promise<ThreadResumeResponse>> = [];
  readonly turnsResults: Array<Promise<ThreadTurnsListResponse>> = [];
  readonly unsubscribeCalls: string[] = [];
  readonly archiveCalls: string[] = [];
  readonly unarchiveCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  readonly archiveResults: Array<Promise<ThreadArchiveResponse>> = [];
  readonly unarchiveResults: Array<Promise<ThreadUnarchiveResponse>> = [];
  readonly deleteResults: Array<Promise<ThreadDeleteResponse>> = [];

  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  emit(notification: ServerNotification) {
    for (const handler of this.notificationHandlers) handler(notification);
  }

  listRecentThreads(options: unknown = {}) {
    this.listCalls.push(options);
    return { result: nextResult(this.listResults) };
  }

  readThread(threadId: string) {
    this.readCalls.push(threadId);
    return { result: nextResult(this.readResults) };
  }

  resumeThread(threadId: string) {
    this.resumeCalls.push(threadId);
    return { result: nextResult(this.resumeResults) };
  }

  listOlderTurns(threadId: string, cursor: string) {
    this.turnsCalls.push({ threadId, cursor });
    return { result: nextResult(this.turnsResults) };
  }

  unsubscribeThread(threadId: string) {
    this.unsubscribeCalls.push(threadId);
    return {
      result: Promise.resolve({ status: "unsubscribed" } satisfies ThreadUnsubscribeResponse),
    };
  }

  archiveThread(threadId: string) {
    this.archiveCalls.push(threadId);
    return { result: nextResult(this.archiveResults) };
  }

  unarchiveThread(threadId: string) {
    this.unarchiveCalls.push(threadId);
    return { result: nextResult(this.unarchiveResults) };
  }

  deleteThread(threadId: string) {
    this.deleteCalls.push(threadId);
    return { result: nextResult(this.deleteResults) };
  }
}

function nextResult<T>(queue: Array<Promise<T>>): Promise<T> {
  const result = queue.shift();
  if (result === undefined) {
    throw new Error("missing fake result");
  }
  return result;
}

function resumeResponse(
  descendingTurns: ThreadTurnsListResponse["data"],
  nextCursor: string | null,
): ThreadResumeResponse {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: THREAD_ONE.cwd,
    initialTurnsPage: { data: descendingTurns, nextCursor },
    model: "gpt-5",
    modelProvider: "openai",
    sandbox: { type: "readOnly" },
    thread: { ...THREAD_ONE, turns: descendingTurns },
  };
}

function startResponse(thread: ThreadListResponse["data"][number]): ThreadStartResponse {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: thread.cwd,
    model: "gpt-5",
    modelProvider: "openai",
    sandbox: { type: "readOnly" },
    thread,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useServerThreads", () => {
  it("连接就绪后并行加载最近会话并恢复窗口会话", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO], nextCursor: "next" }),
    );
    client.resumeResults.push(
      Promise.resolve(resumeResponse([TURN_TWO, TURN_ONE], "older")),
    );
    const { result } = renderHook(() =>
      useServerThreads(client, THREAD_ONE.id),
    );

    expect(result.current.phase).toBe("loading");
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    expect(client.listCalls).toEqual([{}]);
    expect(client.resumeCalls).toEqual([THREAD_ONE.id]);
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_ONE.id,
      THREAD_TWO.id,
    ]);
    expect(result.current.restoredThread?.turns.map(({ id }) => id)).toEqual([
      TURN_ONE.id,
      TURN_TWO.id,
    ]);
    expect(result.current.restoredThread?.nextCursor).toBe("older");
  });

  it("新建线程直接采用 thread/start 响应而不重新恢复", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO], nextCursor: "next" }),
    );
    const startedThread = {
      ...THREAD_THREE,
      updatedAt: 300,
    };
    const { result, rerender } = renderHook(
      ({ threadId }) => useServerThreads(client, threadId),
      { initialProps: { threadId: null as string | null } },
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    act(() => {
      result.current.prepareStartedThread(startResponse(startedThread));
    });
    rerender({ threadId: startedThread.id });

    await waitFor(() =>
      expect(result.current.restoredThread?.metadata.id).toBe(startedThread.id),
    );
    expect(client.listCalls).toEqual([{}]);
    expect(client.resumeCalls).toEqual([]);
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      startedThread.id,
      THREAD_ONE.id,
      THREAD_TWO.id,
    ]);
    expect(result.current.restoredThread).toMatchObject({
      metadata: startedThread,
      nextCursor: null,
      turns: [],
    });
  });

  it("窗口状态更新失败后撤销新建线程交接", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE], nextCursor: null }),
      Promise.resolve({ data: [THREAD_THREE, THREAD_ONE], nextCursor: null }),
    );
    client.resumeResults.push(
      Promise.resolve({
        ...resumeResponse([TURN_ONE], null),
        thread: { ...THREAD_THREE, turns: [] },
      }),
    );
    const { result, rerender } = renderHook(
      ({ threadId }) => useServerThreads(client, threadId),
      { initialProps: { threadId: null as string | null } },
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    let cancelPreparation: (() => void) | undefined;
    act(() => {
      cancelPreparation = result.current.prepareStartedThread(
        startResponse(THREAD_THREE),
      );
    });
    cancelPreparation?.();
    rerender({ threadId: THREAD_THREE.id });

    await waitFor(() =>
      expect(result.current.restoredThread?.metadata.id).toBe(THREAD_THREE.id),
    );
    expect(client.listCalls).toEqual([{}, {}]);
    expect(client.resumeCalls).toEqual([THREAD_THREE.id]);
    expect(result.current.restoredThread?.turns).toEqual([TURN_ONE]);
  });

  it("按游标追加会话并向前合并更早 turn，重复 ID 保持幂等", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO], nextCursor: "next" }),
      Promise.resolve({
        data: [THREAD_TWO, THREAD_THREE, THREAD_THREE],
        nextCursor: null,
      }),
    );
    client.resumeResults.push(
      Promise.resolve(resumeResponse([TURN_TWO, TURN_ONE], "older")),
    );
    client.turnsResults.push(
      Promise.resolve({ data: [TURN_ONE, TURN_ZERO, TURN_ZERO] }),
    );
    const { result } = renderHook(() =>
      useServerThreads(client, THREAD_ONE.id),
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    await act(async () => result.current.loadMoreThreads());
    await act(async () => result.current.loadOlderTurns());

    expect(client.listCalls).toEqual([{}, { cursor: "next" }]);
    expect(client.turnsCalls).toEqual([
      { threadId: THREAD_ONE.id, cursor: "older" },
    ]);
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_ONE.id,
      THREAD_TWO.id,
      THREAD_THREE.id,
    ]);
    expect(result.current.restoredThread?.turns.map(({ id }) => id)).toEqual([
      TURN_ZERO.id,
      TURN_ONE.id,
      TURN_TWO.id,
    ]);
  });

  it("手动刷新最近会话并保留已加载的旧记录", async () => {
    const client = new FakeThreadClient();
    const refreshResult = deferred<ThreadListResponse>();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO], nextCursor: "next" }),
      refreshResult.promise,
    );
    const { result } = renderHook(() => useServerThreads(client, null));
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    let refresh: Promise<void> | undefined;
    act(() => {
      refresh = result.current.refreshThreads();
    });
    expect(result.current.refreshingThreads).toBe(true);
    expect(client.listCalls).toEqual([{}, {}]);

    refreshResult.resolve({ data: [THREAD_THREE], nextCursor: "new-next" });
    await act(async () => refresh);

    expect(result.current.refreshingThreads).toBe(false);
    expect(result.current.nextThreadCursor).toBe("new-next");
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_THREE.id,
      THREAD_ONE.id,
      THREAD_TWO.id,
    ]);
  });

  it("切换连接后忽略旧连接的迟到结果", async () => {
    const firstList = deferred<ThreadListResponse>();
    const first = new FakeThreadClient();
    first.listResults.push(firstList.promise);
    const second = new FakeThreadClient();
    second.listResults.push(Promise.resolve({ data: [THREAD_TWO] }));
    const { result, rerender } = renderHook(
      ({ client }) => useServerThreads(client, null),
      { initialProps: { client: first as ServerThreadsClient } },
    );

    rerender({ client: second });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_TWO.id,
    ]);

    firstList.resolve({ data: [THREAD_ONE] });
    await act(async () => firstList.promise);
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_TWO.id,
    ]);
  });

  it("切换当前会话时取消旧逻辑订阅", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO] }),
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO] }),
    );
    client.resumeResults.push(
      Promise.resolve(resumeResponse([], null)),
      Promise.resolve({
        ...resumeResponse([], null),
        thread: { ...THREAD_TWO, turns: [] },
      }),
    );
    const { rerender } = renderHook(
      ({ threadId }) => useServerThreads(client, threadId),
      { initialProps: { threadId: THREAD_ONE.id } },
    );
    await waitFor(() => expect(client.resumeCalls).toEqual([THREAD_ONE.id]));

    rerender({ threadId: THREAD_TWO.id });

    await waitFor(() =>
      expect(client.resumeCalls).toEqual([THREAD_ONE.id, THREAD_TWO.id]),
    );
    expect(client.unsubscribeCalls).toEqual([THREAD_ONE.id]);
  });

  it("同步其他窗口的会话名称、状态、归档、恢复和删除事实", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.resolve({ data: [THREAD_ONE, THREAD_TWO] }),
    );
    client.resumeResults.push(Promise.resolve(resumeResponse([], null)));
    client.readResults.push(
      Promise.resolve({ thread: { ...THREAD_THREE, name: "外部恢复" } }),
    );
    const { result } = renderHook(() =>
      useServerThreads(client, THREAD_ONE.id),
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    act(() => {
      client.emit({
        method: "thread/name/updated",
        params: { threadId: THREAD_ONE.id, threadName: "外部改名" },
      });
      client.emit({
        method: "thread/status/changed",
        params: {
          status: { activeFlags: ["waitingOnApproval"], type: "active" },
          threadId: THREAD_ONE.id,
        },
      });
      client.emit({
        method: "thread/unarchived",
        params: { threadId: THREAD_THREE.id },
      });
    });

    expect(result.current.threads[0]?.name).toBe("外部改名");
    expect(result.current.restoredThread?.metadata.name).toBe("外部改名");
    expect(result.current.restoredThread?.metadata.status).toEqual({
      activeFlags: ["waitingOnApproval"],
      type: "active",
    });
    await waitFor(() =>
      expect(result.current.threads.some(({ id }) => id === THREAD_THREE.id)).toBe(
        true,
      ),
    );
    expect(client.readCalls).toEqual([THREAD_THREE.id]);

    act(() => {
      client.emit({
        method: "thread/archived",
        params: { threadId: THREAD_TWO.id },
      });
    });
    expect(result.current.removingThreadIds).toContain(THREAD_TWO.id);
    await waitFor(() =>
      expect(result.current.threads.some(({ id }) => id === THREAD_TWO.id)).toBe(
        false,
      ),
    );

    act(() => {
      client.emit({
        method: "thread/deleted",
        params: { threadId: THREAD_ONE.id },
      });
    });
    expect(result.current.currentThreadDeleted).toBe(true);
    expect(result.current.restoredThread).toBeNull();
    await waitFor(() =>
      expect(result.current.threads.some(({ id }) => id === THREAD_ONE.id)).toBe(
        false,
      ),
    );
  });

  it("初始恢复期间也不会重新显示已被其他窗口删除的当前会话", async () => {
    const client = new FakeThreadClient();
    const listResult = deferred<ThreadListResponse>();
    const resumeResult = deferred<ThreadResumeResponse>();
    client.listResults.push(listResult.promise);
    client.resumeResults.push(resumeResult.promise);
    const { result } = renderHook(() =>
      useServerThreads(client, THREAD_ONE.id),
    );

    act(() => {
      client.emit({
        method: "thread/deleted",
        params: { threadId: THREAD_ONE.id },
      });
      listResult.resolve({ data: [THREAD_ONE, THREAD_TWO] });
      resumeResult.resolve(resumeResponse([], null));
    });

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.currentThreadDeleted).toBe(true);
    expect(result.current.restoredThread).toBeNull();
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_TWO.id,
    ]);
  });

  it("归档、撤销和删除成功后按服务端结果更新列表", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(Promise.resolve({ data: [THREAD_ONE, THREAD_TWO] }));
    client.archiveResults.push(Promise.resolve({}));
    client.unarchiveResults.push(Promise.resolve({ thread: THREAD_ONE }));
    client.deleteResults.push(Promise.resolve({}));
    const { result } = renderHook(() => useServerThreads(client, null));
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    let archiveResult: Promise<boolean> | undefined;
    act(() => {
      archiveResult = result.current.archiveThread(THREAD_ONE.id);
    });
    await waitFor(() =>
      expect(result.current.removingThreadIds).toEqual([THREAD_ONE.id]),
    );
    await act(async () => expect(await archiveResult).toBe(true));
    expect(result.current.threads.map(({ id }) => id)).toEqual([THREAD_TWO.id]);
    expect(result.current.removingThreadIds).toEqual([]);
    expect(result.current.archivedThread?.id).toBe(THREAD_ONE.id);

    await act(async () => {
      expect(await result.current.undoArchive()).toBe(true);
    });
    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_ONE.id,
      THREAD_TWO.id,
    ]);

    await act(async () => {
      expect(await result.current.deleteThread(THREAD_TWO.id)).toBe(true);
    });
    expect(result.current.threads.map(({ id }) => id)).toEqual([THREAD_ONE.id]);
    expect(client.archiveCalls).toEqual([THREAD_ONE.id]);
    expect(client.unarchiveCalls).toEqual([THREAD_ONE.id]);
    expect(client.deleteCalls).toEqual([THREAD_TWO.id]);
  });

  it("会话操作失败时保留原位置并显示稳定错误", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(Promise.resolve({ data: [THREAD_ONE, THREAD_TWO] }));
    const { result } = renderHook(() => useServerThreads(client, null));
    await waitFor(() => expect(result.current.phase).toBe("ready"));

    await act(async () => {
      client.archiveResults.push(Promise.reject(new Error("secret path")));
      expect(await result.current.archiveThread(THREAD_ONE.id)).toBe(false);
    });

    expect(result.current.threads.map(({ id }) => id)).toEqual([
      THREAD_ONE.id,
      THREAD_TWO.id,
    ]);
    expect(result.current.error).toBe("无法归档会话");
    expect(JSON.stringify(result.current)).not.toContain("secret");
  });

  it("加载错误只暴露稳定摘要", async () => {
    const client = new FakeThreadClient();
    client.listResults.push(
      Promise.reject(new Error("secret remote rollout path")),
    );
    const { result } = renderHook(() => useServerThreads(client, null));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toBe("无法加载最近会话");
    expect(JSON.stringify(result.current)).not.toContain("secret");
  });

  it("断线时恢复 SQLite 缓存并保持只读", async () => {
    const cache = {
      load: async () => ({
        threads: [THREAD_ONE],
        nextThreadCursor: "not-available-offline",
        restoredThread: {
          metadata: THREAD_ONE,
          turns: [TURN_ONE],
          nextCursor: "older",
        },
        syncedAtMs: 1234,
      }),
      save: async () => undefined,
    } satisfies ServerThreadCache;
    const { result } = renderHook(() =>
      useServerThreads(null, THREAD_ONE.id, cache, SERVER_ID),
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.offline).toBe(true);
    expect(result.current.lastSyncedAt).toBe(1234);
    expect(result.current.restoredThread?.turns[0]?.id).toBe(TURN_ONE.id);
    expect(result.current.restoredThread?.nextCursor).toBeNull();
    await expect(result.current.archiveThread(THREAD_ONE.id)).resolves.toBe(false);
  });
});
