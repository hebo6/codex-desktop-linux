import { describe, expect, it, vi } from "vitest";

import {
  SshTunnelWebSocketConnection,
  createSshTunnelWebSocketTransportConnector,
  isSshHostKeyCommandError,
} from "./sshTunnelWebSocket";
import type {
  ConnectSshTunnelWebSocketRequest,
  SshTunnelWebSocketIpc,
} from "./sshTunnelWebSocket";
import type { ProtocolTransportEventHandlers } from "./protocolTransport";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

const FINGERPRINT_A = `SHA256:${"A".repeat(43)}`;
const FINGERPRINT_B = `SHA256:${"B".repeat(43)}`;

class FakeIpc implements SshTunnelWebSocketIpc {
  readonly calls: InvokeCall[] = [];
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): { channel: unknown } {
    this.eventHandler = onMessage;
    return { channel: { kind: "test-channel" } };
  }

  async invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_ssh_tunnel_websocket") {
      this.emit({
        kind: "status",
        connectionId: "remote",
        status: "connected",
        forced: false,
      });
      return { connectionId: "remote" } as T;
    }
    if (command === "disconnect_remote_websocket") {
      this.emit({
        kind: "status",
        connectionId: "remote",
        status: "disconnected",
        reason: "requested",
        forced: false,
      });
    }
    return undefined as T;
  }

  emit(event: unknown): void {
    if (this.eventHandler === undefined) {
      throw new Error("event channel was not created");
    }
    this.eventHandler(event);
  }
}

const request: ConnectSshTunnelWebSocketRequest = {
  connectionId: "remote",
  target: {
    url: "wss://target.example.test/app",
    insecureTransportConfirmed: false,
    connectTimeoutMs: 10_000,
    nonSensitiveHeaders: { "X-Server-Mode": "desktop" },
  },
  tunnel: {
    host: "ssh.example.test",
    username: "alice",
    authentication: { type: "agent" },
    hostKey: {
      algorithm: "ssh-ed25519",
      sha256Fingerprint: FINGERPRINT_A,
    },
    connectTimeoutMs: 8_000,
    keepAliveIntervalMs: 15_000,
    keepAliveMaxFailures: 3,
  },
};

describe("SshTunnelWebSocketConnection", () => {
  it("默认使用 22 端口并仅向 IPC 发送非敏感 SSH 配置", async () => {
    const ipc = new FakeIpc();
    const injectedRequest = {
      ...request,
      target: { ...request.target, authorization: "top-secret" },
      tunnel: {
        ...request.tunnel,
        password: "top-secret",
        authentication: {
          type: "agent",
          passphrase: "top-secret",
        },
        hostKey: {
          ...request.tunnel.hostKey,
          token: "top-secret",
        },
      },
    } as unknown as ConnectSshTunnelWebSocketRequest;
    const connection = await SshTunnelWebSocketConnection.connect(
      injectedRequest,
      { onProtocolMessage: vi.fn(), onStatus: vi.fn() },
      ipc,
    );

    expect(connection.connectionId).toBe("remote");
    expect(ipc.calls[0]).toEqual({
      command: "connect_ssh_tunnel_websocket",
      arguments: {
        request: {
          connectionId: "remote",
          target: {
            url: "wss://target.example.test/app",
            insecureTransportConfirmed: false,
            connectTimeoutMs: 10_000,
            nonSensitiveHeaders: { "X-Server-Mode": "desktop" },
          },
          tunnel: {
            host: "ssh.example.test",
            port: 22,
            username: "alice",
            authentication: { type: "agent" },
            hostKey: {
              algorithm: "ssh-ed25519",
              sha256Fingerprint: FINGERPRINT_A,
            },
            connectTimeoutMs: 8_000,
            keepAliveIntervalMs: 15_000,
            keepAliveMaxFailures: 3,
          },
        },
        events: { kind: "test-channel" },
      },
    });
    expect(JSON.stringify(ipc.calls[0])).not.toMatch(
      /authorization|password|passphrase|secret|token/i,
    );

    await connection.close();
    expect(ipc.calls[1]?.command).toBe("disconnect_remote_websocket");
  });

  it("逐字段归一化私钥认证并映射统一传输生命周期", async () => {
    const ipc = new FakeIpc();
    const handlers: ProtocolTransportEventHandlers = {
      onProtocolMessage: vi.fn(),
      onTransportClosed: vi.fn(),
      onTransportFailure: vi.fn(),
    };
    await createSshTunnelWebSocketTransportConnector(
      {
        ...request,
        tunnel: {
          ...request.tunnel,
          authentication: {
            type: "privateKey",
            privateKeyPath: "/home/alice/.ssh/id_ed25519",
          },
        },
      },
      ipc,
    )(handlers);

    expect(ipc.calls[0]?.arguments).toMatchObject({
      request: {
        tunnel: {
          authentication: {
            type: "privateKey",
            privateKeyPath: "/home/alice/.ssh/id_ed25519",
          },
        },
      },
    });
    ipc.emit({
      kind: "status",
      connectionId: "remote",
      status: "error",
      reason: "sshKeepAliveTimedOut",
      forced: true,
    });

    expect(handlers.onTransportClosed).toHaveBeenCalledOnce();
    expect(handlers.onTransportFailure).not.toHaveBeenCalled();
  });

  it("严格识别未知和变化的主机密钥错误详情", () => {
    const received = {
      algorithm: "ssh-ed25519",
      sha256Fingerprint: FINGERPRINT_B,
    };
    const unknownError = {
      code: "sshHostKeyUnknown",
      message: "confirmation required",
      details: {
        kind: "sshHostKeyUnknown",
        host: "ssh.example.test",
        port: 22,
        received,
      },
    };
    const changedError = {
      code: "sshHostKeyChanged",
      message: "changed",
      details: {
        kind: "sshHostKeyChanged",
        host: "ssh.example.test",
        port: 22,
        expected: {
          algorithm: "ssh-ed25519",
          sha256Fingerprint: FINGERPRINT_A,
        },
        received,
      },
    };

    expect(isSshHostKeyCommandError(unknownError)).toBe(true);
    expect(isSshHostKeyCommandError(changedError)).toBe(true);
    expect(
      isSshHostKeyCommandError({
        ...changedError,
        details: { ...changedError.details, expected: undefined },
      }),
    ).toBe(false);
    expect(
      isSshHostKeyCommandError({
        ...unknownError,
        details: { ...unknownError.details, kind: "sshHostKeyChanged" },
      }),
    ).toBe(false);
    expect(
      isSshHostKeyCommandError({ ...unknownError, password: "top-secret" }),
    ).toBe(false);
    expect(
      isSshHostKeyCommandError({
        ...unknownError,
        details: { ...unknownError.details, secret: "top-secret" },
      }),
    ).toBe(false);
    expect(
      isSshHostKeyCommandError({
        ...unknownError,
        details: {
          ...unknownError.details,
          received: { ...received, token: "top-secret" },
        },
      }),
    ).toBe(false);
    expect(
      isSshHostKeyCommandError({
        ...unknownError,
        details: { ...unknownError.details, port: 22.5 },
      }),
    ).toBe(false);
  });

  it("原样传播 SSH 主机密钥连接错误", async () => {
    const expectedError = {
      code: "sshHostKeyUnknown",
      message: "confirmation required",
      details: {
        kind: "sshHostKeyUnknown",
        host: "ssh.example.test",
        port: 22,
        received: {
          algorithm: "ssh-ed25519",
          sha256Fingerprint: FINGERPRINT_B,
        },
      },
    };
    const ipc: SshTunnelWebSocketIpc = {
      createEventChannel: () => ({ channel: { kind: "test-channel" } }),
      invoke: vi.fn().mockRejectedValue(expectedError),
    };

    await expect(
      SshTunnelWebSocketConnection.connect(
        request,
        { onProtocolMessage: vi.fn(), onStatus: vi.fn() },
        ipc,
      ),
    ).rejects.toBe(expectedError);
  });
});
