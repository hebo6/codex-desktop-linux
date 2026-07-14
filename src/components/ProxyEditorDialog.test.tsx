import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProxyId, ProxyProfile, ServerId, ServerProfile } from "../configuration";
import { ProxyEditorDialog } from "./ProxyEditorDialog";

const PROXY_ID = "11111111-1111-4111-8111-111111111111" as ProxyId;
const SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;

function savedProxy(): ProxyProfile {
  return {
    proxyId: PROXY_ID,
    name: "开发代理",
    version: 1,
    configuration: { type: "socks5", host: "127.0.0.1", port: 1080, authentication: "none", dnsResolution: "proxy", connectTimeoutMs: 30_000 },
    credentialConfigured: false,
    referencedServerCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sshProxy(): ProxyProfile {
  return {
    ...savedProxy(),
    configuration: {
      type: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "dev",
      authentication: { type: "agent" },
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 15_000,
      keepAliveMaxFailures: 3,
    },
  };
}

function remoteServer(): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "测试服务器",
    version: 1,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 30_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("ProxyEditorDialog", () => {
  it("切换类型时保留各类型草稿并提交 SOCKS5 默认代理 DNS", () => {
    const onSubmit = vi.fn();
    render(<ProxyEditorDialog mode={{ type: "create" }} onCancel={vi.fn()} onSubmit={onSubmit} open remoteServers={[]} saving={false} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "共享代理" } });
    fireEvent.click(screen.getByRole("radio", { name: /SOCKS5/u }));
    fireEvent.change(screen.getByLabelText("主机"), { target: { value: "proxy.example.test" } });
    fireEvent.click(screen.getByRole("radio", { name: /HTTP CONNECT/u }));
    fireEvent.change(screen.getByLabelText("代理 URL"), { target: { value: "http://127.0.0.1:8080" } });
    fireEvent.click(screen.getByRole("radio", { name: /SOCKS5/u }));
    expect(screen.getByLabelText("主机")).toHaveValue("proxy.example.test");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ configuration: expect.objectContaining({ type: "socks5", dnsResolution: "proxy" }) }));
  });

  it("使用未保存草稿执行完整连接测试", () => {
    const onTest = vi.fn();
    render(<ProxyEditorDialog mode={{ type: "edit", profile: savedProxy() }} onCancel={vi.fn()} onCancelTest={vi.fn()} onSubmit={vi.fn()} onTest={onTest} open remoteServers={[remoteServer()]} saving={false} />);
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "1081" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(onTest).toHaveBeenCalledWith(
      SERVER_ID,
      expect.objectContaining({
        configuration: expect.objectContaining({ type: "socks5", port: 1081 }),
      }),
    );
  });

  it("新建代理无需保存即可测试", () => {
    const onTest = vi.fn();
    render(<ProxyEditorDialog mode={{ type: "create" }} onCancel={vi.fn()} onCancelTest={vi.fn()} onSubmit={vi.fn()} onTest={onTest} open remoteServers={[remoteServer()]} saving={false} />);
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新代理" } });
    fireEvent.change(screen.getByLabelText("代理 URL"), { target: { value: "http://127.0.0.1:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(onTest).toHaveBeenCalledWith(
      SERVER_ID,
      expect.objectContaining({ configuration: expect.objectContaining({ type: "httpConnect" }) }),
    );
  });

  it("展示未知 SSH 主机密钥并只在用户确认后提交绑定", () => {
    const onConfirmHostKey = vi.fn();
    const onSubmit = vi.fn();
    const fingerprint = `SHA256:${"A".repeat(43)}`;
    render(<ProxyEditorDialog
      mode={{ type: "edit", profile: sshProxy() }}
      onCancel={vi.fn()}
      onConfirmHostKey={onConfirmHostKey}
      onSubmit={onSubmit}
      open
      remoteServers={[]}
      saving={false}
      testState={{
        type: "failed",
        message: "SSH 代理主机密钥需要在代理配置中确认",
        sshHostKeyPrompt: {
          kind: "unknown",
          host: "ssh.example.test",
          port: 22,
          algorithm: "ssh-ed25519",
          sha256Fingerprint: fingerprint,
        },
      }}
    />);

    expect(screen.getByText(fingerprint)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认并绑定此密钥" }));
    expect(onConfirmHostKey).toHaveBeenCalledWith(expect.objectContaining({
      kind: "unknown",
      sha256Fingerprint: fingerprint,
    }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      sshHostKey: expect.objectContaining({ sha256Fingerprint: fingerprint }),
    }));
  });
});
