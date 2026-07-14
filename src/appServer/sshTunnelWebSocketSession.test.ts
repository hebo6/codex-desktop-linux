import { describe, expect, it } from "vitest";

import type { SshTunnelWebSocketIpc } from "../transport/sshTunnelWebSocket";
import { createSshTunnelWebSocketAppServerSession } from "./sshTunnelWebSocketSession";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class HandshakeIpc implements SshTunnelWebSocketIpc {
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
              userAgent: "codex-ssh-test",
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

describe("createSshTunnelWebSocketAppServerSession", () => {
  it("经 SSH direct-tcpip 传输完成 app-server 初始化", async () => {
    const ipc = new HandshakeIpc();
    const phases: string[] = [];
    const session = createSshTunnelWebSocketAppServerSession({
      request: {
        connectionId: "remote",
        target: {
          url: "wss://target.example.test/app",
          insecureTransportConfirmed: false,
          connectTimeoutMs: 10_000,
        },
        tunnel: {
          host: "ssh.example.test",
          username: "alice",
          authentication: { type: "agent" },
          hostKey: {
            algorithm: "ssh-ed25519",
            sha256Fingerprint: "SHA256:confirmed",
          },
          connectTimeoutMs: 8_000,
          keepAliveIntervalMs: 15_000,
          keepAliveMaxFailures: 3,
        },
      },
      ipc,
      onStateChange: ({ phase }) => phases.push(phase),
    });

    await expect(session.start()).resolves.toMatchObject({
      platformOs: "linux",
      userAgent: "codex-ssh-test",
    });
    expect(ipc.calls.map(({ command }) => command)).toEqual([
      "connect_ssh_tunnel_websocket",
      "send_remote_websocket_message",
      "send_remote_websocket_message",
    ]);
    expect(phases).toEqual(["connecting", "initializing", "ready"]);

    await session.close();
    expect(ipc.calls.at(-1)?.command).toBe("disconnect_remote_websocket");
    expect(session.state.phase).toBe("closed");
  });
});
