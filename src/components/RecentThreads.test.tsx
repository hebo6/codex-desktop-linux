import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { RecentThreads } from "./RecentThreads";

const OriginalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: OriginalResizeObserver,
  });
});

function threadRowName(title: string): RegExp {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}，`, "u");
}

function getThreadRow(title: string): HTMLButtonElement {
  return screen.getByRole("button", { name: threadRowName(title) });
}

function queryThreadRow(title: string): HTMLButtonElement | null {
  return screen.queryByRole("button", { name: threadRowName(title) });
}

const THREAD_ONE = {
  cliVersion: "1.0.0",
  createdAt: 100,
  cwd: "/workspace/alpha",
  ephemeral: false,
  id: "thread-1",
  modelProvider: "openai",
  name: "服务端标题",
  preview: "第一条输入",
  sessionId: "session-1",
  source: "appServer",
  status: { activeFlags: [], type: "active" },
  turns: [],
  updatedAt: 200,
} satisfies ThreadSummary;

const THREAD_TWO = {
  ...THREAD_ONE,
  cwd: "/workspace/beta",
  id: "thread-2",
  name: null,
  preview: "预览标题\n第二行",
  sessionId: "session-2",
  status: { activeFlags: ["waitingOnApproval"], type: "active" },
} satisfies ThreadSummary;

function renderThreads(
  overrides: Partial<ComponentProps<typeof RecentThreads>> = {},
) {
  const onOpenThread = vi.fn();
  const onOpenThreadInNewTab = vi.fn();
  const onLoadMore = vi.fn();
  const onLoadProjectThreads = vi.fn(async () => ({ hasMore: false }));
  const onNewTaskInProject = vi.fn();
  const onArchiveThread = vi.fn();
  const onDeleteThread = vi.fn();
  const onUndoArchive = vi.fn();
  const props: ComponentProps<typeof RecentThreads> = {
    archivedThread: null,
    currentThreadId: THREAD_ONE.id,
    draftThreadIds: new Set(),
    error: null,
    grouped: false,
    hasMore: false,
    loadingMore: false,
    onArchiveThread,
    onDeleteThread,
    onLoadMore,
    onLoadProjectThreads,
    onNewTaskInProject,
    onOpenThread,
    onOpenThreadInNewTab,
    onUndoArchive,
    pendingThreadIds: [],
    removingThreadIds: [],
    phase: "ready",
    threads: [THREAD_ONE, THREAD_TWO],
    ...overrides,
  };
  const rendered = render(<RecentThreads {...props} />);
  return {
    onArchiveThread,
    onDeleteThread,
    onLoadMore,
    onLoadProjectThreads,
    onNewTaskInProject,
    onOpenThread,
    onOpenThreadInNewTab,
    onUndoArchive,
    rerenderThreads(next: Partial<ComponentProps<typeof RecentThreads>>) {
      rendered.rerender(<RecentThreads {...props} {...next} />);
    },
  };
}

describe("RecentThreads", () => {
  it("重新加载期间保留已显示的会话列表", () => {
    renderThreads({ phase: "loading" });

    expect(screen.getByRole("list", { name: "最近会话" })).toBeVisible();
    expect(getThreadRow("服务端标题")).toBeVisible();
    expect(screen.queryByRole("status", { name: "正在加载最近会话" }))
      .not.toBeInTheDocument();
  });

  it("独立展示线程状态、activeFlag、项目和标题回退", () => {
    renderThreads();

    expect(getThreadRow("服务端标题")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(getThreadRow("预览标题")).not.toHaveAttribute(
      "aria-current",
    );
    expect(
      getThreadRow("服务端标题").querySelector('[data-thread-status="active"]'),
    ).toHaveTextContent("运行中");
    expect(
      getThreadRow("预览标题").querySelector('[data-thread-status="active"]'),
    ).toHaveTextContent("运行中");
    expect(screen.getByRole("img", { name: "等待审批" })).toBeVisible();
    expect(screen.getByText("alpha")).toHaveAttribute("title", THREAD_ONE.cwd);
  });

  it("同时展示多个 activeFlag 且不覆盖线程状态", () => {
    const thread = {
      ...THREAD_ONE,
      status: {
        activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
        type: "active",
      },
    } satisfies ThreadSummary;
    renderThreads({ threads: [thread] });

    expect(
      getThreadRow("服务端标题").querySelector('[data-thread-status="active"]'),
    ).toHaveTextContent("运行中");
    expect(screen.getByRole("img", { name: "等待审批" })).toHaveTextContent("待审批");
    expect(screen.getByRole("img", { name: "等待输入" })).toHaveTextContent("待回复");
  });

  it("在固定槽位展示可与运行状态并存的草稿标识", () => {
    renderThreads({ draftThreadIds: new Set([THREAD_ONE.id]) });

    const draft = screen.getByRole("img", { name: "存在未发送草稿" });
    expect(draft).toHaveAttribute("title", "存在未发送草稿");
    expect(draft).toHaveAttribute("data-present", "true");
    expect(draft.closest("button")?.querySelector("[data-thread-status]"))
      .toHaveTextContent("运行中");
    expect(document.querySelectorAll("[data-present]")).toHaveLength(1);
    expect(getThreadRow("预览标题"))
      .toHaveAttribute("data-has-draft", "false");
  });

  it("显示空闲与失败，隐藏 notLoaded，并独立显示待回复", () => {
    const idleThread = {
      ...THREAD_ONE,
      status: { type: "idle" },
    } satisfies ThreadSummary;
    const inputThread = {
      ...THREAD_TWO,
      status: { activeFlags: ["waitingOnUserInput"], type: "active" },
    } satisfies ThreadSummary;
    const failedThread = {
      ...THREAD_ONE,
      id: "thread-failed",
      name: "失败会话",
      sessionId: "session-failed",
      status: { type: "systemError" },
    } satisfies ThreadSummary;
    const notLoadedThread = {
      ...THREAD_ONE,
      id: "thread-not-loaded",
      name: "未加载会话",
      sessionId: "session-not-loaded",
      status: { type: "notLoaded" },
    } satisfies ThreadSummary;

    renderThreads({
      threads: [idleThread, inputThread, failedThread, notLoadedThread],
    });

    expect(
      getThreadRow("服务端标题").querySelector('[data-thread-status="idle"]'),
    ).toHaveTextContent("空闲");
    expect(
      getThreadRow("预览标题").querySelector('[data-thread-status="active"]'),
    ).toHaveTextContent("运行中");
    const activeMetadata = getThreadRow("预览标题")
      .querySelector("time")?.parentElement;
    expect(activeMetadata?.children[0]).toHaveAttribute(
      "data-thread-status",
      "active",
    );
    expect(activeMetadata?.children[1]).toHaveAttribute("title", THREAD_TWO.cwd);
    expect(screen.getByRole("img", { name: "等待输入" })).toHaveTextContent("待回复");
    expect(
      getThreadRow("失败会话").querySelector('[data-thread-status="systemError"]'),
    ).toHaveTextContent("失败");
    const notLoadedMetadata = getThreadRow("未加载会话")
      .querySelector("time")?.parentElement;
    expect(notLoadedMetadata?.querySelector("[data-thread-status]")).toBeNull();
    expect(notLoadedMetadata?.firstElementChild).toHaveAttribute(
      "title",
      THREAD_ONE.cwd,
    );
  });

  it("在空闲和状态同步中的会话展示待查看完成结果", () => {
    const idleThread = {
      ...THREAD_ONE,
      status: { type: "idle" },
    } satisfies ThreadSummary;
    renderThreads({
      pendingResultThreadIds: new Set([THREAD_ONE.id]),
      threads: [idleThread],
    });

    expect(
      screen.getByRole("img", { name: "任务已完成，等待查看" }),
    ).toHaveAttribute("data-status", "resultReady");
    expect(
      getThreadRow("服务端标题").querySelector('[data-thread-status="idle"]'),
    ).toHaveTextContent("空闲");
  });

  it("以易读相对时间展示最近更新时间并定时刷新", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00-07:00"));
    const thread = {
      ...THREAD_ONE,
      updatedAt: Date.now() / 1_000 - 5 * 60 - 30,
    } satisfies ThreadSummary;
    renderThreads({ threads: [thread] });

    expect(screen.getByText("5 分钟前")).toBeVisible();
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("6 分钟前")).toBeVisible();
  });

  it("支持点击和方向键移动会话焦点", () => {
    const { onOpenThread } = renderThreads();
    const first = getThreadRow("服务端标题");
    const second = getThreadRow("预览标题");

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(onOpenThread).toHaveBeenCalledWith(THREAD_TWO.id);
  });

  it("支持中键和键盘上下文菜单在新标签打开会话", () => {
    const { onOpenThreadInNewTab } = renderThreads();
    const first = getThreadRow("服务端标题");
    const second = getThreadRow("预览标题");

    fireEvent(
      first,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onOpenThreadInNewTab).toHaveBeenCalledWith(THREAD_ONE.id);

    second.focus();
    fireEvent.keyDown(second, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "会话“预览标题”操作" });
    expect(menu).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "在新标签打开" }));
    expect(onOpenThreadInNewTab).toHaveBeenLastCalledWith(THREAD_TWO.id);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("支持右键打开并以 Esc 关闭会话上下文菜单", () => {
    renderThreads();
    const first = getThreadRow("服务端标题");

    fireEvent.contextMenu(first, { clientX: 80, clientY: 120 });
    expect(screen.getByRole("menuitem", { name: "在新标签打开" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("按工作目录分组并提供全局分页操作", () => {
    const { onLoadMore } = renderThreads({ grouped: true, hasMore: true });

    expect(screen.getByRole("button", { name: "alpha" })).toHaveAttribute(
      "title",
      THREAD_ONE.cwd,
    );
    expect(screen.getByRole("heading", { name: "beta" })).toBeVisible();
    const alphaGroup = screen.getByRole("button", { name: "alpha" });
    expect(alphaGroup).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(alphaGroup);
    expect(alphaGroup).toHaveAttribute("aria-expanded", "false");
    expect(queryThreadRow("服务端标题")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早会话" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("从项目组新建会话且不改变展开状态", () => {
    const otherThread = {
      ...THREAD_ONE,
      cwd: "",
      id: "thread-other",
      name: "其他会话",
      sessionId: "session-other",
    } satisfies ThreadSummary;
    const { onNewTaskInProject } = renderThreads({
      grouped: true,
      threads: [THREAD_ONE, otherThread],
    });
    const group = screen.getByRole("button", { name: "alpha" });
    const newTask = screen.getByRole("button", {
      name: `在 ${THREAD_ONE.cwd} 中新建会话`,
    });

    expect(newTask).toHaveAttribute("title", "在此项目中新建会话");
    expect(group).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(newTask);
    expect(onNewTaskInProject).toHaveBeenCalledWith(THREAD_ONE.cwd);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "其他会话" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "在  中新建会话" }),
    ).not.toBeInTheDocument();
  });

  it("每个项目初始显示三个会话并独立加载更多", () => {
    const threads = Array.from({ length: 7 }, (_, index) => ({
      ...THREAD_ONE,
      id: `thread-${index + 1}`,
      name: `会话 ${index + 1}`,
      sessionId: `session-${index + 1}`,
      status: { type: "idle" } as const,
      updatedAt: 300 - index,
    }));
    renderThreads({ currentThreadId: null, grouped: true, threads });

    expect(getThreadRow("会话 3")).toBeVisible();
    expect(queryThreadRow("会话 4")).not.toBeInTheDocument();
    const loadMore = screen.getByRole("button", {
      name: "加载“alpha”的更多会话",
    });
    fireEvent.click(loadMore);
    expect(getThreadRow("会话 6")).toBeVisible();
    expect(queryThreadRow("会话 7")).not.toBeInTheDocument();

    const group = screen.getByRole("button", { name: "alpha" });
    fireEvent.click(group);
    fireEvent.click(group);
    expect(getThreadRow("会话 6")).toBeVisible();

    fireEvent.click(screen.getByRole("button", {
      name: "加载“alpha”的更多会话",
    }));
    expect(getThreadRow("会话 7")).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "加载“alpha”的更多会话",
    })).not.toBeInTheDocument();
  });

  it("自动显示项目内排序靠后的当前会话", () => {
    const threads = Array.from({ length: 7 }, (_, index) => ({
      ...THREAD_ONE,
      id: `thread-${index + 1}`,
      name: `会话 ${index + 1}`,
      sessionId: `session-${index + 1}`,
      status: { type: "idle" } as const,
      updatedAt: 300 - index,
    }));

    renderThreads({
      currentThreadId: "thread-7",
      grouped: true,
      threads,
    });

    expect(getThreadRow("会话 7")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("移除会话后从项目内未显示会话自动补足", () => {
    const threads = Array.from({ length: 5 }, (_, index) => ({
      ...THREAD_ONE,
      id: `thread-${index + 1}`,
      name: `会话 ${index + 1}`,
      sessionId: `session-${index + 1}`,
      status: { type: "idle" } as const,
      updatedAt: 300 - index,
    }));
    const { rerenderThreads } = renderThreads({
      currentThreadId: null,
      grouped: true,
      threads,
    });
    expect(queryThreadRow("会话 4")).not.toBeInTheDocument();

    rerenderThreads({ threads: threads.slice(1) });

    expect(getThreadRow("会话 4")).toBeVisible();
    expect(queryThreadRow("会话 5")).not.toBeInTheDocument();
  });

  it("在项目组内展示加载失败并允许重试", async () => {
    const onLoadProjectThreads = vi.fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce({ hasMore: false });
    const threads = Array.from({ length: 3 }, (_, index) => ({
      ...THREAD_ONE,
      id: `thread-${index + 1}`,
      name: `会话 ${index + 1}`,
      sessionId: `session-${index + 1}`,
      status: { type: "idle" } as const,
      updatedAt: 300 - index,
    }));
    renderThreads({
      currentThreadId: null,
      grouped: true,
      hasMore: true,
      onLoadProjectThreads,
      threads,
    });

    fireEvent.click(screen.getByRole("button", {
      name: "加载“alpha”的更多会话",
    }));
    const retry = await screen.findByRole("button", {
      name: "重试加载“alpha”的更多会话",
    });
    expect(retry).toHaveTextContent("加载失败，点击重试");
    fireEvent.click(retry);

    await waitFor(() => expect(onLoadProjectThreads).toHaveBeenCalledTimes(2));
    expect(onLoadProjectThreads).toHaveBeenNthCalledWith(
      1,
      THREAD_ONE.cwd,
      6,
    );
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "重试加载“alpha”的更多会话",
    })).not.toBeInTheDocument());
  });

  it("滚动时不粘性置顶项目名称", () => {
    renderThreads({ grouped: true });
    const scroller = screen.getByRole("list", { name: "最近会话" });

    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    expect(scroller.querySelector("[data-sticky-group-heading]")).toBeNull();
  });

  it("标记服务端已确认移除的会话行", () => {
    renderThreads({ removingThreadIds: [THREAD_ONE.id] });

    expect(
      getThreadRow("服务端标题").closest("[data-removing]"),
    ).toHaveAttribute("data-removing", "true");
  });

  it("提供归档、删除和撤销操作且进行中禁用整行", () => {
    const { onArchiveThread, onDeleteThread, onUndoArchive } = renderThreads({
      archivedThread: THREAD_TWO,
      pendingThreadIds: [THREAD_TWO.id],
    });

    fireEvent.click(screen.getByRole("button", { name: `归档“${THREAD_ONE.name}”` }));
    expect(onArchiveThread).toHaveBeenCalledWith(THREAD_ONE.id);

    const firstRow = getThreadRow("服务端标题");
    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: "Delete" });
    expect(onDeleteThread).toHaveBeenCalledWith(THREAD_ONE.id);

    expect(getThreadRow("预览标题")).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(onUndoArchive).not.toHaveBeenCalled();
  });

  it("离线只读时仍可打开会话但禁用服务端修改", () => {
    const { onArchiveThread, onOpenThread } = renderThreads({ readOnly: true });
    const row = getThreadRow("服务端标题");
    fireEvent.click(row);
    expect(onOpenThread).toHaveBeenCalledWith(THREAD_ONE.id);
    expect(screen.getByRole("button", { name: `归档“${THREAD_ONE.name}”` })).toBeDisabled();
    expect(onArchiveThread).not.toHaveBeenCalled();
  });

  it("千条会话只挂载视口和过扫描行", () => {
    class FakeResizeObserver {
      constructor(_callback: ResizeObserverCallback) {}
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    const threads = Array.from({ length: 1_000 }, (_, index) => ({
      ...THREAD_ONE,
      cwd: `/workspace/project-${Math.floor(index / 3)}`,
      id: `thread-${index}`,
      name: `会话 ${index}`,
      sessionId: `session-${index}`,
    }));
    renderThreads({ currentThreadId: null, grouped: true, threads });
    const scroller = screen.getByRole("list", { name: "最近会话" });

    expect(screen.getAllByRole("listitem").length).toBeLessThan(100);
    scroller.scrollTop = 5_000;
    fireEvent.scroll(scroller);
    expect(screen.getAllByRole("listitem").length).toBeLessThan(100);
  });
});
