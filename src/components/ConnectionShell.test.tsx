import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../app/useServerThreads";
import { ConnectionShell } from "./ConnectionShell";

describe("ConnectionShell", () => {
  it("顶部栏使用深层窗口拖拽区域", () => {
    const { container } = render(<ConnectionShell phase="ready" />);

    expect(
      container.querySelector("header[data-tauri-drag-region]"),
    ).toHaveAttribute("data-tauri-drag-region", "deep");
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

  it("连接就绪后支持新建快捷键和项目分组切换", () => {
    const onNewTask = vi.fn();
    const onRefreshThreads = vi.fn();
    const onSearchThreads = vi.fn();
    render(
      <ConnectionShell
        onNewTask={onNewTask}
        onRefreshThreads={onRefreshThreads}
        onSearchThreads={onSearchThreads}
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
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新会话" }));
    fireEvent.click(screen.getByRole("button", { name: "最近会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /搜索会话/u }));
    expect(onRefreshThreads).toHaveBeenCalledTimes(1);
    expect(onSearchThreads).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { ctrlKey: true, key: "n" });
    expect(onNewTask).toHaveBeenCalledTimes(1);
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
