import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerThreadsClient } from "./useServerThreads";
import { useThreadSession } from "./useThreadSession";

describe("useThreadSession", () => {
  it("StrictMode 重挂载不重复恢复，真实卸载只退订一次", async () => {
    const resumeThread = vi.fn(() => ({
      result: Promise.resolve({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        cwd: "/workspace/project",
        model: "gpt-5",
        modelProvider: "openai",
        reasoningEffort: null,
        sandbox: { type: "readOnly" },
        serviceTier: null,
        thread: {
          cliVersion: "1.0.0",
          createdAt: 100,
          cwd: "/workspace/project",
          ephemeral: false,
          id: "thread-a",
          modelProvider: "openai",
          name: "会话 A",
          preview: "任务 A",
          sessionId: "session-a",
          source: "appServer",
          status: { type: "idle" },
          turns: [],
          updatedAt: 200,
        },
      }),
    }));
    const unsubscribeThread = vi.fn(() => ({
      result: Promise.resolve({ status: "unsubscribed" as const }),
    }));
    const client = {
      resumeThread,
      subscribeNotifications: () => () => undefined,
      unsubscribeThread,
    } as unknown as ServerThreadsClient;

    const { result, unmount } = renderHook(
      () => useThreadSession(client, "thread-a"),
      { reactStrictMode: true },
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(resumeThread).toHaveBeenCalledTimes(1);
    expect(unsubscribeThread).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(unsubscribeThread).toHaveBeenCalledTimes(1));
    expect(unsubscribeThread).toHaveBeenCalledWith("thread-a");
  });
});
