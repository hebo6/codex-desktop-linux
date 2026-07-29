import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  ThreadItemsListResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
} from "../protocol/generated";
import type { ServerThreadsClient } from "./useServerThreads";
import { useThreadSession } from "./useThreadSession";

const THREAD = {
  cliVersion: "1.0.0",
  createdAt: 100,
  cwd: "/workspace/project",
  ephemeral: false,
  historyMode: "paginated",
  id: "thread-a",
  modelProvider: "openai",
  name: "会话 A",
  preview: "任务 A",
  sessionId: "session-a",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 200,
} satisfies ThreadResumeResponse["thread"];

function resumeResponse(
  initialTurnsPage: NonNullable<ThreadResumeResponse["initialTurnsPage"]>,
): ThreadResumeResponse {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: "/workspace/project",
    initialTurnsPage,
    model: "gpt-5",
    modelProvider: "openai",
    reasoningEffort: null,
    sandbox: { type: "readOnly" },
    serviceTier: null,
    thread: THREAD,
  };
}

describe("useThreadSession", () => {
  it("StrictMode 重挂载不重复恢复，真实卸载只退订一次", async () => {
    const resumeThread = vi.fn(() => ({
      result: Promise.resolve(resumeResponse({
        data: [],
        nextCursor: null,
      })),
    }));
    const unsubscribeThread = vi.fn(() => ({
      result: Promise.resolve({ status: "unsubscribed" as const }),
    }));
    const client = {
      resumeThread,
      listThreadItems: vi.fn(),
      listThreadTurns: vi.fn(),
      subscribeNotifications: () => () => undefined,
      unsubscribeThread,
    } as unknown as ServerThreadsClient;

    const { result, unmount } = renderHook(
      () => useThreadSession(client, "thread-a"),
      { reactStrictMode: true },
    );

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(resumeThread).toHaveBeenCalledTimes(1);
    expect(unsubscribeThread).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(unsubscribeThread).toHaveBeenCalledTimes(1));
    expect(unsubscribeThread).toHaveBeenCalledWith("thread-a");
  });

  it("按回合项目分页恢复完整工具历史并向前加载更早回合", async () => {
    const turn = (
      id: string,
    ): ThreadTurnsListResponse["data"][number] => ({
      id,
      items: [],
      itemsView: "notLoaded",
      status: "completed",
    });
    const command = {
      aggregatedOutput: "完成",
      command: "git status --short",
      commandActions: [],
      cwd: "/workspace/project",
      exitCode: 0,
      id: "command-3",
      status: "completed",
      type: "commandExecution",
    } satisfies ThreadItemsListResponse["data"][number]["item"];
    const userMessage = (id: string, text: string) => ({
      content: [{ text, type: "text" as const }],
      id,
      type: "userMessage" as const,
    }) satisfies ThreadItemsListResponse["data"][number]["item"];
    const agentMessage = {
      id: "agent-3",
      phase: "final_answer",
      text: "已完成",
      type: "agentMessage",
    } satisfies ThreadItemsListResponse["data"][number]["item"];
    const resumeThread = vi.fn(() => ({
      result: Promise.resolve(resumeResponse({
        data: [turn("turn-3"), turn("turn-2")],
        nextCursor: "older-turns",
      })),
    }));
    const listThreadTurns = vi.fn(() => ({
      result: Promise.resolve({
        data: [turn("turn-1")],
        nextCursor: null,
      } satisfies ThreadTurnsListResponse),
    }));
    const listThreadItems = vi.fn((
      _threadId: string,
      turnId: string,
      cursor: string | null = null,
    ) => {
      const response: ThreadItemsListResponse =
        turnId === "turn-3" && cursor === null
          ? {
              data: [{ item: command, turnId }],
              nextCursor: "turn-3-more",
            }
          : turnId === "turn-3"
            ? {
                data: [{ item: agentMessage, turnId }],
                nextCursor: null,
              }
            : {
                data: [{
                  item: userMessage(`message-${turnId}`, turnId),
                  turnId,
                }],
                nextCursor: null,
              };
      return { result: Promise.resolve(response) };
    });
    const unsubscribeThread = vi.fn(() => ({
      result: Promise.resolve({ status: "unsubscribed" as const }),
    }));
    const client = {
      listThreadItems,
      listThreadTurns,
      resumeThread,
      subscribeNotifications: () => () => undefined,
      unsubscribeThread,
    } as unknown as ServerThreadsClient;

    const { result } = renderHook(
      () => useThreadSession(client, "thread-a"),
    );

    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    expect(
      result.current.state.restoredThread?.turns.map(({ id }) => id),
    ).toEqual(["turn-2", "turn-3"]);
    expect(
      result.current.state.restoredThread?.turns.at(-1)?.items.map(({ id }) => id),
    ).toEqual(["command-3", "agent-3"]);
    expect(result.current.state.olderTurnsCursor).toBe("older-turns");
    expect(listThreadItems).toHaveBeenCalledWith(
      "thread-a",
      "turn-3",
      "turn-3-more",
    );

    await act(async () => {
      expect(await result.current.loadOlderTurns()).toBe(true);
    });

    expect(listThreadTurns).toHaveBeenCalledWith(
      "thread-a",
      "older-turns",
    );
    expect(
      result.current.state.restoredThread?.turns.map(({ id }) => id),
    ).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(result.current.state.olderTurnsCursor).toBeNull();
    expect(result.current.state.olderTurnsError).toBeNull();
  });

  it("拒绝把 legacy 会话伪装成完整历史恢复", async () => {
    const listThreadItems = vi.fn();
    const client = {
      listThreadItems,
      listThreadTurns: vi.fn(),
      resumeThread: vi.fn(() => ({
        result: Promise.resolve({
          ...resumeResponse({ data: [], nextCursor: null }),
          thread: { ...THREAD, historyMode: "legacy" as const },
        }),
      })),
      subscribeNotifications: () => () => undefined,
      unsubscribeThread: vi.fn(() => ({
        result: Promise.resolve({ status: "unsubscribed" as const }),
      })),
    } as unknown as ServerThreadsClient;

    const { result } = renderHook(
      () => useThreadSession(client, "thread-a"),
    );

    await waitFor(() => expect(result.current.state.phase).toBe("error"));
    expect(result.current.state.error).toBe(
      "当前会话使用 legacy 历史格式，无法加载完整历史",
    );
    expect(listThreadItems).not.toHaveBeenCalled();
  });
});
