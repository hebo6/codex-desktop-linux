import { describe, expect, it, vi } from "vitest";

import {
  HttpProxyWebSocketConnection,
  createHttpProxyWebSocketTransportConnector,
} from "./httpProxyWebSocket";
import type {
  ConnectHttpProxyWebSocketRequest,
  HttpProxyWebSocketIpc,
} from "./httpProxyWebSocket";
import type { ProtocolTransportEventHandlers } from "./protocolTransport";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements HttpProxyWebSocketIpc {
  readonly calls: InvokeCall[] = [];
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): { channel: unknown } {
    this.eventHandler = onMessage;
    return { channel: { kind: "test-channel" } };
  }

  async invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_http_proxy_websocket") {
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

const request: ConnectHttpProxyWebSocketRequest = {
  connectionId: "remote",
  target: {
    url: "wss://target.example.test/app",
    insecureTransportConfirmed: false,
    connectTimeoutMs: 10_000,
    nonSensitiveHeaders: { "X-Server-Mode": "desktop" },
  },
  proxy: {
    url: "https://proxy.example.test:8443",
    connectTimeoutMs: 8_000,
    nonSensitiveHeaders: { "X-Proxy-Mode": "tunnel" },
  },
};

describe("HttpProxyWebSocketConnection", () => {
  it("只向 Rust 传递分域后的非敏感目标和代理参数", async () => {
    const ipc = new FakeIpc();
    const statuses = vi.fn();
    const connection = await HttpProxyWebSocketConnection.connect(
      request,
      { onProtocolMessage: vi.fn(), onStatus: statuses },
      ipc,
    );

    expect(connection.connectionId).toBe("remote");
    expect(statuses).toHaveBeenCalledOnce();
    expect(ipc.calls[0]).toEqual({
      command: "connect_http_proxy_websocket",
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
            url: "https://proxy.example.test:8443",
            connectTimeoutMs: 8_000,
            nonSensitiveHeaders: { "X-Proxy-Mode": "tunnel" },
          },
        },
        events: { kind: "test-channel" },
      },
    });
    expect(JSON.stringify(ipc.calls[0])).not.toMatch(
      /authorization|credential|password|secret|token/i,
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
    await createHttpProxyWebSocketTransportConnector(request, ipc)(handlers);

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
