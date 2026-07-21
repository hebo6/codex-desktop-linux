import { describe, expect, it } from "vitest";

import packageMetadata from "../../package.json";
import type { Socks5ProxyWebSocketIpc } from "../transport/socks5ProxyWebSocket";
import { createSocks5ProxyWebSocketAppServerSession } from "./socks5ProxyWebSocketSession";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class HandshakeIpc implements Socks5ProxyWebSocketIpc {
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
    if (command === "send_remote_websocket_message") {
      const request = asRecord(arguments_.request);
      const message = asRecord(JSON.parse(String(request.json)) as unknown);
      if (message.method === "initialize") {
        this.emit({
          kind: "protocolMessage",
          connectionId: "remote",
          json: JSON.stringify({
            id: message.id,
            result: {
              codexHome: "/home/remote/.codex",
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: "codex-socks5-test",
            },
          }),
        });
      }
      return undefined as T;
    }
    if (command === "disconnect_remote_websocket") {
      this.emit({
        kind: "status",
        connectionId: "remote",
        status: "disconnected",
        reason: "requested",
        forced: false,
      });
      return undefined as T;
    }
    throw new Error(`unexpected command: ${command}`);
  }

  private emit(event: unknown): void {
    if (this.eventHandler === undefined) {
      throw new Error("event channel was not created");
    }
    this.eventHandler(event);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("expected a record");
  }
  return value as Record<string, unknown>;
}

describe("createSocks5ProxyWebSocketAppServerSession", () => {
  it("经 SOCKS5 传输完成 app-server 初始化", async () => {
    const ipc = new HandshakeIpc();
    const phases: string[] = [];
    const session = createSocks5ProxyWebSocketAppServerSession({
      request: {
        connectionId: "remote",
        target: {
          url: "wss://target.example.test/app",
          insecureTransportConfirmed: false,
          connectTimeoutMs: 10_000,
        },
        proxy: {
          host: "proxy.example.test",
          port: 1080,
          dnsResolution: "proxy",
          connectTimeoutMs: 8_000,
        },
      },
      ipc,
      onStateChange: ({ phase }) => phases.push(phase),
    });

    await expect(session.start()).resolves.toMatchObject({
      platformOs: "linux",
      userAgent: "codex-socks5-test",
    });
    expect(ipc.calls.map(({ command }) => command)).toEqual([
      "connect_socks5_proxy_websocket",
      "send_remote_websocket_message",
      "send_remote_websocket_message",
    ]);
    const outboundMessages = ipc.calls
      .filter(({ command }) => command === "send_remote_websocket_message")
      .map(({ arguments: arguments_ }) => {
        const request = asRecord(arguments_.request);
        return JSON.parse(String(request.json)) as unknown;
      });
    expect(outboundMessages).toEqual([
      {
        id: expect.any(String),
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-desktop-linux",
            title: "Codex Desktop Linux",
            version: packageMetadata.version,
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "initialized" },
    ]);
    expect(phases).toEqual(["connecting", "initializing", "ready"]);

    await session.close();
    expect(ipc.calls.at(-1)?.command).toBe("disconnect_remote_websocket");
    expect(session.state.phase).toBe("closed");
  });
});
