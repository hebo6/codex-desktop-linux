import { describe, expect, it } from "vitest";

import { recentAsyncQuestion } from "./asyncQuestions";
import type { ThreadTurn } from "./useServerThreads";

const question = {
  id: "question-1",
  type: "agentMessage",
  text: "选择方向",
  delivery: "async",
  questions: [{ title: "选择方向", options: ["左", "右"] }],
} satisfies ThreadTurn["items"][number];
const reply = {
  id: "reply-1", type: "userMessage", content: [{ type: "text", text: "继续" }],
} satisfies ThreadTurn["items"][number];
const progress = {
  id: "progress-1", type: "agentMessage", text: "正在继续工作",
} satisfies ThreadTurn["items"][number];
const turn = (id: string, items: ThreadTurn["items"]): ThreadTurn => ({
  id, items, itemsView: "full", status: "completed",
});

describe("最近异步提问入口", () => {
  it("后续 AI 输出和回合结束不会隐藏入口", () => {
    expect(recentAsyncQuestion([turn("a", [reply, question]), turn("b", [progress])])).toBe(question);
  });

  it("同回合或下一回合出现任意用户消息后隐藏入口", () => {
    expect(recentAsyncQuestion([turn("a", [question, reply, progress])])).toBeNull();
    expect(recentAsyncQuestion([turn("a", [question]), turn("b", [reply, progress])])).toBeNull();
  });

  it("只定位最近一条提问，新的提问重新显示入口", () => {
    const newest = { ...question, id: "question-2" };
    expect(recentAsyncQuestion([turn("a", [question, reply, newest, progress])])).toBe(newest);
  });

  it("空历史、无结构化问题及普通消息不产生入口", () => {
    const { delivery: _delivery, ...ordinaryMessage } = question;
    expect(recentAsyncQuestion([])).toBeNull();
    expect(recentAsyncQuestion([turn("a", [
      progress,
      { ...question, questions: [] },
      { ...question, questions: null },
      ordinaryMessage,
    ])])).toBeNull();
  });
});
