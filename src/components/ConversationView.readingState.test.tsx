import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RestoredThread, ThreadTurn } from "../app/useServerThreads";
import { ConversationView, type ConversationReadingStateStore } from "./ConversationView";

const HISTORY: ThreadTurn = {
  id: "history",
  status: "completed",
  itemsView: "full",
  items: [
    { id: "q1", type: "userMessage", content: [{ type: "text", text: "历史问题" }] },
    { id: "a1", type: "agentMessage", phase: "final_answer", text: "历史回答" },
  ],
};
const RUNNING: ThreadTurn = {
  id: "running",
  status: "inProgress",
  itemsView: "full",
  items: [
    { id: "q2", type: "userMessage", content: [{ type: "text", text: "当前问题" }] },
    { id: "a2", type: "agentMessage", text: "当前进度" },
  ],
};
const THREAD: RestoredThread = {
  metadata: {
    cliVersion: "1.0.0",
    createdAt: 100,
    cwd: "/workspace/project",
    ephemeral: false,
    id: "thread",
    modelProvider: "openai",
    preview: "阅读位置测试",
    projectId: null,
    sessionId: "session",
    source: "appServer",
    status: { type: "active", activeFlags: [] },
    turns: [],
    updatedAt: 200,
  },
  modelSettings: { effort: "medium", model: "gpt-5", serviceTier: null },
  turns: [HISTORY, RUNNING],
};

const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTop === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  } else {
    Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
  }
});

function mockLayout() {
  const heights = new Map([["q1", 80], ["a1", 800], ["q2", 80], ["a2", 900]]);
  const positions = new WeakMap<HTMLElement, number>();
  const observers = new Set<() => void>();
  const rows = (element: HTMLElement) => Array.from(
    element.querySelectorAll<HTMLElement>("[data-reading-item-id]"),
  );
  const height = (row: HTMLElement) => heights.get(row.dataset.readingItemId!)!;
  const contentHeight = (element: HTMLElement) => rows(element)
    .reduce((total, row) => total + height(row), 0);
  const rect = (top: number, rectHeight: number) => ({
    x: 0, y: top, top, bottom: top + rectHeight, left: 0, right: 880,
    width: 880, height: rectHeight, toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches("[data-conversation-scroller]") ? 600 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    const column = this.querySelector<HTMLElement>("[data-running-turn-floor]");
    const reserve = column?.dataset.runningTurnFloor === "true" ? 0 : 32;
    return Math.max(contentHeight(this) + reserve, Number.parseFloat(column?.style.minHeight || "0"));
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this) ?? 0; },
    set(value: number) {
      positions.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches("[data-conversation-scroller]")) return rect(0, 600);
    const scroller = this.closest<HTMLElement>("[data-conversation-scroller]");
    if (scroller === null) return rect(0, 0);
    if (this.matches("[data-conversation-list]")) {
      return rect(-scroller.scrollTop, contentHeight(scroller));
    }
    const row = this.closest<HTMLElement>("[data-reading-item-id]");
    if (row === null) return rect(0, 0);
    const previous = rows(scroller);
    const top = previous.slice(0, previous.indexOf(row))
      .reduce((total, element) => total + height(element), 0) - scroller.scrollTop;
    return this.matches("[data-user-message]")
      ? rect(top + 24, height(row) - 24)
      : rect(top, height(row));
  });
  vi.stubGlobal("ResizeObserver", class {
    readonly notify: () => void;
    constructor(callback: () => void) { this.notify = callback; }
    observe() { observers.add(this.notify); }
    disconnect() { observers.delete(this.notify); }
  });
  return { heights, resize: () => act(() => observers.forEach((notify) => notify())) };
}

function view(thread: RestoredThread, readingState: ConversationReadingStateStore) {
  return (
    <StrictMode>
      <style>{"[data-conversation-scroller] { padding-bottom: 0px; }"}</style>
      <ConversationView restoredThread={thread} readingState={readingState} />
    </StrictMode>
  );
}

function scrollToHistory() {
  const scroller = screen.getByLabelText("会话消息");
  fireEvent.wheel(scroller, { deltaY: -100 });
  scroller.scrollTop = 280;
  fireEvent.scroll(scroller);
  return scroller;
}

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}

describe("标签阅读位置恢复", () => {
  it.each(["流式增长", "后台完成"])("手动阅读后%s，恢复消息锚点并提示新内容", async (change) => {
    const layout = mockLayout();
    const state: ConversationReadingStateStore = { current: null };
    const first = render(view(THREAD, state));
    await nextFrame();
    scrollToHistory();
    first.unmount();
    expect(state.current?.following).toBe(false);
    expect(state.current?.anchor).toEqual({ turnId: "history", itemId: "a1", offset: -200 });

    // 前面的消息变高后，同一个阅读锚点应随之移动，而不是恢复旧 scrollTop
    layout.heights.set("q1", 180);
    const latest: ThreadTurn = {
      ...RUNNING,
      status: change === "后台完成" ? "completed" : "inProgress",
      items: [RUNNING.items[0]!, { id: "a2", type: "agentMessage", text: "当前进度增加了" }],
    };
    const second = render(view({ ...THREAD, turns: [HISTORY, latest] }, state));
    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.scrollTop).toBe(380);
    expect(screen.getByRole("button", { name: "有新内容，回到底部" })).toBeVisible();
    await nextFrame();
    layout.resize();
    expect(scroller.scrollTop).toBe(380);

    // 提示未经确认，再次切走和回来也应保留
    second.unmount();
    render(view({ ...THREAD, turns: [HISTORY, latest] }, state));
    fireEvent.click(screen.getByRole("button", { name: "有新内容，回到底部" }));
    const returnedScroller = screen.getByLabelText("会话消息");
    expect(returnedScroller.scrollTop).toBe(returnedScroller.scrollHeight - 600);
    expect(screen.queryByText("有新内容")).not.toBeInTheDocument();
  });

  it("手动阅读期间只有耗时更新，不误报新内容", async () => {
    mockLayout();
    const state: ConversationReadingStateStore = { current: null };
    const first = render(view(THREAD, state));
    await nextFrame();
    scrollToHistory();
    first.unmount();
    render(view({ ...THREAD, turns: [HISTORY, { ...RUNNING, durationMs: 4_000 }] }, state));
    expect(screen.getByLabelText("会话消息").scrollTop).toBe(280);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
    expect(screen.queryByText("有新内容")).not.toBeInTheDocument();
  });

  it("原阅读位置位于展开的活动内部，切回已折叠活动时定位组标题", async () => {
    const layout = mockLayout();
    layout.heights.set("reasoning", 800);
    const active: ThreadTurn = {
      ...RUNNING,
      items: [RUNNING.items[0]!, { id: "reasoning", type: "reasoning", summary: ["任务分析"] }],
    };
    const state: ConversationReadingStateStore = { current: null };
    const first = render(view({ ...THREAD, turns: [HISTORY, active] }, state));
    await nextFrame();
    const scroller = screen.getByLabelText("会话消息");
    fireEvent.wheel(scroller, { deltaY: -100 });
    scroller.scrollTop = 1_160;
    fireEvent.scroll(scroller);
    first.unmount();
    expect(state.current?.anchor).toEqual({ turnId: "running", itemId: "reasoning", offset: -200 });

    layout.heights.set("reasoning", 72);
    render(view({
      ...THREAD,
      turns: [HISTORY, { ...active, status: "completed", items: [...active.items, RUNNING.items[1]!] }],
    }, state));
    expect(screen.getByLabelText("会话消息").scrollTop).toBe(960);
  });

  it("自动跟随后后台完成，定位本轮问题且布局更新不拉回底部", async () => {
    const layout = mockLayout();
    const state: ConversationReadingStateStore = { current: null };
    const first = render(view(THREAD, state));
    await nextFrame();
    first.unmount();
    expect(state.current?.following).toBe(true);
    expect(state.current?.runningTurnId).toBe("running");

    render(view({ ...THREAD, turns: [HISTORY, { ...RUNNING, status: "completed" }] }, state));
    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.scrollTop).toBe(880);
    await nextFrame();
    layout.resize();
    expect(scroller.scrollTop).toBe(880);
    expect(screen.getByRole("button", { name: "回到底部" })).toBeVisible();
  });

  it("切回仍运行的标签，定位最新进度并继续自动翻页", async () => {
    const layout = mockLayout();
    const state: ConversationReadingStateStore = { current: null };
    const first = render(view(THREAD, state));
    await nextFrame();
    first.unmount();
    layout.heights.set("a2", 1_500);
    render(view(THREAD, state));
    await nextFrame();
    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - 600);
    const previousTop = scroller.scrollTop;
    layout.heights.set("a2", 2_500);
    layout.resize();
    expect(scroller.scrollTop).toBeGreaterThan(previousTop);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - 600);
    expect(screen.queryByRole("button", { name: "回到底部" })).not.toBeInTheDocument();
  });

  it("首次打开已完成会话时按默认行为定位到底部", async () => {
    mockLayout();
    render(view({ ...THREAD, turns: [HISTORY, { ...RUNNING, status: "completed" }] }, { current: null }));
    await nextFrame();
    const scroller = screen.getByLabelText("会话消息");
    expect(scroller.scrollTop).toBe(scroller.scrollHeight - 600);
  });
});
