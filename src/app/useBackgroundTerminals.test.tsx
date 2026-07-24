import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { BackgroundTerminalClient } from "../appServer";
import type {
  ServerNotification,
  ThreadBackgroundTerminalsListResponse,
  ThreadBackgroundTerminalsTerminateResponse,
} from "../protocol/generated";
import type { RequestHandle } from "../protocol/rpc";
import { useBackgroundTerminals } from "./useBackgroundTerminals";

const THREAD_ID = "thread-1";
const COMMAND = {
  command: "sleep 60",
  cwd: "/workspace",
  itemId: "command-1",
  processId: "42",
} as const;

class FakeBackgroundTerminalClient implements BackgroundTerminalClient {
  readonly listCalls: Array<{
    readonly cursor?: string | null;
    readonly threadId: string;
  }> = [];
  readonly listResults: Promise<ThreadBackgroundTerminalsListResponse>[] = [];
  readonly notificationHandlers = new Set<
    (notification: ServerNotification) => void
  >();

  listBackgroundTerminals(threadId: string, cursor?: string | null) {
    this.listCalls.push({
      threadId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const result = this.listResults.shift();
    if (result === undefined) {
      throw new Error("missing background terminal list result");
    }
    return handle(result);
  }

  terminateBackgroundTerminal() {
    return handle(Promise.resolve({
      terminated: true,
    } satisfies ThreadBackgroundTerminalsTerminateResponse));
  }

  subscribeNotifications(handler: (notification: ServerNotification) => void) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  emit(notification: ServerNotification) {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }
}

function handle<T>(result: Promise<T>): RequestHandle<T> {
  return { epoch: 1, id: "request", stage: "pending", result };
}

function started(
  processId: string | null,
  itemId: string = COMMAND.itemId,
): ServerNotification {
  return {
    method: "item/started",
    params: {
      item: {
        command: COMMAND.command,
        commandActions: [],
        cwd: COMMAND.cwd,
        id: itemId,
        processId,
        status: "inProgress",
        type: "commandExecution",
      },
      startedAtMs: 1,
      threadId: THREAD_ID,
      turnId: "turn-1",
    },
  } as ServerNotification;
}

function completed(itemId = COMMAND.itemId): ServerNotification {
  return {
    method: "item/completed",
    params: {
      completedAtMs: 2,
      item: {
        command: COMMAND.command,
        commandActions: [],
        cwd: COMMAND.cwd,
        durationMs: 1_000,
        exitCode: 0,
        id: itemId,
        processId: COMMAND.processId,
        status: "completed",
        type: "commandExecution",
      },
      threadId: THREAD_ID,
      turnId: "turn-1",
    },
  } as ServerNotification;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useBackgroundTerminals", () => {
  it("仅在 resume 后加载一次快照，随后只按命令通知增量更新", async () => {
    const client = new FakeBackgroundTerminalClient();
    client.listResults.push(Promise.resolve({ data: [], nextCursor: null }));
    const { result, rerender } = renderHook(
      ({ resumedThreadId }: { resumedThreadId: string | null }) =>
        useBackgroundTerminals(client, THREAD_ID, resumedThreadId),
      {
        initialProps: { resumedThreadId: null as string | null },
        reactStrictMode: true,
      },
    );

    expect(client.listCalls).toEqual([]);

    rerender({ resumedThreadId: THREAD_ID });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(client.listCalls).toEqual([{ threadId: THREAD_ID }]);
    rerender({ resumedThreadId: THREAD_ID });
    expect(client.listCalls).toHaveLength(1);

    act(() => client.emit(started(COMMAND.processId)));
    expect(result.current.currentTerminals).toMatchObject([COMMAND]);
    expect(client.listCalls).toHaveLength(1);

    act(() => client.emit(started(null, "command-without-process")));
    expect(result.current.currentTerminals).toMatchObject([COMMAND]);
    expect(client.listCalls).toHaveLength(1);

    act(() => client.emit(completed()));
    expect(result.current.currentTerminals).toEqual([]);
    expect(client.listCalls).toHaveLength(1);
  });

  it("快照返回前收到完成通知时不恢复已经完成的命令", async () => {
    const client = new FakeBackgroundTerminalClient();
    const listResult = deferred<ThreadBackgroundTerminalsListResponse>();
    client.listResults.push(listResult.promise);
    const { result } = renderHook(() =>
      useBackgroundTerminals(client, THREAD_ID, THREAD_ID),
      { reactStrictMode: true },
    );

    await waitFor(() => expect(client.listCalls).toHaveLength(1));
    act(() => client.emit(completed()));
    await act(async () => {
      listResult.resolve({ data: [COMMAND], nextCursor: null });
      await listResult.promise;
    });

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.currentTerminals).toEqual([]);
    expect(client.listCalls).toHaveLength(1);
  });
});
