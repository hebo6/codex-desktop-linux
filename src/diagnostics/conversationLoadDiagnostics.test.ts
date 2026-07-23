import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadResumeResponse } from "../protocol/generated";
import {
  beginConversationLoadMeasurement,
  readConversationLoadDiagnostics,
  recordConversationFirstCommit,
  recordConversationProjection,
  resetConversationLoadDiagnosticsForTests,
} from "./conversationLoadDiagnostics";

afterEach(() => {
  resetConversationLoadDiagnosticsForTests();
  vi.restoreAllMocks();
});

describe("conversation load diagnostics", () => {
  it("记录恢复响应、投影和首次提交阶段且不保留会话标识", () => {
    let monotonicMs = 10;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const thread = {
      cliVersion: "1.0.0",
      createdAt: 1,
      cwd: "/private/workspace",
      ephemeral: false,
      id: "private-thread-id",
      modelProvider: "openai",
      preview: "private message",
      sessionId: "private-session-id",
      source: "appServer" as const,
      status: { type: "idle" as const },
      turns: [{ id: "turn-1", items: [], itemsView: "full", status: "completed" }],
      updatedAt: 2,
    } satisfies ThreadResumeResponse["thread"];
    const response = {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: thread.cwd,
      model: "gpt-5",
      modelProvider: "openai",
      sandbox: { type: "readOnly" },
      thread,
    } satisfies ThreadResumeResponse;
    const measurement = beginConversationLoadMeasurement();
    measurement.recordResponseTiming({
      envelopeValidationMs: 2,
      jsonCharacters: 4_096,
      jsonParseMs: 3,
      resultValidationMs: 4,
    });
    monotonicMs = 30;
    measurement.recordResponse(response);
    monotonicMs = 35;
    recordConversationProjection(thread, 5);
    monotonicMs = 42;
    recordConversationFirstCommit(thread);

    expect(readConversationLoadDiagnostics()).toEqual([{
      startedAtMs: 1_000,
      status: "succeeded",
      responseWaitMs: 20,
      jsonParseMs: 3,
      protocolValidationMs: 6,
      projectionMs: 5,
      renderCommitMs: 7,
      totalMs: 32,
      responseCharacters: 4_096,
      turnCount: 1,
      itemCount: 0,
    }]);
    expect(JSON.stringify(readConversationLoadDiagnostics())).not.toContain("private");
  });
});
