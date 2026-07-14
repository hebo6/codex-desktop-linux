import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  ProxyId,
  ProxyProfile,
  ServerId,
  ServerProfile,
} from "../configuration";
import {
  ServerEditorDialog,
  type ServerEditorDialogProps,
} from "./ServerEditorDialog";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const PROXY_ID = "22222222-2222-4222-8222-222222222222" as ProxyId;

function proxyProfile(): ProxyProfile {
  return {
    proxyId: PROXY_ID,
    name: "办公代理",
    version: 1,
    configuration: {
      type: "socks5",
      host: "proxy.example.com",
      port: 1080,
      authentication: "none",
      dnsResolution: "proxy",
      connectTimeoutMs: 10000,
    },
    credentialConfigured: false,
    lastTest: { status: "succeeded", testedAtMs: 1_700_000_000_000 },
    referencedServerCount: 0,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}

function highRiskHttpProxyProfile(): ProxyProfile {
  return {
    proxyId: PROXY_ID,
    name: "开发 HTTPS 代理",
    version: 2,
    configuration: {
      type: "httpConnect",
      url: "https://proxy.example.com",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 10000,
      tlsCertificatePolicy: "allowInvalidCertificate",
    },
    credentialConfigured: false,
    referencedServerCount: 1,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_001,
  };
}

function remoteProfile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "远程 Codex",
    version: 3,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.com/app-server",
      authentication: "bearer",
      nonSensitiveHeaders: { "X-Client": "desktop" },
      connectTimeoutMs: 30000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
      proxyId: PROXY_ID,
    },
    credentialConfigured: true,
    activeWindowCount: 0,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function createProps(
  overrides: Partial<ServerEditorDialogProps> = {},
): ServerEditorDialogProps {
  return {
    open: true,
    editorSessionId: "editor-session-1",
    mode: { type: "create" },
    proxies: [],
    saving: false,
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
}

async function addArgument(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  await user.click(screen.getByRole("button", { name: "添加参数" }));
  const argumentsInputs = screen.getAllByLabelText(/^参数 \d+$/u);
  fireEvent.change(argumentsInputs.at(-1)!, { target: { value } });
}

async function addKeyValue(
  user: ReturnType<typeof userEvent.setup>,
  label: "普通环境变量" | "敏感环境变量" | "普通请求头",
  name: string,
  value: string,
) {
  await user.click(screen.getByRole("button", { name: `添加${label}` }));
  const names = screen.getAllByLabelText(
    new RegExp(`^${label}名称 \\d+$`, "u"),
  );
  const values = screen.getAllByLabelText(new RegExp(`^${label}值 \\d+$`, "u"));
  fireEvent.change(names.at(-1)!, { target: { value: name } });
  fireEvent.change(values.at(-1)!, { target: { value } });
}

describe("ServerEditorDialog", () => {
  it("以可访问模态打开、聚焦当前类型并支持 Esc 取消", () => {
    const onCancel = vi.fn();
    render(<ServerEditorDialog {...createProps({ onCancel })} />);

    expect(screen.getByRole("dialog", { name: "新建服务器" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByRole("radio", { name: /本机 stdio/u })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "关闭服务器编辑器" }),
    ).toHaveAttribute("title", "关闭服务器编辑器");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("动态删除当前焦点字段后仍将 Tab 限制在弹窗内", async () => {
    const user = userEvent.setup();
    render(<ServerEditorDialog {...createProps()} />);

    await user.click(screen.getByRole("button", { name: "添加参数" }));
    const remove = screen.getByRole("button", { name: "删除参数 1" });
    remove.focus();
    await user.click(remove);
    expect(document.body).toHaveFocus();

    fireEvent.keyDown(window, { key: "Tab" });
    expect(
      screen.getByRole("button", { name: "关闭服务器编辑器" }),
    ).toHaveFocus();
  });

  it("编辑远程服务器时聚焦已选择类型且不回填凭据", () => {
    render(
      <ServerEditorDialog
        {...createProps({
          mode: { type: "edit", profile: remoteProfile() },
          proxies: [proxyProfile()],
        })}
      />,
    );

    expect(
      screen.getByRole("radio", { name: /远程 WebSocket/u }),
    ).toHaveFocus();
    expect(screen.getByLabelText(/^Bearer 令牌/u)).toHaveValue("");
    expect(screen.getByLabelText(/^Bearer 令牌/u)).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByText(/已保存的 Bearer 令牌/u)).toBeInTheDocument();
  });

  it("归一化动态本机字段并把敏感环境变量作为 set 意图提交", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServerEditorDialog {...createProps({ onSubmit })} />);

    await user.type(screen.getByLabelText(/^名称/u), "  本机 Codex  ");
    await user.type(
      screen.getByLabelText(/^可执行文件路径/u),
      "/usr/bin/codex",
    );
    await addArgument(user, "app-server");
    await addArgument(user, "");
    await addArgument(user, "line one\nline two");
    await user.type(
      screen.getByLabelText(/^默认工作目录/u),
      "/home/user/project",
    );
    await addKeyValue(user, "普通环境变量", "CODEX_MODE", "desktop");
    await addKeyValue(user, "普通环境变量", "MULTILINE", "a\nb");
    await addKeyValue(
      user,
      "敏感环境变量",
      "API_TOKEN",
      "secret-value\nsecond-line",
    );

    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "本机 Codex",
      configuration: {
        type: "localStdio",
        executablePath: "/usr/bin/codex",
        arguments: ["app-server", "", "line one\nline two"],
        defaultWorkingDirectory: "/home/user/project",
        nonSensitiveEnvironment: {
          CODEX_MODE: "desktop",
          MULTILINE: "a\nb",
        },
      },
      credentialIntent: {
        type: "set",
        credential: {
          type: "sensitiveEnvironment",
          values: { API_TOKEN: "secret-value\nsecond-line" },
        },
      },
    });
  });

  it("切换连接类型时保留草稿并提交远程代理配置", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ServerEditorDialog
        {...createProps({ onSubmit, proxies: [proxyProfile()] })}
      />,
    );

    await user.type(screen.getByLabelText(/^名称/u), "远程 Codex");
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));
    await user.type(
      screen.getByLabelText(/^WebSocket URL/u),
      "wss://codex.example.com/app-server",
    );
    await user.selectOptions(screen.getByLabelText(/^认证方式/u), "bearer");
    await user.type(screen.getByLabelText(/^Bearer 令牌/u), "abc.def-123");
    await addKeyValue(user, "普通请求头", "X-Client", "desktop");
    await user.selectOptions(screen.getByLabelText(/^连接路径/u), PROXY_ID);

    await user.click(screen.getByRole("radio", { name: /本机 stdio/u }));
    await user.type(
      screen.getByLabelText(/^可执行文件路径/u),
      "/usr/bin/codex",
    );
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));

    expect(screen.getByLabelText(/^WebSocket URL/u)).toHaveValue(
      "wss://codex.example.com/app-server",
    );
    expect(screen.getByText("proxy.example.com:1080")).toBeInTheDocument();
    expect(screen.getByText("最近测试：成功")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "远程 Codex",
      configuration: {
        type: "remoteWebSocket",
        url: "wss://codex.example.com/app-server",
        authentication: "bearer",
        nonSensitiveHeaders: { "X-Client": "desktop" },
        connectTimeoutMs: 30000,
        tlsCertificatePolicy: "strict",
        plaintextConfirmed: false,
        proxyId: PROXY_ID,
      },
      credentialIntent: {
        type: "set",
        credential: { type: "bearerToken", value: "abc.def-123" },
      },
    });
  });

  it("编辑时留空保持且仅通过独立按钮清除凭据", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ServerEditorDialog
        {...createProps({
          mode: { type: "edit", profile: remoteProfile() },
          onSubmit,
          proxies: [proxyProfile()],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit.mock.calls[0]?.[0].credentialIntent).toEqual({
      type: "keep",
    });

    await user.click(screen.getByRole("button", { name: "清除已保存凭据" }));
    expect(screen.getByText(/保存时将清除/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit.mock.calls[1]?.[0].credentialIntent).toEqual({
      type: "clear",
      credentialType: "bearerToken",
    });
  });

  it("显示中文字段错误并聚焦无效输入", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServerEditorDialog {...createProps({ onSubmit })} />);

    await user.type(screen.getByLabelText(/^名称/u), "本机");
    await user.type(screen.getByLabelText(/^可执行文件路径/u), "usr/bin/codex");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const executable = screen.getByLabelText(/^可执行文件路径/u);
    const message = screen.getByText(/必须是以 \/ 开头的 Linux 绝对路径/u);
    expect(executable).toHaveAttribute("aria-invalid", "true");
    expect(executable.getAttribute("aria-describedby")).toContain(message.id);
    await waitFor(() => expect(executable).toHaveFocus());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("按 URL 解析结果要求确认未加密的 ws 连接", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ServerEditorDialog {...createProps({ onSubmit })} />);

    await user.type(screen.getByLabelText(/^名称/u), "内网 Codex");
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));
    fireEvent.change(screen.getByLabelText(/^WebSocket URL/u), {
      target: { value: "  ws://codex.internal/app-server" },
    });

    expect(
      screen.getByRole("checkbox", { name: /我了解 ws:\/\//u }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText(/必须确认连接不会加密/u)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("允许无效证书时显示显眼高风险状态", async () => {
    const user = userEvent.setup();
    render(<ServerEditorDialog {...createProps()} />);
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));
    await user.type(
      screen.getByLabelText(/^WebSocket URL/u),
      "wss://codex.example.com/app-server",
    );
    await user.selectOptions(
      screen.getByLabelText(/^TLS 证书策略/u),
      "allowInvalidCertificate",
    );

    expect(screen.getByRole("alert")).toHaveTextContent("高风险 TLS 配置");
    expect(screen.getByRole("alert")).toHaveTextContent("不校验目标服务器证书");
  });

  it("所选 HTTPS 代理允许无效证书时单独说明代理风险", () => {
    render(
      <ServerEditorDialog
        {...createProps({
          mode: { type: "edit", profile: remoteProfile() },
          proxies: [highRiskHttpProxyProfile()],
        })}
      />,
    );

    expect(screen.queryByText("高风险 TLS 配置")).not.toBeInTheDocument();
    expect(screen.getByText("高风险代理 TLS 配置")).toBeVisible();
    expect(screen.getByText(/连接代理时不会校验证书和主机名/u)).toBeVisible();
  });

  it("仅在提供回调时显示测试连接和新建代理入口", async () => {
    const user = userEvent.setup();
    const onTest = vi.fn();
    const onCancelTest = vi.fn();
    const onCreateProxy = vi.fn();
    const { rerender } = render(<ServerEditorDialog {...createProps()} />);

    expect(
      screen.queryByRole("button", { name: "测试连接" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /远程 WebSocket/u }));
    expect(
      screen.queryByRole("button", { name: "新建代理" }),
    ).not.toBeInTheDocument();

    rerender(<ServerEditorDialog {...createProps({ onTest })} />);
    expect(
      screen.queryByRole("button", { name: "测试连接" }),
    ).not.toBeInTheDocument();

    rerender(
      <ServerEditorDialog
        {...createProps({ onCancelTest, onCreateProxy, onTest })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "新建代理" }));
    expect(onCreateProxy).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("radio", { name: /本机 stdio/u }));
    await user.type(screen.getByLabelText(/^名称/u), "本机 Codex");
    await user.type(
      screen.getByLabelText(/^可执行文件路径/u),
      "/usr/bin/codex",
    );
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(onTest).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: expect.objectContaining({ type: "localStdio" }),
      }),
    );
  });

  it("测试期间锁定草稿且编辑后隐藏过期测试结果", async () => {
    const onTest = vi.fn();
    const onCancelTest = vi.fn();
    const { rerender } = render(
      <ServerEditorDialog
        {...createProps({
          onCancelTest,
          onTest,
          testState: { type: "succeeded", message: "当前配置可连接" },
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("当前配置可连接");
    fireEvent.change(screen.getByLabelText(/^名称/u), {
      target: { value: "已修改名称" },
    });
    expect(screen.queryByText("当前配置可连接")).not.toBeInTheDocument();

    rerender(
      <ServerEditorDialog
        {...createProps({
          onCancelTest,
          onTest,
          testState: { type: "testing" },
        })}
      />,
    );
    expect(screen.getByLabelText(/^名称/u)).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("正在测试连接"),
    );
    await userEvent.click(screen.getByRole("button", { name: "取消测试" }));
    expect(onCancelTest).toHaveBeenCalledTimes(1);

    rerender(
      <ServerEditorDialog
        {...createProps({
          onCancelTest,
          onTest,
          testState: { type: "cancelling" },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("正在取消测试连接"),
    );

    rerender(
      <ServerEditorDialog
        {...createProps({
          onCancelTest,
          onTest,
          testState: {
            type: "cancelFailed",
            message: "无法确认测试连接已关闭，请关闭当前窗口后重试",
          },
        })}
      />,
    );
    expect(screen.getByLabelText(/^名称/u)).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法确认测试连接已关闭",
    );
    expect(screen.getByRole("button", { name: "清理失败" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "关闭服务器编辑器" }),
    ).toBeDisabled();

    rerender(
      <ServerEditorDialog
        {...createProps({
          onCancelTest,
          onTest,
          testState: { type: "succeeded", message: "新草稿可连接" },
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("新草稿可连接"),
    );
  });

  it("测试期间允许通过关闭按钮、Esc、遮罩和底部取消退出", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onCancelTest = vi.fn();
    render(
      <ServerEditorDialog
        {...createProps({
          onCancel,
          onCancelTest,
          onTest: vi.fn(),
          testState: { type: "testing" },
        })}
      />,
    );

    const closeButton = screen.getByRole("button", {
      name: "关闭服务器编辑器",
    });
    expect(closeButton).toBeEnabled();
    await user.click(closeButton);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(onCancel).toHaveBeenCalledTimes(4);
    expect(onCancelTest).not.toHaveBeenCalled();
  });

  it("切换编辑目标时即使复用会话标识也不会沿用敏感草稿", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ServerEditorDialog {...createProps()} />);
    await addKeyValue(user, "敏感环境变量", "API_TOKEN", "old-secret");
    expect(screen.getByDisplayValue("old-secret")).toBeInTheDocument();

    rerender(
      <ServerEditorDialog
        {...createProps({
          mode: { type: "edit", profile: remoteProfile() },
          proxies: [proxyProfile()],
        })}
      />,
    );

    expect(screen.queryByDisplayValue("old-secret")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Bearer 令牌/u)).toHaveValue("");
  });

  it("同一编辑会话更新权威配置基线时保留失败草稿", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <ServerEditorDialog {...createProps({ onSubmit })} />,
    );
    await user.type(screen.getByLabelText(/^名称/u), "本机 Codex");
    await user.type(
      screen.getByLabelText(/^可执行文件路径/u),
      "/usr/bin/codex",
    );
    await addKeyValue(user, "敏感环境变量", "API_TOKEN", "retry-secret");

    const createdProfile: ServerProfile = {
      serverId: SERVER_ID,
      name: "本机 Codex",
      version: 1,
      configuration: {
        type: "localStdio",
        executablePath: "/usr/bin/codex",
        arguments: [],
        nonSensitiveEnvironment: {},
      },
      credentialConfigured: false,
      activeWindowCount: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    rerender(
      <ServerEditorDialog
        {...createProps({
          createdProfileContinuationId: SERVER_ID,
          mode: { type: "edit", profile: createdProfile },
          onSubmit,
        })}
      />,
    );

    expect(screen.getByLabelText(/^名称/u)).toHaveValue("本机 Codex");
    expect(screen.getByDisplayValue("retry-secret")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        credentialIntent: {
          type: "set",
          credential: {
            type: "sensitiveEnvironment",
            values: { API_TOKEN: "retry-secret" },
          },
        },
      }),
    );
  });

  it("保存中禁用编辑和关闭，并展示外部错误", () => {
    const onCancel = vi.fn();
    render(
      <ServerEditorDialog
        {...createProps({
          error: "服务器名称已存在",
          onCancel,
          saving: true,
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("服务器名称已存在");
    expect(screen.getByLabelText(/^名称/u)).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "关闭服务器编辑器" }),
    ).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
