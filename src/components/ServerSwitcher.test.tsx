import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ServerId, ServerProfile } from "../configuration";
import {
  ServerSwitcher,
  type ServerConnectionPhase,
  type ServerConnectionView,
  type ServerSwitcherProps,
} from "./ServerSwitcher";

const LOCAL_ID = "f2eb0af3-9330-4f17-a96f-7c708aae1111" as ServerId;
const REMOTE_ID = "f2eb0af3-9330-4f17-a96f-7c708aae2222" as ServerId;

function localServer(): ServerProfile {
  return {
    serverId: LOCAL_ID,
    name: "本机开发",
    version: 1,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["app-server"],
      nonSensitiveEnvironment: {},
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function remoteServer(): ServerProfile {
  return {
    serverId: REMOTE_ID,
    name: "远程工作区",
    version: 1,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app-server",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 10_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 2,
    updatedAtMs: 2,
  };
}

function connectionView(
  phase: ServerConnectionPhase,
  errorSummary: string | null = null,
): ServerConnectionView {
  return { phase, errorSummary };
}

function createProps(
  overrides: Partial<ServerSwitcherProps> = {},
): ServerSwitcherProps {
  return {
    servers: [localServer(), remoteServer()],
    currentServerId: LOCAL_ID,
    highRiskServerIds: new Set(),
    serverConnectionViews: {
      [LOCAL_ID]: connectionView("ready"),
      [REMOTE_ID]: connectionView("disconnected"),
    },
    isLoading: false,
    configurationErrorSummary: null,
    configurationWarningSummary: null,
    onReloadConfiguration: vi.fn(),
    onConnect: vi.fn(() => "started" as const),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onOpenInNewWindow: vi.fn(),
    ...overrides,
  };
}

describe("ServerSwitcher", () => {
  it("在触发器和服务器行展示当前状态与连接摘要", () => {
    render(<ServerSwitcher {...createProps()} />);

    const trigger = screen.getByRole("button", {
      name: "本机开发，已连接，打开服务器选择器",
    });
    expect(trigger.querySelector("[data-connection-indicator]")).toBeNull();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "服务器" });
    expect(within(dialog).getByText("/usr/bin/codex app-server")).toBeVisible();
    expect(
      within(dialog).getByText("wss://codex.example.test/app-server"),
    ).toBeVisible();
    expect(within(dialog).getByText("本机 stdio")).toBeInTheDocument();
    expect(within(dialog).getByText("远程 WebSocket")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "已连接 本机开发" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "连接 远程工作区" }),
    ).toBeEnabled();
  });

  it("展示非当前连接、重连状态及每行安全错误摘要", () => {
    const onOpenDiagnostics = vi.fn();
    const baseProps = createProps({
      onOpenDiagnostics,
      serverConnectionViews: {
        [LOCAL_ID]: connectionView("ready"),
        [REMOTE_ID]: connectionView("ready"),
      },
    });
    const { rerender } = render(<ServerSwitcher {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    const remoteRow = screen.getByText("远程工作区").closest("li");
    expect(remoteRow).not.toBeNull();
    expect(within(remoteRow!).getByText("已连接")).toBeVisible();
    expect(
      within(remoteRow!).getByRole("button", { name: "切换 远程工作区" }),
    ).toBeEnabled();

    rerender(
      <ServerSwitcher
        {...baseProps}
        serverConnectionViews={{
          [LOCAL_ID]: connectionView("ready"),
          [REMOTE_ID]: connectionView("error", "代理认证失败"),
        }}
      />,
    );
    expect(screen.getByText("代理认证失败")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "查看 远程工作区 诊断" }),
    );
    expect(onOpenDiagnostics).toHaveBeenCalledWith(REMOTE_ID);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("在选择器和每次连接状态中持续显示高风险 TLS", () => {
    render(
      <ServerSwitcher
        {...createProps({
          currentServerId: REMOTE_ID,
          highRiskServerIds: new Set([REMOTE_ID]),
          serverConnectionViews: {
            [LOCAL_ID]: connectionView("disconnected"),
            [REMOTE_ID]: connectionView("connecting"),
          },
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "远程工作区，高风险 TLS · 连接中，打开服务器选择器",
      }),
    );
    expect(screen.getByText("高风险 TLS：允许无效证书")).toBeVisible();
  });

  it("调用连接和新窗口直接操作", () => {
    const onConnect = vi.fn(() => "started" as const);
    const onOpenInNewWindow = vi.fn();
    render(
      <ServerSwitcher {...createProps({ onConnect, onOpenInNewWindow })} />,
    );

    const trigger = screen.getByRole("button", {
      name: /打开服务器选择器/,
    });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    expect(onConnect).toHaveBeenCalledWith(REMOTE_ID);

    fireEvent.click(
      screen.getByRole("button", { name: "在新窗口打开 远程工作区" }),
    );
    expect(onOpenInNewWindow).toHaveBeenCalledWith(REMOTE_ID);
  });

  it("已连接的服务器不渲染新窗口直接操作按钮", () => {
    const onOpenInNewWindow = vi.fn();
    render(
      <ServerSwitcher {...createProps({ onOpenInNewWindow })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    expect(
      screen.queryByRole("button", { name: "在新窗口打开 本机开发" }),
    ).not.toBeInTheDocument();
  });

  it("未提供新窗口操作时不渲染对应按钮", () => {
    const { onOpenInNewWindow: _unused, ...props } = createProps();
    render(<ServerSwitcher {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    expect(
      screen.queryByRole("button", { name: /在新窗口打开/ }),
    ).not.toBeInTheDocument();
  });

  it("未取得权威窗口计数时可以隐藏删除入口", () => {
    const { onDelete: _unused, ...props } = createProps();
    render(<ServerSwitcher {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    fireEvent.click(screen.getByRole("button", { name: "管理 本机开发" }));
    expect(
      screen.queryByRole("menuitem", { name: "删除服务器" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "编辑服务器" })).toBeVisible();
  });

  it("通过可访问管理菜单调用编辑和删除回调", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    render(<ServerSwitcher {...createProps({ onDelete, onEdit })} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    const menuButton = screen.getByRole("button", {
      name: "管理 远程工作区",
    });
    expect(menuButton).toHaveAttribute("title", "管理 远程工作区");
    fireEvent.keyDown(menuButton, { key: "ArrowDown" });

    const editItem = screen.getByRole("menuitem", { name: "编辑服务器" });
    const deleteItem = screen.getByRole("menuitem", { name: "删除服务器" });
    expect(getComputedStyle(screen.getByRole("menu")).position).toBe("static");
    expect(deleteItem.className).toContain("dangerMenuItem");
    expect(editItem).toHaveFocus();
    fireEvent.keyDown(editItem, { key: "ArrowDown" });
    expect(deleteItem).toHaveFocus();
    fireEvent.keyDown(deleteItem, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "服务器" })).toBeVisible();

    fireEvent.keyDown(menuButton, { key: "ArrowDown" });
    await user.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /关闭服务器选择器/ }),
    ).toHaveFocus();

    fireEvent.keyDown(menuButton, { key: "ArrowUp" });
    await user.tab({ shift: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();

    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑服务器" }));
    expect(onEdit).toHaveBeenCalledWith(REMOTE_ID);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    fireEvent.click(screen.getByRole("button", { name: "管理 本机开发" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除服务器" }));
    expect(onDelete).toHaveBeenCalledWith(LOCAL_ID);
  });

  it("打开外部操作前将焦点交还给选择器触发器", () => {
    let focusDuringEdit: Element | null = null;
    const onEdit = vi.fn(() => {
      focusDuringEdit = document.activeElement;
    });
    render(<ServerSwitcher {...createProps({ onEdit })} />);

    const trigger = screen.getByRole("button", {
      name: /打开服务器选择器/,
    });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "管理 远程工作区" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑服务器" }));

    expect(focusDuringEdit).toBe(trigger);
    expect(
      screen.queryByRole("dialog", { name: "服务器" }),
    ).not.toBeInTheDocument();
  });

  it("启动被取消时清除处理中状态且保持选择器打开", async () => {
    let finishRequest!: (result: "started" | "cancelled") => void;
    const requestResult = new Promise<"started" | "cancelled">((resolve) => {
      finishRequest = resolve;
    });
    const onConnect = vi.fn(() => requestResult);
    render(<ServerSwitcher {...createProps({ onConnect })} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    fireEvent.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    expect(
      screen.getByRole("button", { name: "处理中 远程工作区" }),
    ).toBeDisabled();

    await act(async () => finishRequest("cancelled"));
    expect(
      screen.getByRole("button", { name: "连接 远程工作区" }),
    ).toBeEnabled();
    expect(screen.getByRole("dialog", { name: "服务器" })).toBeVisible();
  });

  it("切换到已连接的非当前服务器后才关闭选择器", async () => {
    const onConnect = vi.fn(() => Promise.resolve("started" as const));
    const baseProps = createProps({
      onConnect,
      serverConnectionViews: {
        [LOCAL_ID]: connectionView("ready"),
        [REMOTE_ID]: connectionView("ready"),
      },
    });
    const { rerender } = render(<ServerSwitcher {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    fireEvent.click(screen.getByRole("button", { name: "切换 远程工作区" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "切换 远程工作区" }),
      ).toBeEnabled(),
    );
    expect(screen.getByRole("dialog", { name: "服务器" })).toBeVisible();

    rerender(<ServerSwitcher {...baseProps} currentServerId={REMOTE_ID} />);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("异步启动确认前记录状态往返且不被迟到就绪误关闭", async () => {
    let confirmStart!: (result: "started") => void;
    const onConnect = vi.fn(
      () =>
        new Promise<"started">((resolve) => {
          confirmStart = resolve;
        }),
    );
    const initialProps = createProps({
      currentServerId: REMOTE_ID,
      onConnect,
      serverConnectionViews: {
        [LOCAL_ID]: connectionView("disconnected"),
        [REMOTE_ID]: connectionView("error", "首次失败"),
      },
    });
    const { rerender } = render(<ServerSwitcher {...initialProps} />);

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    fireEvent.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    rerender(
      <ServerSwitcher
        {...initialProps}
        serverConnectionViews={{
          [LOCAL_ID]: connectionView("disconnected"),
          [REMOTE_ID]: connectionView("connecting"),
        }}
      />,
    );
    rerender(<ServerSwitcher {...initialProps} />);
    await act(async () => confirmStart("started"));
    expect(screen.getByRole("dialog", { name: "服务器" })).toBeVisible();

    rerender(
      <ServerSwitcher
        {...initialProps}
        serverConnectionViews={{
          [LOCAL_ID]: connectionView("disconnected"),
          [REMOTE_ID]: connectionView("ready"),
        }}
      />,
    );
    expect(screen.getByRole("dialog", { name: "服务器" })).toBeVisible();
  });

  it("仅在已启动的目标服务器就绪后关闭，连接错误时保持打开", async () => {
    const onConnect = vi.fn(() => Promise.resolve("started" as const));
    const baseProps = createProps({ onConnect });
    const { rerender } = render(<ServerSwitcher {...baseProps} />);
    const trigger = screen.getByRole("button", {
      name: /打开服务器选择器/,
    });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(REMOTE_ID));
    rerender(
      <ServerSwitcher
        {...baseProps}
        currentServerId={REMOTE_ID}
        serverConnectionViews={{
          [LOCAL_ID]: connectionView("ready"),
          [REMOTE_ID]: connectionView("error", "无法建立服务器连接"),
        }}
      />,
    );
    expect(screen.getByRole("dialog", { name: "服务器" })).toBeVisible();
    expect(screen.getByText("无法建立服务器连接")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
    rerender(
      <ServerSwitcher
        {...baseProps}
        currentServerId={REMOTE_ID}
        serverConnectionViews={{
          [LOCAL_ID]: connectionView("ready"),
          [REMOTE_ID]: connectionView("reconnecting"),
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "重连中 远程工作区" }),
    ).toBeDisabled();

    rerender(
      <ServerSwitcher
        {...baseProps}
        currentServerId={REMOTE_ID}
        serverConnectionViews={{
          [LOCAL_ID]: connectionView("ready"),
          [REMOTE_ID]: connectionView("ready"),
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("手动关闭后迟到的连接成功不抢回焦点", async () => {
    const user = userEvent.setup();
    const baseProps = createProps();
    const { rerender } = render(
      <div>
        <ServerSwitcher {...baseProps} />
        <button type="button">继续其他操作</button>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /打开服务器选择器/ }));
    await user.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    const otherAction = screen.getByRole("button", { name: "继续其他操作" });
    await user.click(otherAction);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(otherAction).toHaveFocus();

    rerender(
      <div>
        <ServerSwitcher
          {...baseProps}
          currentServerId={REMOTE_ID}
          serverConnectionViews={{
            [LOCAL_ID]: connectionView("ready"),
            [REMOTE_ID]: connectionView("ready"),
          }}
        />
        <button type="button">继续其他操作</button>
      </div>,
    );
    expect(screen.getByRole("button", { name: "继续其他操作" })).toHaveFocus();
  });

  it("Esc 关闭恢复触发器焦点，外部点击保留点击目标焦点", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <ServerSwitcher {...createProps()} />
        <button type="button">外部操作</button>
      </div>,
    );

    const trigger = screen.getByRole("button", {
      name: /打开服务器选择器/,
    });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "新建服务器" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const outsideButton = screen.getByRole("button", { name: "外部操作" });
    await user.click(outsideButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(outsideButton).toHaveFocus();
  });

  it("区分加载错误与空列表并允许重新加载", () => {
    const onCreate = vi.fn();
    const onReloadConfiguration = vi.fn();
    const { rerender } = render(
      <ServerSwitcher
        {...createProps({
          servers: [],
          currentServerId: null,
          serverConnectionViews: {},
          isLoading: true,
          onCreate,
          onReloadConfiguration,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "选择服务器，加载中，打开服务器选择器",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在加载服务器");

    rerender(
      <ServerSwitcher
        {...createProps({
          servers: [],
          currentServerId: null,
          serverConnectionViews: {},
          isLoading: false,
          configurationErrorSummary: "读取服务器列表失败",
          onCreate,
          onReloadConfiguration,
        })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("读取服务器列表失败");
    expect(
      screen.queryByRole("button", { name: "新建第一个服务器" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(onReloadConfiguration).toHaveBeenCalledTimes(1);

    rerender(
      <ServerSwitcher
        {...createProps({
          servers: [],
          currentServerId: null,
          serverConnectionViews: {},
          isLoading: false,
          configurationErrorSummary: null,
          onCreate,
          onReloadConfiguration,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新建第一个服务器" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("配置不是就绪状态时保留旧列表但锁定所有变更操作", () => {
    const onConnect = vi.fn(() => "started" as const);
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    render(
      <ServerSwitcher
        {...createProps({
          configurationErrorSummary: "配置刷新失败，当前显示上次快照",
          onConnect,
          onCreate,
          onEdit,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/u }));

    expect(screen.getByRole("button", { name: "新建服务器" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "连接 远程工作区" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "在新窗口打开 远程工作区" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "管理 远程工作区" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "连接 远程工作区" }));
    expect(onConnect).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("窗口引用同步警告不锁定服务器操作", () => {
    const onCreate = vi.fn();
    const onReloadConfiguration = vi.fn();
    render(
      <ServerSwitcher
        {...createProps({
          servers: [],
          currentServerId: null,
          serverConnectionViews: {},
          configurationWarningSummary: "无法同步其他窗口状态，请重试",
          onCreate,
          onReloadConfiguration,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /打开服务器选择器/u }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法同步其他窗口状态，请重试",
    );
    expect(screen.getByRole("button", { name: "新建服务器" })).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "新建第一个服务器" }),
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
