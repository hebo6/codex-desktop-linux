import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import {
  createAsyncQuestionResponseStore,
  parseAsyncQuestionResponses,
} from "./asyncQuestionResponses";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

describe("asyncQuestionResponses", () => {
  it("记录完成后才读取，避免重新加载时重新显示已处理问题", async () => {
    let completeRecord!: () => void;
    const pendingRecord = new Promise<void>((resolve) => {
      completeRecord = resolve;
    });
    const response = { questionKey: '["turn-1","item-1",0]', disposition: "sent" as const };
    const invoke = vi.fn()
      .mockReturnValueOnce(pendingRecord)
      .mockResolvedValueOnce([response]);
    const store = createAsyncQuestionResponseStore({ invoke });

    const recording = store.record(SERVER_ID, "thread-1", response);
    const listing = store.list(SERVER_ID, "thread-1");
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);
    completeRecord();
    await recording;
    await expect(listing).resolves.toEqual([response]);

    expect(invoke.mock.calls).toEqual([
      ["record_async_question_response", {
        request: { serverId: SERVER_ID, threadId: "thread-1", response },
      }],
      ["list_async_question_responses", {
        request: { serverId: SERVER_ID, threadId: "thread-1" },
      }],
    ]);
  });

  it("单次写入失败不会阻断后续记录", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValue(undefined);
    const store = createAsyncQuestionResponseStore({ invoke });
    const response = { questionKey: "question-1", disposition: "ignored" as const };

    await expect(store.record(SERVER_ID, "thread-1", response))
      .rejects.toThrow("storage unavailable");
    await expect(store.record(SERVER_ID, "thread-1", response)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    undefined,
    {},
    [null],
    [{ questionKey: "", disposition: "sent" }],
    [{ questionKey: 1, disposition: "sent" }],
    [{ questionKey: "question-1" }],
    [{ questionKey: "question-1", disposition: "answered" }],
    [{ questionKey: "question-1", disposition: "sent", answer: "不应保存答案" }],
  ])("拒绝格式不符或包含回答原文的持久化结果：%j", (value) => {
    expect(() => parseAsyncQuestionResponses(value)).toThrow(TypeError);
  });

  it("保留不透明问题标识并冻结读取结果", () => {
    const result = parseAsyncQuestionResponses([
      { questionKey: '["turn-1","item-1",0]', disposition: "sent" },
      { questionKey: "opaque-key", disposition: "ignored" },
    ]);

    expect(result).toEqual([
      { questionKey: '["turn-1","item-1",0]', disposition: "sent" },
      { questionKey: "opaque-key", disposition: "ignored" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
  });
});
