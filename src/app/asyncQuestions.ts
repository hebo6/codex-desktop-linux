import type { ThreadTurn } from "./useServerThreads";

type ThreadItem = ThreadTurn["items"][number];
type AsyncQuestionMessage = Extract<ThreadItem, { type: "agentMessage" }> & {
  readonly questions: NonNullable<Extract<ThreadItem, { type: "agentMessage" }>["questions"]>;
};

export function isAsyncQuestionMessage(item: ThreadItem): item is AsyncQuestionMessage {
  return item.type === "agentMessage"
    && item.delivery === "async"
    && item.questions !== undefined
    && item.questions !== null
    && item.questions.length > 0;
}

// 入口只反映消息顺序，不推断用户是否回答了某一道题
export function recentAsyncQuestion(turns: readonly ThreadTurn[]): AsyncQuestionMessage | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex]!.items;
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]!;
      if (item.type === "userMessage") return null;
      if (isAsyncQuestionMessage(item)) return item;
    }
  }
  return null;
}
