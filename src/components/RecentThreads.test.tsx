import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { RecentThreads } from "./RecentThreads";

const OriginalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: OriginalResizeObserver,
  });
});

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
  const onOpenThreadInNewWindow = vi.fn();
  const onLoadMore = vi.fn();
  const onLoadProjectThreads = vi.fn(async () => ({ hasMore: false }));
  const onArchiveThread = vi.fn();
  const onDeleteThread = vi.fn();
  const onUndoArchive = vi.fn();
  const props: ComponentProps<typeof RecentThreads> = {
    archivedThread: null,
    currentThreadId: THREAD_ONE.id,
    error: null,
    grouped: false,
    hasMore: false,
    loadingMore: false,
    onArchiveThread,
    onDeleteThread,
    onLoadMore,
    onLoadProjectThreads,
    onOpenThread,
    onOpenThreadInNewWindow,
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
    onOpenThread,
    onOpenThreadInNewWindow,
    onUndoArchive,
    rerenderThreads(next: Partial<ComponentProps<typeof RecentThreads>>) {
      rendered.rerender(<RecentThreads {...props} {...next} />);
    },
  };
}

describe("RecentThreads", () => {
  it("展示当前会话、服务端状态和标题回退", () => {
    renderThreads();

    expect(screen.getByRole("button", { name: "服务端标题 正在运行" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "预览标题 等待审批" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("img", { name: "正在运行" })).toBeVisible();
    expect(screen.getByRole("img", { name: "等待审批" })).toBeVisible();
  });

  it("空闲会话不展示状态并区分待回复与失败", () => {
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

    renderThreads({ threads: [idleThread, inputThread, failedThread] });

    expect(
      screen.getByRole("button", { name: "服务端标题" }).querySelector("[data-status]"),
    ).toBeNull();
    expect(screen.getByRole("img", { name: "等待输入" })).toHaveTextContent("待回复");
    expect(screen.getByRole("img", { name: "会话失败" })).toHaveTextContent("失败");
  });

  it("支持点击和方向键移动会话焦点", () => {
    const { onOpenThread } = renderThreads();
    const first = screen.getByRole("button", { name: "服务端标题 正在运行" });
    const second = screen.getByRole("button", { name: "预览标题 等待审批" });

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(onOpenThread).toHaveBeenCalledWith(THREAD_TWO.id);
  });

  it("支持中键和键盘上下文菜单在新窗口打开会话", () => {
    const { onOpenThreadInNewWindow } = renderThreads();
    const first = screen.getByRole("button", { name: "服务端标题 正在运行" });
    const second = screen.getByRole("button", { name: "预览标题 等待审批" });

    fireEvent(
      first,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onOpenThreadInNewWindow).toHaveBeenCalledWith(THREAD_ONE.id);

    second.focus();
    fireEvent.keyDown(second, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "会话“预览标题”操作" });
    expect(menu).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "在新窗口打开" }));
    expect(onOpenThreadInNewWindow).toHaveBeenLastCalledWith(THREAD_TWO.id);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("支持右键打开并以 Esc 关闭会话上下文菜单", () => {
    renderThreads();
    const first = screen.getByRole("button", { name: "服务端标题 正在运行" });

    fireEvent.contextMenu(first, { clientX: 80, clientY: 120 });
    expect(screen.getByRole("menuitem", { name: "在新窗口打开" })).toHaveFocus();
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
    expect(
      screen.queryByRole("button", { name: "服务端标题 正在运行" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早会话" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
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

    expect(screen.getByRole("button", { name: "会话 3" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "会话 4" })).not.toBeInTheDocument();
    const loadMore = screen.getByRole("button", {
      name: "加载“alpha”的更多会话",
    });
    fireEvent.click(loadMore);
    expect(screen.getByRole("button", { name: "会话 6" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "会话 7" })).not.toBeInTheDocument();

    const group = screen.getByRole("button", { name: "alpha" });
    fireEvent.click(group);
    fireEvent.click(group);
    expect(screen.getByRole("button", { name: "会话 6" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", {
      name: "加载“alpha”的更多会话",
    }));
    expect(screen.getByRole("button", { name: "会话 7" })).toBeVisible();
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

    expect(screen.getByRole("button", { name: "会话 7" })).toHaveAttribute(
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
    expect(screen.queryByRole("button", { name: "会话 4" })).not.toBeInTheDocument();

    rerenderThreads({ threads: threads.slice(1) });

    expect(screen.getByRole("button", { name: "会话 4" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "会话 5" })).not.toBeInTheDocument();
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

  it("滚动时仅置顶已展开的当前分组并由下一分组顶替", () => {
    renderThreads({ grouped: true });
    const scroller = screen.getByRole("list", { name: "最近会话" });

    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    let stickyHeading = scroller.querySelector<HTMLElement>(
      "[data-sticky-group-heading]",
    );
    expect(stickyHeading).not.toBeNull();
    expect(within(stickyHeading!).getByRole("button", { name: "alpha" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(stickyHeading?.style.transform).toBe("translateY(0px)");

    scroller.scrollTop = 50;
    fireEvent.scroll(scroller);
    stickyHeading = scroller.querySelector<HTMLElement>(
      "[data-sticky-group-heading]",
    );
    expect(stickyHeading?.style.transform).toBe("translateY(-10px)");

    scroller.scrollTop = 73;
    fireEvent.scroll(scroller);
    stickyHeading = scroller.querySelector<HTMLElement>(
      "[data-sticky-group-heading]",
    );
    const stickyBeta = within(stickyHeading!).getByRole("button", { name: "beta" });
    fireEvent.click(stickyBeta);
    expect(scroller.querySelector("[data-sticky-group-heading]")).toBeNull();
    expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("标记服务端已确认移除的会话行", () => {
    renderThreads({ removingThreadIds: [THREAD_ONE.id] });

    expect(
      screen
        .getByRole("button", { name: "服务端标题 正在运行" })
        .closest("[data-removing]"),
    ).toHaveAttribute("data-removing", "true");
  });

  it("提供归档、删除和撤销操作且进行中禁用整行", () => {
    const { onArchiveThread, onDeleteThread, onUndoArchive } = renderThreads({
      archivedThread: THREAD_TWO,
      pendingThreadIds: [THREAD_TWO.id],
    });

    fireEvent.click(screen.getByRole("button", { name: `归档“${THREAD_ONE.name}”` }));
    expect(onArchiveThread).toHaveBeenCalledWith(THREAD_ONE.id);

    const firstRow = screen.getByRole("button", { name: "服务端标题 正在运行" });
    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: "Delete" });
    expect(onDeleteThread).toHaveBeenCalledWith(THREAD_ONE.id);

    expect(screen.getByRole("button", { name: "预览标题 等待审批" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    expect(onUndoArchive).not.toHaveBeenCalled();
  });

  it("离线只读时仍可打开会话但禁用服务端修改", () => {
    const { onArchiveThread, onOpenThread } = renderThreads({ readOnly: true });
    const row = screen.getByRole("button", { name: "服务端标题 正在运行" });
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
    expect(scroller.querySelector("[data-sticky-group-heading]")).not.toBeNull();
  });
});
