import { describe, expect, it, vi } from "vitest";

import {
  Socks5ProxyWebSocketConnection,
  createSocks5ProxyWebSocketTransportConnector,
} from "./socks5ProxyWebSocket";
import type {
  ConnectSocks5ProxyWebSocketRequest,
  Socks5ProxyWebSocketIpc,
} from "./socks5ProxyWebSocket";
import type { ProtocolTransportEventHandlers } from "./protocolTransport";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements Socks5ProxyWebSocketIpc {
  readonly calls: InvokeCall[] = [];
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): { channel: unknown } {
    this.eventHandler = onMessage;
    return { channel: { kind: "test-channel" } };
  }

  async invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_socks5_proxy_websocket") {
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

const request: ConnectSocks5ProxyWebSocketRequest = {
  connectionId: "remote",
  target: {
    url: "wss://target.example.test/app",
    insecureTransportConfirmed: false,
    connectTimeoutMs: 10_000,
    nonSensitiveHeaders: { "X-Server-Mode": "desktop" },
  },
  proxy: {
    host: "proxy.example.test",
    port: 1080,
    connectTimeoutMs: 8_000,
  },
};

describe("Socks5ProxyWebSocketConnection", () => {
  it("默认使用代理 DNS 且不向 WebView IPC 暴露凭据字段", async () => {
    const ipc = new FakeIpc();
    const statuses = vi.fn();
    const connection = await Socks5ProxyWebSocketConnection.connect(
      request,
      { onProtocolMessage: vi.fn(), onStatus: statuses },
      ipc,
    );

    expect(connection.connectionId).toBe("remote");
    expect(statuses).toHaveBeenCalledOnce();
    expect(ipc.calls[0]).toEqual({
      command: "connect_socks5_proxy_websocket",
      arguments: {
        request: {
          connectionId: "remote",
          target: {
            url: "wss://target.example.test/app",
            insecureTransportConfirmed: false,
            connectTimeoutMs: 10_000,
            nonSensitiveHeaders: { "X-Server-Mode": "desktop" },
          },
          proxy: {
            host: "proxy.example.test",
            port: 1080,
            dnsResolution: "proxy",
            connectTimeoutMs: 8_000,
          },
        },
        events: { kind: "test-channel" },
      },
    });
    expect(JSON.stringify(ipc.calls[0])).not.toMatch(
      /authorization|credential|password|secret|token|username/i,
    );

    await connection.write({ method: "initialized" });
    expect(ipc.calls[1]).toEqual({
      command: "send_remote_websocket_message",
      arguments: {
        request: {
          connectionId: "remote",
          json: '{"method":"initialized"}',
        },
      },
    });

    await connection.close();
    expect(ipc.calls[2]?.command).toBe("disconnect_remote_websocket");
  });

  it("把代理连接的终态映射到统一传输生命周期", async () => {
    const ipc = new FakeIpc();
    const handlers: ProtocolTransportEventHandlers = {
      onProtocolMessage: vi.fn(),
      onTransportClosed: vi.fn(),
      onTransportFailure: vi.fn(),
    };
    await createSocks5ProxyWebSocketTransportConnector(
      {
        ...request,
        proxy: { ...request.proxy, dnsResolution: "local" },
      },
      ipc,
    )(handlers);

    ipc.emit({
      kind: "status",
      connectionId: "remote",
      status: "error",
      reason: "readFailed",
      forced: true,
    });

    expect(handlers.onTransportClosed).toHaveBeenCalledOnce();
    expect(handlers.onTransportFailure).not.toHaveBeenCalled();
  });
});
