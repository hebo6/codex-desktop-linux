import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { ConnectionShell } from "./ConnectionShell";

describe("ConnectionShell", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("顶部栏使用深层窗口拖拽区域", () => {
    const { container } = render(<ConnectionShell phase="ready" />);
    const titlebar = container.querySelector(
      "header[data-tauri-drag-region]",
    );

    expect(titlebar).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(titlebar).toHaveAttribute("data-window-menu-region", "self");
    expect(titlebar?.querySelector("[data-window-menu-region='deep']"))
      .not.toBeNull();
  });

  it("以可访问状态展示初始化进度", () => {
    render(<ConnectionShell phase="initializing" />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("正在初始化 Codex");
    expect(status.textContent).toContain("初始化 app-server");
    expect(status.textContent).toContain("进行中");
    expect(screen.getByRole("button", { name: "新建任务" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("支持切换窄窗口侧栏并处理连接错误", () => {
    const onRetry = vi.fn();
    render(
      <ConnectionShell
        detail="连接被服务器拒绝"
        onRetry={onRetry}
        phase="error"
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("连接被服务器拒绝");

    const menuButton = screen.getByLabelText("打开侧栏");
    fireEvent.click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByLabelText("关闭侧栏")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "重试连接" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("展示自动重连倒计时并允许立即重试或停止", () => {
    const onRetry = vi.fn();
    const onStopReconnect = vi.fn();
    render(
      <ConnectionShell
        onRetry={onRetry}
        onStopReconnect={onStopReconnect}
        phase="error"
        reconnect={{ attempt: 2, nextAttemptAt: Date.now() + 5_000 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    fireEvent.click(screen.getByRole("button", { name: "停止重连" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onStopReconnect).toHaveBeenCalledOnce();
  });

  it("允许服务器控制器替换静态连接摘要", () => {
    render(
      <ConnectionShell
        phase="disconnected"
        serverControl={<button type="button">选择工作服务器</button>}
      />,
    );

    expect(
      screen.getByRole("button", { name: "选择工作服务器" }),
    ).toBeVisible();
    expect(screen.queryByText("当前连接")).not.toBeInTheDocument();
  });

  it("静态服务器栏在连接就绪时不展示状态圆点", () => {
    render(<ConnectionShell phase="ready" />);

    expect(
      screen.getByText("当前连接").parentElement?.parentElement
        ?.querySelector("[data-connection-indicator]"),
    ).toBeNull();
  });

  it("连接就绪后支持新建入口和项目分组切换", () => {
    const onNewTask = vi.fn();
    const onRefreshThreads = vi.fn();
    render(
      <ConnectionShell
        onNewTask={onNewTask}
        onRefreshThreads={onRefreshThreads}
        phase="ready"
        threadListPhase="ready"
      />,
    );

    const groupButton = screen.getByRole("button", { name: "按项目分组" });
    const actionsButton = screen.getByRole("button", { name: "最近会话操作" });
    expect(screen.getByRole("button", { name: "新建任务" })).toHaveAttribute(
      "title",
      "新建任务（Ctrl+N）",
    );
    expect(groupButton).toHaveAttribute("title", "按项目分组");
    expect(groupButton.compareDocumentPosition(actionsButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    fireEvent.click(groupButton);
    expect(
      screen.getByRole("button", { name: "取消按项目分组" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(actionsButton);
    expect(screen.getByRole("menuitemradio", { name: "最近会话" }))
      .toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "已归档会话" }))
      .toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新会话" }));
    fireEvent.click(screen.getByRole("button", { name: "最近会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /搜索会话/u }));
    expect(onRefreshThreads).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("complementary", { name: "会话侧栏" }))
      .getByRole("searchbox", { name: "搜索会话" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
    expect(onNewTask).toHaveBeenCalledOnce();
  });

  it("按需加载已归档会话并允许逐条恢复", () => {
    const onLoadArchivedThreads = vi.fn();
    const onUnarchiveThread = vi.fn();
    const archivedThread = {
      cliVersion: "1.0.0",
      createdAt: 100,
      cwd: "/workspace/archived",
      ephemeral: false,
      id: "thread-archived",
      modelProvider: "openai",
      name: "归档会话",
      preview: "已归档",
      projectId: null,
      sessionId: "session-archived",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 200,
    } satisfies ThreadSummary;
    const { rerender } = render(
      <ConnectionShell
        archivedThreadListPhase="idle"
        onLoadArchivedThreads={onLoadArchivedThreads}
        onUnarchiveThread={onUnarchiveThread}
        phase="ready"
        threadListPhase="ready"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "最近会话操作" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "已归档会话" }));
    expect(onLoadArchivedThreads).toHaveBeenCalledOnce();

    rerender(
      <ConnectionShell
        archivedThreadListPhase="ready"
        archivedThreads={[archivedThread]}
        onLoadArchivedThreads={onLoadArchivedThreads}
        onUnarchiveThread={onUnarchiveThread}
        phase="ready"
        threadListPhase="ready"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "已归档会话操作" }));
    expect(screen.getByRole("menuitemradio", { name: "已归档会话" }))
      .toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "已归档会话" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复“归档会话”" }));
    expect(onUnarchiveThread).toHaveBeenCalledWith(archivedThread.id);
  });

  it("Ctrl+K 切换会话搜索，关闭后清空查询，长按不重复切换", () => {
    render(<ConnectionShell phase="ready" mainContent={<textarea aria-label="任务输入" />} />);
    const sidebar = screen.getByRole("complementary", { name: "会话侧栏" });
    const shell = sidebar.closest("[data-sidebar-collapsed]");
    fireEvent.click(screen.getByRole("button", { name: "隐藏侧栏" }));
    const composer = screen.getByRole("textbox", { name: "任务输入" });
    composer.focus();
    fireEvent.keyDown(composer, { ctrlKey: true, key: "k" });
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");
    const input = within(sidebar).getByRole("searchbox", { name: "搜索会话" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "项目" } });
    fireEvent.keyDown(input, { ctrlKey: true, key: "k", repeat: true });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("项目");
    composer.focus();
    fireEvent.keyDown(composer, { ctrlKey: true, key: "k" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");
    const menuButton = screen.getByRole("button", { name: "最近会话操作" });
    expect(menuButton).toHaveFocus();
    fireEvent.keyDown(menuButton, { ctrlKey: true, key: "k", repeat: true });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.keyDown(menuButton, { ctrlKey: true, key: "k" });
    const reopenedInput = within(sidebar).getByRole("searchbox", { name: "搜索会话" });
    expect(reopenedInput).toHaveFocus();
    expect(reopenedInput).toHaveValue("");
    fireEvent.keyDown(reopenedInput, { ctrlKey: true, key: "k" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it("窄窗口展开侧栏搜索，Esc 恢复列表，打开结果后关闭侧栏", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const onOpenThread = vi.fn();
    render(<ConnectionShell phase="ready" onOpenThread={onOpenThread} threadListPhase="ready" threads={[threadSummary("项目", 1)]} />);
    const sidebar = screen.getByRole("complementary", { name: "会话侧栏" });
    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    expect(sidebar).toHaveAttribute("data-open", "true");
    const input = screen.getByRole("searchbox");
    expect(input).toHaveFocus();
    expect(screen.getByRole("list", { name: "最近会话" })).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sidebar).toHaveAttribute("data-open", "true");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "最近会话" })).toBeVisible();
    expect(screen.getByRole("button", { name: "最近会话操作" })).toHaveFocus();
    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    fireEvent.keyDown(screen.getByRole("searchbox"), { ctrlKey: true, key: "k" });
    expect(sidebar).toHaveAttribute("data-open", "true");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "最近会话" })).toBeVisible();
    expect(screen.getByRole("button", { name: "最近会话操作" })).toHaveFocus();
    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    fireEvent.click(screen.getByRole("button", { name: /^项目，/u }));
    expect(onOpenThread).toHaveBeenCalledWith("项目");
    expect(sidebar).toHaveAttribute("data-open", "false");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("模态对话框打开时 Ctrl+K 不抢焦点，Esc 不关闭侧栏", () => {
    render(<ConnectionShell phase="ready" mainContent={<div aria-modal="true" role="dialog"><input aria-label="对话框输入" /></div>} />);
    fireEvent.click(screen.getByLabelText("打开侧栏"));
    const input = screen.getByRole("textbox", { name: "对话框输入" });
    input.focus();
    fireEvent.keyDown(input, { ctrlKey: true, key: "k" });
    expect(input).toHaveFocus();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "会话侧栏" })).toHaveAttribute("data-open", "true");
  });

  it("搜索关闭后保留项目折叠状态，进入搜索时清理会话右键菜单", () => {
    render(<ConnectionShell phase="ready" threadListPhase="ready" threads={[threadSummary("项目", 1)]} onOpenThreadInNewTab={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /^项目，/u }));
    expect(screen.getByRole("menuitem", { name: "在新标签打开" })).toBeVisible();
    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭会话搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "按项目分组" }));
    const group = screen.getByRole("button", { name: "项目", expanded: true });
    fireEvent.click(group);
    fireEvent.keyDown(window, { ctrlKey: true, key: "k" });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "项目", expanded: false })).toBeVisible();
  });

  it("新建任务后关闭覆盖式侧栏", () => {
    const onNewTask = vi.fn();
    render(
      <ConnectionShell
        onNewTask={onNewTask}
        phase="ready"
        threadListPhase="ready"
      />,
    );

    const menuButton = screen.getByLabelText("打开侧栏");
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("button", { name: "新建任务" }));

    expect(onNewTask).toHaveBeenCalledOnce();
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
  });

  it("从项目组新建任务后关闭覆盖式侧栏", () => {
    const onNewTaskInProject = vi.fn();
    const thread = {
      cliVersion: "1.0.0",
      createdAt: 100,
      cwd: "/workspace/project",
      ephemeral: false,
      id: "thread-project",
      modelProvider: "openai",
      name: "项目会话",
      preview: "继续项目",
      projectId: null,
      sessionId: "session-project",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 200,
    } satisfies ThreadSummary;
    render(
      <ConnectionShell
        onNewTaskInProject={onNewTaskInProject}
        phase="ready"
        threadListPhase="ready"
        threads={[thread]}
      />,
    );

    const menuButton = screen.getByLabelText("打开侧栏");
    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("button", { name: "按项目分组" }));
    fireEvent.click(screen.getByRole("button", {
      name: `在 ${thread.cwd} 中新建会话`,
    }));

    expect(onNewTaskInProject).toHaveBeenCalledWith(thread.cwd);
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
  });

  it("支持键盘调整并提交侧栏宽度", () => {
    const onSidebarWidthChange = vi.fn();
    render(
      <ConnectionShell
        onSidebarWidthChange={onSidebarWidthChange}
        phase="ready"
        sidebarWidth={288}
      />,
    );

    const separator = screen.getByRole("separator", { name: "调整侧栏宽度" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "296");
    expect(onSidebarWidthChange).toHaveBeenCalledWith(296);
  });

  it("支持手动隐藏和显示桌面侧栏", () => {
    render(<ConnectionShell phase="ready" />);

    const hideButton = screen.getByRole("button", { name: "隐藏侧栏" });
    const shell = hideButton.closest("[data-sidebar-collapsed]");
    expect(hideButton).toHaveAttribute("aria-expanded", "true");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");

    fireEvent.click(hideButton);
    const showButton = screen.getByRole("button", { name: "显示侧栏" });
    expect(showButton).toHaveAttribute("aria-expanded", "false");
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "true");

    fireEvent.click(showButton);
    expect(screen.getByRole("button", { name: "隐藏侧栏" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(shell).toHaveAttribute("data-sidebar-collapsed", "false");

    fireEvent.keyDown(window, { ctrlKey: true, key: "b" });
    expect(screen.getByRole("button", { name: "显示侧栏" })).toBeVisible();
    fireEvent.keyDown(window, { ctrlKey: true, key: "b" });
    expect(screen.getByRole("button", { name: "隐藏侧栏" })).toBeVisible();
  });

  it("断线时保留当前进程主内容并提供只读提示", () => {
    render(
      <ConnectionShell
        mainContent={<div>已加载消息</div>}
        offline
        offlineSyncedAt={1_000}
        phase="error"
      />,
    );

    expect(screen.getByText("已加载消息")).toBeVisible();
    expect(screen.getByText(/连接已中断 · 当前内容只读/u)).toBeVisible();
  });

  it("重连对账期间区分同步状态并保持内容只读", () => {
    render(
      <ConnectionShell
        mainContent={<div>待对账消息</div>}
        offline
        onRetry={vi.fn()}
        phase="ready"
        threadListPhase="loading"
      />,
    );

    expect(screen.getByText("待对账消息")).toBeVisible();
    expect(screen.getByText("正在同步服务端内容 · 当前内容只读")).toBeVisible();
    expect(screen.queryByRole("button", { name: "立即重连" })).not.toBeInTheDocument();
  });
});

function threadSummary(id: string, updatedAt: number): ThreadSummary {
  return {
    cliVersion: "1.0.0",
    createdAt: updatedAt,
    cwd: `/workspace/${id}`,
    ephemeral: false,
    id,
    modelProvider: "openai",
    name: id,
    preview: id,
    projectId: null,
    sessionId: `session-${id}`,
    source: "appServer",
    status: { type: "idle" },
    turns: [],
    updatedAt,
  };
}
