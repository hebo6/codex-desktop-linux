import { describe, expect, it } from "vitest";

import type { ProxyId, ServerId } from "../configuration/model";
import type { ConfiguredServerIpc } from "../transport/configuredServer";
import * as publicAppServer from "./index";
import { createConfiguredServerAppServerSession } from "./configuredServerSession";

const CONNECTION_ID = "configured-session";
const NEXT_CONNECTION_ID = "next-configured-session";
const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const NEXT_SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;
const PROXY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProxyId;

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class HandshakeIpc implements ConfiguredServerIpc {
  readonly calls: InvokeCall[] = [];
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): {
    channel: unknown;
  } {
    this.eventHandler = onMessage;
    return { channel: { kind: "configured-test-channel" } };
  }

  async invoke<T>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_configured_server") {
      this.emitRemote({
        kind: "status",
        connectionId: CONNECTION_ID,
        status: "connected",
        forced: false,
      });
      return {
        connectionId: CONNECTION_ID,
        serverId: SERVER_ID,
        serverVersion: 4,
        transport: "remoteWebSocket",
        connectionPath: "socks5",
        proxyId: PROXY_ID,
        proxyVersion: 2,
      } as T;
    }
    if (command === "send_configured_server_message") {
      const request = asRecord(arguments_.request);
      const message = asRecord(JSON.parse(String(request.json)) as unknown);
      if (message.method === "initialize") {
        this.emitRemote({
          kind: "protocolMessage",
          connectionId: CONNECTION_ID,
          json: JSON.stringify({
            id: message.id,
            result: {
              codexHome: "/home/remote/.codex",
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: "codex-configured-test",
            },
          }),
        });
      }
      return undefined as T;
    }
    if (command === "disconnect_configured_server") {
      this.emitRemote({
        kind: "status",
        connectionId: CONNECTION_ID,
        status: "disconnected",
        reason: "requested",
        forced: false,
      });
      return undefined as T;
    }
    throw new Error(`unexpected command: ${command}`);
  }

  private emitRemote(event: Record<string, unknown>): void {
    if (this.eventHandler === undefined) {
      throw new Error("event channel was not created");
    }
    this.eventHandler({
      serverId: SERVER_ID,
      transport: "remoteWebSocket",
      event,
    });
  }
}

class PendingHandshakeIpc implements ConfiguredServerIpc {
  readonly calls: InvokeCall[] = [];
  private rejectConnect: ((reason: unknown) => void) | undefined;

  createEventChannel(): { channel: unknown } {
    return { channel: { kind: "pending-configured-test-channel" } };
  }

  async invoke<T>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_configured_server") {
      return await new Promise<T>((_resolve, reject) => {
        this.rejectConnect = reject;
      });
    }
    if (command === "cancel_configured_server_connection") {
      this.rejectConnect?.(new Error("raw backend cancellation detail"));
      return undefined as T;
    }
    throw new Error(`unexpected command: ${command}`);
  }
}

class FailedCancellationIpc implements ConfiguredServerIpc {
  readonly calls: InvokeCall[] = [];
  private rejectConnect: ((reason: unknown) => void) | undefined;

  createEventChannel(): { channel: unknown } {
    return { channel: { kind: "failed-cancellation-test-channel" } };
  }

  async invoke<T>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_configured_server") {
      return await new Promise<T>((_resolve, reject) => {
        this.rejectConnect = reject;
      });
    }
    if (command === "cancel_configured_server_connection") {
      throw new Error("raw cancellation IPC failure");
    }
    throw new Error(`unexpected command: ${command}`);
  }

  finishConnect(): void {
    this.rejectConnect?.(new Error("raw late connect failure"));
  }
}

class SwitchingHandshakeIpc implements ConfiguredServerIpc {
  readonly calls: InvokeCall[] = [];
  private eventHandler: ((event: unknown) => void) | undefined;
  private rejectFirstConnect: ((reason: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): {
    channel: unknown;
  } {
    this.eventHandler = onMessage;
    return { channel: { kind: "switching-configured-test-channel" } };
  }

  async invoke<T>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    const request = asRecord(arguments_.request);
    const connectionId = String(request.connectionId);

    if (command === "connect_configured_server") {
      if (connectionId === CONNECTION_ID) {
        return await new Promise<T>((_resolve, reject) => {
          this.rejectFirstConnect = reject;
        });
      }
      this.emitRemote(NEXT_SERVER_ID, {
        kind: "status",
        connectionId: NEXT_CONNECTION_ID,
        status: "connected",
        forced: false,
      });
      return {
        connectionId: NEXT_CONNECTION_ID,
        serverId: NEXT_SERVER_ID,
        serverVersion: 1,
        transport: "remoteWebSocket",
        connectionPath: "direct",
      } as T;
    }
    if (command === "cancel_configured_server_connection") {
      this.rejectFirstConnect?.(new Error("first connection cancelled"));
      return undefined as T;
    }
    if (command === "send_configured_server_message") {
      const message = asRecord(JSON.parse(String(request.json)) as unknown);
      if (message.method === "initialize") {
        this.emitRemote(NEXT_SERVER_ID, {
          kind: "protocolMessage",
          connectionId: NEXT_CONNECTION_ID,
          json: JSON.stringify({
            id: message.id,
            result: {
              codexHome: "/home/remote/.codex",
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: "codex-switched-test",
            },
          }),
        });
      }
      return undefined as T;
    }
    if (command === "disconnect_configured_server") {
      this.emitRemote(NEXT_SERVER_ID, {
        kind: "status",
        connectionId: NEXT_CONNECTION_ID,
        status: "disconnected",
        reason: "requested",
        forced: false,
      });
      return undefined as T;
    }
    throw new Error(`unexpected command: ${command}`);
  }

  private emitRemote(serverId: ServerId, event: Record<string, unknown>): void {
    if (this.eventHandler === undefined) {
      throw new Error("event channel was not created");
    }
    this.eventHandler({ serverId, transport: "remoteWebSocket", event });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("expected a record");
  }
  return value as Record<string, unknown>;
}

describe("createConfiguredServerAppServerSession", () => {
  it("同一轮立即关闭时在连接 IPC 启动前取消", async () => {
    const ipc = new PendingHandshakeIpc();
    const session = createConfiguredServerAppServerSession({
      request: { connectionId: CONNECTION_ID, serverId: SERVER_ID },
      ipc,
    });
    const startOutcome = session.start().catch((error: unknown) => error);

    await session.close();

    expect(await startOutcome).toMatchObject({ code: "sessionClosed" });
    expect(ipc.calls).toEqual([]);
    expect(session.state.phase).toBe("closed");
  });

  it("关闭时先取消建立中的配置连接且不泄露后端错误", async () => {
    const ipc = new PendingHandshakeIpc();
    const session = createConfiguredServerAppServerSession({
      request: { connectionId: CONNECTION_ID, serverId: SERVER_ID },
      ipc,
    });
    const startOutcome = session.start().catch((error: unknown) => error);
    await Promise.resolve();
    expect(ipc.calls[0]?.command).toBe("connect_configured_server");

    await session.close();

    const error = await startOutcome;
    expect(error).toMatchObject({ code: "sessionClosed" });
    expect(String(error)).not.toContain("raw backend cancellation detail");
    expect(ipc.calls.map(({ command }) => command)).toEqual([
      "connect_configured_server",
      "cancel_configured_server_connection",
    ]);
    expect(session.state.phase).toBe("closed");
  });

  it("取消 IPC 失败时不永久等待仍挂起的连接命令", async () => {
    const ipc = new FailedCancellationIpc();
    const diagnostics: unknown[] = [];
    const session = createConfiguredServerAppServerSession({
      request: { connectionId: CONNECTION_ID, serverId: SERVER_ID },
      ipc,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const startOutcome = session.start().catch((error: unknown) => error);
    await Promise.resolve();

    const closeError = await session.close().catch((error: unknown) => error);
    expect(closeError).toMatchObject({ code: "transportConnectCancelFailed" });
    expect(String(closeError)).not.toContain("raw cancellation IPC failure");
    expect(session.state.phase).toBe("closed");
    expect(diagnostics).toContainEqual({
      source: "session",
      code: "transportConnectCancelFailed",
      phase: "closing",
    });

    ipc.finishConnect();
    expect(await startOutcome).toMatchObject({ code: "sessionClosed" });
  });

  it("切换时等待旧连接快速取消后立即启动下一连接", async () => {
    const ipc = new SwitchingHandshakeIpc();
    const first = createConfiguredServerAppServerSession({
      request: { connectionId: CONNECTION_ID, serverId: SERVER_ID },
      ipc,
    });
    const firstStart = first.start().catch((error: unknown) => error);
    await Promise.resolve();

    await first.close();
    expect(await firstStart).toMatchObject({ code: "sessionClosed" });

    const next = createConfiguredServerAppServerSession({
      request: {
        connectionId: NEXT_CONNECTION_ID,
        serverId: NEXT_SERVER_ID,
      },
      ipc,
    });
    await expect(next.start()).resolves.toMatchObject({
      userAgent: "codex-switched-test",
    });

    expect(
      ipc.calls
        .filter(({ command }) =>
          [
            "connect_configured_server",
            "cancel_configured_server_connection",
          ].includes(command),
        )
        .map(({ command, arguments: arguments_ }) => ({
          command,
          connectionId: asRecord(arguments_.request).connectionId,
        })),
    ).toEqual([
      { command: "connect_configured_server", connectionId: CONNECTION_ID },
      {
        command: "cancel_configured_server_connection",
        connectionId: CONNECTION_ID,
      },
      {
        command: "connect_configured_server",
        connectionId: NEXT_CONNECTION_ID,
      },
    ]);

    await next.close();
  });

  it("按 serverId 建立传输并完成 app-server 初始化", async () => {
    const ipc = new HandshakeIpc();
    const phases: string[] = [];
    const session = createConfiguredServerAppServerSession({
      request: {
        connectionId: CONNECTION_ID,
        serverId: SERVER_ID,
      },
      ipc,
      onStateChange: ({ phase }) => phases.push(phase),
    });

    await expect(session.start()).resolves.toMatchObject({
      platformOs: "linux",
      userAgent: "codex-configured-test",
    });

    expect(ipc.calls[0]).toEqual({
      command: "connect_configured_server",
      arguments: {
        request: { connectionId: CONNECTION_ID, serverId: SERVER_ID },
        events: { kind: "configured-test-channel" },
      },
    });
    expect(ipc.calls.map(({ command }) => command)).toEqual([
      "connect_configured_server",
      "send_configured_server_message",
      "send_configured_server_message",
    ]);
    expect(phases).toEqual(["connecting", "initializing", "ready"]);

    await session.close();
    expect(ipc.calls.at(-1)?.command).toBe("disconnect_configured_server");
    expect(session.state.phase).toBe("closed");
  });

  it("公共 appServer 入口不再暴露 raw session 工厂", () => {
    expect(publicAppServer).toHaveProperty(
      "createConfiguredServerAppServerSession",
    );
    for (const factory of [
      "createLocalStdioAppServerSession",
      "createDirectWebSocketAppServerSession",
      "createHttpProxyWebSocketAppServerSession",
      "createSocks5ProxyWebSocketAppServerSession",
      "createSshTunnelWebSocketAppServerSession",
    ]) {
      expect(publicAppServer).not.toHaveProperty(factory);
    }
  });
});
