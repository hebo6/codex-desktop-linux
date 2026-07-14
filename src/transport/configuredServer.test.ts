import { describe, expect, it, vi } from "vitest";

import type { ProxyId, ServerId } from "../configuration/model";
import type { JSONRPCMessage } from "../protocol/generated";
import * as publicTransport from "./index";
import {
  ConfiguredServerBridgeError,
  ConfiguredServerConnection,
  createConfiguredServerTransportConnector,
} from "./configuredServer";
import type {
  ConfiguredServerIpc,
  ConnectConfiguredServerRequest,
} from "./configuredServer";
import type { ProtocolTransportEventHandlers } from "./protocolTransport";

const CONNECTION_ID = "configured-connection";
const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const OTHER_SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;
const PROXY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProxyId;

interface Invocation {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements ConfiguredServerIpc {
  readonly invocations: Invocation[] = [];
  readonly connectEvents: unknown[] = [];
  connectResponse: unknown;
  connectCommandReturned = false;
  private eventHandler: ((event: unknown) => void) | undefined;

  constructor(connectResponse: unknown) {
    this.connectResponse = connectResponse;
  }

  createEventChannel(onMessage: (event: unknown) => void) {
    this.eventHandler = onMessage;
    return { channel: "configured-events" };
  }

  async invoke<T>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    this.invocations.push({ command, arguments: arguments_ });
    if (command === "connect_configured_server") {
      for (const event of this.connectEvents) {
        this.emit(event);
      }
      this.connectCommandReturned = true;
      return this.connectResponse as T;
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

class PendingConnectIpc implements ConfiguredServerIpc {
  readonly invocations: Invocation[] = [];
  cancelError: Error | undefined;
  private rejectConnect: ((reason: unknown) => void) | undefined;

  createEventChannel(): { channel: unknown } {
    return { channel: "pending-configured-events" };
  }

  async invoke<T>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<T> {
    this.invocations.push({ command, arguments: arguments_ });
    if (command === "connect_configured_server") {
      return await new Promise<T>((_resolve, reject) => {
        this.rejectConnect = reject;
      });
    }
    if (command === "cancel_configured_server_connection") {
      this.rejectConnect?.(new Error("backend cancellation detail"));
      if (this.cancelError !== undefined) {
        throw this.cancelError;
      }
      return undefined as T;
    }
    throw new Error(`unexpected command: ${command}`);
  }
}

const request: ConnectConfiguredServerRequest = {
  connectionId: CONNECTION_ID,
  serverId: SERVER_ID,
};

function localResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connectionId: CONNECTION_ID,
    serverId: SERVER_ID,
    serverVersion: 3,
    transport: "localStdio",
    connectionPath: "localStdio",
    ...overrides,
  };
}

function remoteResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connectionId: CONNECTION_ID,
    serverId: SERVER_ID,
    serverVersion: 7,
    transport: "remoteWebSocket",
    connectionPath: "direct",
    ...overrides,
  };
}

function localEvent(
  event: Record<string, unknown>,
  serverId: ServerId = SERVER_ID,
) {
  return { serverId, transport: "localStdio", event };
}

function remoteEvent(
  event: Record<string, unknown>,
  serverId: ServerId = SERVER_ID,
) {
  return { serverId, transport: "remoteWebSocket", event };
}

function connectedLocalEvent(): Record<string, unknown> {
  return localEvent({
    kind: "status",
    connectionId: CONNECTION_ID,
    status: "connected",
    stderrBytes: 0,
    forced: false,
  });
}

function connectedRemoteEvent(): Record<string, unknown> {
  return remoteEvent({
    kind: "status",
    connectionId: CONNECTION_ID,
    status: "connected",
    forced: false,
  });
}

function handlers() {
  return {
    onProtocolMessage: vi.fn<(json: string) => void>(),
    onConnectionProgress: vi.fn(),
    onTransportClosed: vi.fn<() => void>(),
    onTransportFailure: vi.fn<() => void>(),
  } satisfies ProtocolTransportEventHandlers;
}

describe("ConfiguredServerConnection", () => {
  it("连接启动前取消时不创建 IPC reservation", async () => {
    const ipc = new PendingConnectIpc();
    const connector = createConfiguredServerTransportConnector(request, ipc);

    await connector.cancelPending();

    await expect(connector(handlers())).rejects.toEqual(
      new ConfiguredServerBridgeError("connectionCancelled"),
    );
    expect(ipc.invocations).toEqual([]);
  });

  it("按 connectionId 取消建立中的连接且并发取消只发送一次", async () => {
    const ipc = new PendingConnectIpc();
    const connector = createConfiguredServerTransportConnector(request, ipc);
    const connecting = connector(handlers());
    const outcome = connecting.catch((error: unknown) => error);
    expect(ipc.invocations[0]?.command).toBe("connect_configured_server");

    await Promise.all([connector.cancelPending(), connector.cancelPending()]);

    expect(await outcome).toEqual(
      new ConfiguredServerBridgeError("connectionCancelled"),
    );
    expect(ipc.invocations).toEqual([
      {
        command: "connect_configured_server",
        arguments: {
          request: {
            connectionId: CONNECTION_ID,
            serverId: SERVER_ID,
          },
          events: "pending-configured-events",
        },
      },
      {
        command: "cancel_configured_server_connection",
        arguments: { request: { connectionId: CONNECTION_ID } },
      },
    ]);
  });

  it("连接器固定创建时的请求，外部改写不会改变取消目标", async () => {
    const ipc = new PendingConnectIpc();
    const mutableRequest = { ...request };
    const connector = createConfiguredServerTransportConnector(
      mutableRequest,
      ipc,
    );
    mutableRequest.connectionId = "rewritten-before-connect";

    const connecting = connector(handlers()).catch((error: unknown) => error);
    mutableRequest.connectionId = "rewritten-after-connect";
    await connector.cancelPending();

    expect(await connecting).toEqual(
      new ConfiguredServerBridgeError("connectionCancelled"),
    );
    expect(
      ipc.invocations.map(
        ({ arguments: arguments_ }) =>
          (arguments_.request as { connectionId?: unknown }).connectionId,
      ),
    ).toEqual([CONNECTION_ID, CONNECTION_ID]);
  });

  it("取消命令失败时只暴露稳定的桥接错误", async () => {
    const ipc = new PendingConnectIpc();
    ipc.cancelError = new Error("secret backend failure");
    const connector = createConfiguredServerTransportConnector(request, ipc);
    const connecting = connector(handlers()).catch(() => undefined);

    await expect(connector.cancelPending()).rejects.toEqual(
      new ConfiguredServerBridgeError("connectionCancellationFailed"),
    );
    await connecting;
  });

  it("只发送 serverId 连接请求，确认响应后按序交付早到的本机事件", async () => {
    const ipc = new FakeIpc(localResponse());
    const eventHandlers = handlers();
    ipc.connectEvents.push(
      connectedLocalEvent(),
      localEvent({
        kind: "protocolMessage",
        connectionId: CONNECTION_ID,
        json: '{"method":"ready"}',
      }),
    );
    eventHandlers.onProtocolMessage.mockImplementation(() => {
      expect(ipc.connectCommandReturned).toBe(true);
    });

    const connection = await ConfiguredServerConnection.connect(
      request,
      eventHandlers,
      ipc,
    );

    expect(ipc.invocations[0]).toEqual({
      command: "connect_configured_server",
      arguments: {
        request: {
          connectionId: CONNECTION_ID,
          serverId: SERVER_ID,
        },
        events: "configured-events",
      },
    });
    expect(connection.connectionInfo).toEqual(localResponse());
    expect(eventHandlers.onProtocolMessage).toHaveBeenCalledWith(
      '{"method":"ready"}',
    );

    await connection.write({ method: "initialized" } as JSONRPCMessage);
    await connection.close();
    expect(ipc.invocations.slice(1)).toEqual([
      {
        command: "send_configured_server_message",
        arguments: {
          request: {
            connectionId: CONNECTION_ID,
            json: '{"method":"initialized"}',
          },
        },
      },
      {
        command: "disconnect_configured_server",
        arguments: { request: { connectionId: CONNECTION_ID } },
      },
    ]);
  });

  it("向会话上报本机进程退出状态和脱敏所需的统计", async () => {
    const ipc = new FakeIpc(localResponse());
    const eventHandlers = handlers();
    ipc.connectEvents.push(connectedLocalEvent());
    await ConfiguredServerConnection.connect(request, eventHandlers, ipc);

    ipc.emit(localEvent({
      kind: "status",
      connectionId: CONNECTION_ID,
      status: "exited",
      reason: "processExited",
      exitCode: 7,
      stderrBytes: 128,
      forced: false,
    }));

    expect(eventHandlers.onTransportClosed).toHaveBeenCalledWith({
      kind: "localProcess",
      status: "exited",
      reason: "processExited",
      exitCode: 7,
      stderrBytes: 128,
      forced: false,
    });
  });

  it("保留代理版本元数据并通过共享连接命令收发", async () => {
    const response = remoteResponse({
      connectionPath: "sshDirectTcpip",
      proxyId: PROXY_ID,
      proxyVersion: 5,
    });
    const ipc = new FakeIpc(response);
    const eventHandlers = handlers();
    ipc.connectEvents.push(
      remoteEvent({
        kind: "progress",
        connectionId: CONNECTION_ID,
        stage: "establishingTunnel",
      }),
      connectedRemoteEvent(),
    );

    const connection = await ConfiguredServerConnection.connect(
      { connectionId: CONNECTION_ID, serverId: SERVER_ID },
      eventHandlers,
      ipc,
    );
    expect(connection.connectionInfo).toEqual(response);
    expect(eventHandlers.onConnectionProgress).toHaveBeenCalledWith("establishingTunnel");

    await connection.write({ method: "initialized" } as JSONRPCMessage);
    await connection.close();
    expect(ipc.invocations.map(({ command }) => command)).toEqual([
      "connect_configured_server",
      "send_configured_server_message",
      "disconnect_configured_server",
    ]);
  });

  it.each([
    ["响应 serverId 不关联", localResponse({ serverId: OTHER_SERVER_ID })],
    ["本机响应使用远程路径", localResponse({ connectionPath: "direct" })],
    [
      "直连响应携带代理字段",
      remoteResponse({ proxyId: PROXY_ID, proxyVersion: 1 }),
    ],
    [
      "代理响应缺少代理版本",
      remoteResponse({ connectionPath: "httpConnect", proxyId: PROXY_ID }),
    ],
    ["响应包含未知字段", localResponse({ credential: "DO_NOT_ACCEPT" })],
  ])("拒绝%s", async (_label, response) => {
    const ipc = new FakeIpc(response);
    const eventHandlers = handlers();

    await expect(
      ConfiguredServerConnection.connect(request, eventHandlers, ipc),
    ).rejects.toEqual(
      new ConfiguredServerBridgeError("invalidConnectResponse"),
    );
    expect(eventHandlers.onTransportFailure).toHaveBeenCalledTimes(1);
  });

  it("拒绝与请求或响应 transport 不关联的事件并清理对应连接", async () => {
    const wrongServerIpc = new FakeIpc(remoteResponse());
    wrongServerIpc.connectEvents.push(
      localEvent(
        {
          kind: "status",
          connectionId: CONNECTION_ID,
          status: "connected",
          stderrBytes: 0,
          forced: false,
        },
        OTHER_SERVER_ID,
      ),
    );
    await expect(
      ConfiguredServerConnection.connect(request, handlers(), wrongServerIpc),
    ).rejects.toMatchObject({ code: "invalidConnectionEvent" });
    expect(wrongServerIpc.invocations.map(({ command }) => command)).toContain(
      "disconnect_configured_server",
    );

    const wrongConnectionIpc = new FakeIpc(localResponse());
    wrongConnectionIpc.connectEvents.push(
      localEvent({
        kind: "status",
        connectionId: "different-connection",
        status: "connected",
        stderrBytes: 0,
        forced: false,
      }),
    );
    await expect(
      ConfiguredServerConnection.connect(
        request,
        handlers(),
        wrongConnectionIpc,
      ),
    ).rejects.toMatchObject({ code: "invalidConnectionEvent" });

    const wrongTransportIpc = new FakeIpc(remoteResponse());
    wrongTransportIpc.connectEvents.push(connectedLocalEvent());
    await expect(
      ConfiguredServerConnection.connect(
        request,
        handlers(),
        wrongTransportIpc,
      ),
    ).rejects.toMatchObject({ code: "invalidConnectResponse" });
    expect(
      wrongTransportIpc.invocations.map(({ command }) => command),
    ).toContain("disconnect_configured_server");
  });

  it("在调用 IPC 前拒绝无效关联标识", async () => {
    const ipc = new FakeIpc(localResponse());
    await expect(
      ConfiguredServerConnection.connect(
        { connectionId: "UPPER", serverId: SERVER_ID },
        handlers(),
        ipc,
      ),
    ).rejects.toMatchObject({ code: "invalidConnectRequest" });
    expect(ipc.invocations).toEqual([]);
  });

  it.each([
    ["非字符串连接 ID", { connectionId: 1, serverId: SERVER_ID }],
    ["非字符串服务器 ID", { connectionId: CONNECTION_ID, serverId: 1 }],
    [
      "线程级工作目录字段",
      {
        connectionId: CONNECTION_ID,
        serverId: SERVER_ID,
        workingDirectory: "/workspace",
      },
    ],
    [
      "未知字段",
      {
        connectionId: CONNECTION_ID,
        serverId: SERVER_ID,
        ignored: true,
      },
    ],
  ])("在调用 IPC 前拒绝%s", async (_label, invalidRequest) => {
    const ipc = new FakeIpc(localResponse());

    await expect(
      ConfiguredServerConnection.connect(
        invalidRequest as unknown as ConnectConfiguredServerRequest,
        handlers(),
        ipc,
      ),
    ).rejects.toMatchObject({ code: "invalidConnectRequest" });
    expect(ipc.invocations).toEqual([]);
  });

  it("公共 transport 入口不再暴露 raw connect 工厂", () => {
    expect(publicTransport).toHaveProperty(
      "createConfiguredServerTransportConnector",
    );
    for (const factory of [
      "createLocalStdioTransportConnector",
      "createDirectWebSocketTransportConnector",
      "createHttpProxyWebSocketTransportConnector",
      "createSocks5ProxyWebSocketTransportConnector",
      "createSshTunnelWebSocketTransportConnector",
    ]) {
      expect(publicTransport).not.toHaveProperty(factory);
    }
  });
});
