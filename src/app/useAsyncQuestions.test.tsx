import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerId } from "../configuration";
import type { ServerNotification } from "../protocol/generated";
import type {
  AsyncQuestionResponse,
  AsyncQuestionResponseStore,
} from "../transport/asyncQuestionResponses";
import { useAsyncQuestions } from "./useAsyncQuestions";
import type { ThreadTurn } from "./useServerThreads";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const OTHER_SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;
const FIRST_KEY = JSON.stringify(["turn-1", "item-1", 0]);
const SECOND_KEY = JSON.stringify(["turn-1", "item-1", 1]);
const THIRD_KEY = JSON.stringify(["turn-1", "item-1", 2]);

type HookOptions = Parameters<typeof useAsyncQuestions>[0];
type AgentMessage = Extract<ThreadTurn["items"][number], { type: "agentMessage" }>;

function testStore() {
  const persisted = new Map<string, Map<string, AsyncQuestionResponse>>();
  return {
    list: vi.fn<AsyncQuestionResponseStore["list"]>(async (serverId, threadId) =>
      [...(persisted.get(JSON.stringify([serverId, threadId]))?.values() ?? [])]
    ),
    record: vi.fn<AsyncQuestionResponseStore["record"]>(async (serverId, threadId, response) => {
      const scope = JSON.stringify([serverId, threadId]);
      const responses = persisted.get(scope) ?? new Map<string, AsyncQuestionResponse>();
      responses.set(response.questionKey, response);
      persisted.set(scope, responses);
    }),
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function questionItem(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: "item-1",
    type: "agentMessage",
    delivery: "async",
    text: "选择讲解详细程度",
    questions: [{ title: "讲解详细程度？", options: ["简洁", "适中：原理加一个示例"] }],
    ...overrides,
  };
}

function turn(items: ThreadTurn["items"] = [questionItem()]): ThreadTurn {
  return { id: "turn-1", status: "inProgress", itemsView: "full", items };
}

function renderQuestions(overrides: Partial<HookOptions> = {}) {
  const props: HookOptions = {
    client: null,
    serverId: SERVER_ID,
    threadId: "thread-1",
    turns: [turn()],
    disabled: false,
    sendAnswer: vi.fn(async () => true),
    store: testStore(),
    ...overrides,
  };
  return {
    ...renderHook((options: HookOptions) => useAsyncQuestions(options), { initialProps: props }),
    props,
  };
}

describe("useAsyncQuestions", () => {
  it("历史撤回后清除问题缓存，迟到的提交结果不会覆盖重载问题", async () => {
    let notify!: (notification: ServerNotification) => void;
    const client = {
      subscribeNotifications(handler: typeof notify) {
        notify = handler;
        return () => undefined;
      },
    };
    const pending = deferred<boolean>();
    const store = testStore();
    const { result, props, rerender } = renderQuestions({
      client, store, sendAnswer: () => pending.promise,
    });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    let submission!: Promise<void>;
    act(() => { submission = result.current.answer(FIRST_KEY, "简洁"); });
    act(() => {
      notify({ method: "thread/reverted", params: { threadId: "thread-1" } });
      rerender({ ...props, turns: [] });
    });
    expect(result.current.questions).toEqual([]);
    rerender({ ...props, turns: [turn()] });
    await act(async () => {
      pending.resolve(true);
      await submission;
    });
    expect(result.current.questions[0]).toMatchObject({ key: FIRST_KEY, status: "pending" });
    expect(store.record).not.toHaveBeenCalled();
  });

  it("后台会话的历史撤回仅清除对应会话的问题", async () => {
    let notify!: (notification: ServerNotification) => void;
    const client = {
      subscribeNotifications(handler: typeof notify) {
        notify = handler;
        return () => undefined;
      },
    };
    const { result, props, rerender } = renderQuestions({ client });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    rerender({ ...props, threadId: "thread-2" });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    act(() => notify({ method: "thread/reverted", params: { threadId: "thread-1" } }));
    expect(result.current.questions).toHaveLength(1);
    rerender({ ...props, turns: [] });
    expect(result.current.questions).toEqual([]);
  });

  it("只收集带结构化问题的异步消息，普通消息和异步正文不产生问题", async () => {
    const { result } = renderQuestions({
      turns: [turn([
        questionItem(),
        questionItem({ id: "ordinary", delivery: null }),
        {
          id: "no-delivery",
          type: "agentMessage",
          text: "普通消息",
          questions: [{ title: "不应显示为异步问题" }],
        },
        { id: "async-no-questions", type: "agentMessage", delivery: "async", text: "异步通知" },
        questionItem({ id: "async-text", questions: null }),
        questionItem({ id: "async-empty", questions: [] }),
        questionItem({
          id: "freeform",
          questions: [{ title: "还有什么要求？" }],
        }),
      ])],
    });

    await waitFor(() => expect(result.current.questions).toHaveLength(2));
    expect(result.current.questions).toMatchObject([
      { key: FIRST_KEY, title: "讲解详细程度？", options: ["简洁", "适中：原理加一个示例"] },
      { key: JSON.stringify(["turn-1", "freeform", 0]), title: "还有什么要求？", options: null },
    ]);
  });

  it("相同问题刷新时不重复，新问题不替换当前选择或展开状态", async () => {
    const questions = [
      { title: "讲解详细程度？", options: ["简洁", "适中"] },
      { title: "选择技术栈？", options: ["React", "Vue"] },
    ];
    const { result, rerender, props } = renderQuestions({
      turns: [turn([questionItem({ questions })])],
    });
    await waitFor(() => expect(result.current.questions).toHaveLength(2));
    act(() => {
      result.current.select(SECOND_KEY);
      result.current.setCustomAnswer(SECOND_KEY, true);
      result.current.setDraft(SECOND_KEY, "我正在填写的答案");
      result.current.setExpanded(false);
    });

    rerender({
      ...props,
      turns: [turn([questionItem({
        questions: [...questions.map((question) => ({ ...question })), { title: "部署到哪里？" }],
      })])],
    });

    expect(result.current.questions).toHaveLength(3);
    expect(result.current.selectedKey).toBe(SECOND_KEY);
    expect(result.current.expanded).toBe(false);
    expect(result.current.questions[1]).toMatchObject({
      draft: "我正在填写的答案",
      customAnswer: true,
    });
  });

  it("回合结束与后续回合开始都保留未处理问题", async () => {
    const { result, rerender, props } = renderQuestions();
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    rerender({ ...props, turns: [{ ...turn(), status: "completed" }] });
    expect(result.current.questions.map(({ key }) => key)).toEqual([FIRST_KEY]);

    rerender({ ...props, turns: [{ ...turn([]), id: "turn-2" }] });
    expect(result.current.questions.map(({ key }) => key)).toEqual([FIRST_KEY]);
  });

  it.each([
    { custom: false, text: "适中：原理加一个示例" },
    { custom: true, text: "  使用原理讲解\n然后给一个示例  " },
  ])("仅发送答案原文并在成功后记录（自定义：$custom）", async ({ custom, text }) => {
    const store = testStore();
    const sendAnswer = vi.fn(async () => true);
    const { result } = renderQuestions({ store, sendAnswer });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    if (custom) {
      act(() => {
        result.current.setCustomAnswer(FIRST_KEY, true);
        result.current.setDraft(FIRST_KEY, text);
      });
    }

    await act(async () => result.current.answer(FIRST_KEY, text));

    expect(sendAnswer).toHaveBeenCalledExactlyOnceWith(text);
    expect(store.record).toHaveBeenCalledExactlyOnceWith(SERVER_ID, "thread-1", {
      questionKey: FIRST_KEY,
      disposition: "sent",
    });
    expect(result.current.questions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("发送和忽略均持久化，切换线程、服务器和重新挂载后不会重复提示", async () => {
    const store = testStore();
    const sendAnswer = vi.fn(async () => true);
    const turns = [turn([questionItem({ questions: [
      { title: "已回答的问题", options: ["确定"] },
      { title: "稍后忽略的问题" },
      { title: "尚未处理的问题" },
    ] })])];
    const { result, props, rerender, unmount } = renderQuestions({ store, sendAnswer, turns });
    await waitFor(() => expect(result.current.questions).toHaveLength(3));
    await act(async () => result.current.answer(FIRST_KEY, "确定"));
    act(() => result.current.ignore(SECOND_KEY));
    await waitFor(() => expect(store.record).toHaveBeenCalledTimes(2));
    expect(store.record).toHaveBeenLastCalledWith(SERVER_ID, "thread-1", {
      questionKey: SECOND_KEY,
      disposition: "ignored",
    });
    expect(sendAnswer).toHaveBeenCalledOnce();
    expect(result.current.questions.map(({ key }) => key)).toEqual([THIRD_KEY]);

    rerender({ ...props, threadId: "thread-2" });
    await waitFor(() => expect(result.current.questions).toHaveLength(3));
    rerender({ ...props, serverId: OTHER_SERVER_ID });
    await waitFor(() => expect(result.current.questions).toHaveLength(3));
    rerender(props);
    expect(result.current.questions.map(({ key }) => key)).toEqual([THIRD_KEY]);
    unmount();

    const restarted = renderQuestions(props);
    await waitFor(() => expect(restarted.result.current.questions).toHaveLength(1));
    expect(restarted.result.current.questions.map(({ key }) => key)).toEqual([THIRD_KEY]);
  });

  it.each(["false", "throw"])("发送返回 %s 时保留答案并标记结果不确定", async (outcome) => {
    const store = testStore();
    const sendAnswer = vi.fn(async () => {
      if (outcome === "throw") throw new Error("connection unavailable");
      return false;
    });
    const { result } = renderQuestions({ store, sendAnswer });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    act(() => {
      result.current.setCustomAnswer(FIRST_KEY, true);
      result.current.setDraft(FIRST_KEY, "我的回答");
    });
    await act(async () => result.current.answer(FIRST_KEY, "我的回答"));

    expect(result.current.questions).toHaveLength(1);
    expect(result.current.questions[0]).toMatchObject({
      status: "uncertain",
      answer: "我的回答",
      draft: "我的回答",
      customAnswer: true,
      error: expect.stringContaining("发送结果未确认"),
    });
    expect(result.current.selectedKey).toBe(FIRST_KEY);
    expect(store.record).not.toHaveBeenCalled();
  });

  it("发送进行中重复提交或忽略不会造成第二次发送", async () => {
    const pending = deferred<boolean>();
    const store = testStore();
    const sendAnswer = vi.fn(() => pending.promise);
    const { result } = renderQuestions({ store, sendAnswer });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    let submission!: Promise<void>;
    act(() => {
      submission = result.current.answer(FIRST_KEY, "简洁");
      void result.current.answer(FIRST_KEY, "适中：原理加一个示例");
      result.current.ignore(FIRST_KEY);
    });

    expect(sendAnswer).toHaveBeenCalledExactlyOnceWith("简洁");
    expect(result.current.questions[0]).toMatchObject({ status: "sending", answer: "简洁" });
    expect(store.record).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(true);
      await submission;
    });
    expect(result.current.questions).toEqual([]);
    expect(store.record).toHaveBeenCalledOnce();
  });

  it("上一题的记录仍在保存时允许回答下一题", async () => {
    const saving = deferred<void>();
    const store = testStore();
    store.record.mockReturnValue(saving.promise);
    const sendAnswer = vi.fn(async () => true);
    const { result } = renderQuestions({ store, sendAnswer, turns: [turn([questionItem({ questions: [
      { title: "第一题", options: ["第一题答案"] },
      { title: "第二题", options: ["第二题答案"] },
    ] })])] });
    await waitFor(() => expect(result.current.questions).toHaveLength(2));
    await act(async () => result.current.answer(FIRST_KEY, "第一题答案"));
    await act(async () => result.current.answer(SECOND_KEY, "第二题答案"));
    expect(sendAnswer.mock.calls).toEqual([["第一题答案"], ["第二题答案"]]);
    expect(result.current.questions).toEqual([]);
    await act(async () => saving.resolve());
  });

  it("发送期间切换线程，成功记录仍归属原线程", async () => {
    const pending = deferred<boolean>();
    const store = testStore();
    const sendAnswer = vi.fn(() => pending.promise);
    const { result, rerender, props } = renderQuestions({ store, sendAnswer });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    let submission!: Promise<void>;
    act(() => {
      submission = result.current.answer(FIRST_KEY, "简洁");
    });
    rerender({ ...props, threadId: "thread-2" });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    expect(result.current.questions[0]?.status).toBe("pending");

    await act(async () => {
      pending.resolve(true);
      await submission;
    });

    expect(store.record).toHaveBeenCalledExactlyOnceWith(SERVER_ID, "thread-1", {
      questionKey: FIRST_KEY,
      disposition: "sent",
    });
    expect(result.current.questions[0]).toMatchObject({ key: FIRST_KEY, status: "pending" });
    rerender(props);
    expect(result.current.questions).toEqual([]);
  });

  it("读取失败显示错误并等待显式重试，读取成功前不能提交", async () => {
    const store = testStore();
    store.list.mockRejectedValueOnce(new Error("storage unavailable"));
    const sendAnswer = vi.fn(async () => true);
    const { result, props, rerender } = renderQuestions({ store, sendAnswer });
    await waitFor(() => expect(result.current.error).toContain("无法读取问题处理记录"));
    rerender({ ...props, turns: [turn([questionItem({ text: "流式更新" })])] });
    expect(result.current.questions).toEqual([]);
    await act(async () => result.current.answer(FIRST_KEY, "简洁"));
    expect(sendAnswer).not.toHaveBeenCalled();
    expect(store.list).toHaveBeenCalledOnce();

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(store.list).toHaveBeenCalledTimes(2);
  });

  it("发送成功但记录失败时仅重试存储，不重新发送答案", async () => {
    const store = testStore();
    store.record.mockRejectedValueOnce(new Error("storage unavailable"));
    const sendAnswer = vi.fn(async () => true);
    const turns = [turn([questionItem({ questions: [
      { title: "需要回答的问题", options: ["简洁"] },
      { title: "保留的问题" },
    ] })])];
    const { result, props, unmount } = renderQuestions({ store, sendAnswer, turns });
    await waitFor(() => expect(result.current.questions).toHaveLength(2));
    await act(async () => result.current.answer(FIRST_KEY, "简洁"));
    expect(result.current.questions.map(({ key }) => key)).toEqual([SECOND_KEY]);
    expect(result.current.error).toContain("问题处理记录未保存");

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(sendAnswer).toHaveBeenCalledExactlyOnceWith("简洁");
    expect(store.record).toHaveBeenCalledTimes(2);
    expect(store.record.mock.calls[1]).toEqual(store.record.mock.calls[0]);
    unmount();

    const restarted = renderQuestions(props);
    await waitFor(() => expect(restarted.result.current.questions).toHaveLength(1));
    expect(restarted.result.current.questions.map(({ key }) => key)).toEqual([SECOND_KEY]);
  });

  it("禁用发送时保留问题和草稿，空白答案不会发送", async () => {
    const store = testStore();
    const sendAnswer = vi.fn(async () => true);
    const { result, props, rerender } = renderQuestions({ store, sendAnswer, disabled: true });
    await waitFor(() => expect(result.current.questions).toHaveLength(1));
    act(() => result.current.setDraft(FIRST_KEY, "草稿"));
    await act(async () => result.current.answer(FIRST_KEY, "简洁"));
    expect(sendAnswer).not.toHaveBeenCalled();
    expect(result.current.questions[0]).toMatchObject({ status: "pending", draft: "草稿" });

    rerender({ ...props, disabled: false });
    await act(async () => result.current.answer(FIRST_KEY, " \n "));
    expect(sendAnswer).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });
});
