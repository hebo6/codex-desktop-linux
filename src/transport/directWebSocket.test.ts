import { describe, expect, it, vi } from "vitest";

import type { JSONRPCMessage } from "../protocol/generated";
import {
  DirectWebSocketBridgeError,
  DirectWebSocketConnection,
  createDirectWebSocketTransportConnector,
} from "./directWebSocket";
import type {
  ConnectDirectWebSocketRequest,
  DirectWebSocketIpc,
  DirectWebSocketStatusEvent,
} from "./directWebSocket";
import type { ProtocolTransportEventHandlers } from "./protocolTransport";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements DirectWebSocketIpc {
  readonly calls: InvokeCall[] = [];
  readonly eventsBeforeConnectResponse: unknown[] = [];
  connectResponse: unknown = { connectionId: "remote" };
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): { channel: unknown } {
    this.eventHandler = onMessage;
    return { channel: { kind: "test-channel" } };
  }

  async invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_direct_websocket") {
      if (this.eventHandler === undefined) {
        throw new Error("event handler must be installed before connect");
      }
      for (const event of this.eventsBeforeConnectResponse) {
        this.eventHandler(event);
      }
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

const request: ConnectDirectWebSocketRequest = {
  connectionId: "remote",
  url: "wss://codex.example.test/app?workspace=demo",
  insecureTransportConfirmed: false,
  connectTimeoutMs: 10_000,
  nonSensitiveHeaders: { "X-Client-Mode": "desktop" },
};

const connectedEvent = {
  kind: "status",
  connectionId: "remote",
  status: "connected",
  forced: false,
};

describe("DirectWebSocketConnection", () => {
  it("在 invoke 前安装 Channel 回调并完整传递非敏感连接参数", async () => {
    const ipc = new FakeIpc();
    const messages: string[] = [];
    const statuses: DirectWebSocketStatusEvent[] = [];
    const stages: string[] = [];
    ipc.eventsBeforeConnectResponse.push(
      {
        kind: "progress",
        connectionId: "remote",
        stage: "webSocketHandshake",
      },
      connectedEvent,
      {
        kind: "protocolMessage",
        connectionId: "remote",
        json: '{"id":1,"result":null}',
      },
    );

    const connection = await DirectWebSocketConnection.connect(
      request,
      {
        onProtocolMessage: (json) => messages.push(json),
        onProgress: ({ stage }) => stages.push(stage),
        onStatus: (status) => statuses.push(status),
      },
      ipc,
    );

    expect(connection.connectionId).toBe("remote");
    expect(messages).toEqual(['{"id":1,"result":null}']);
    expect(stages).toEqual(["webSocketHandshake"]);
    expect(statuses.map(({ status }) => status)).toEqual(["connected"]);
    expect(ipc.calls[0]).toEqual({
      command: "connect_direct_websocket",
      arguments: {
        request: {
          connectionId: "remote",
          url: "wss://codex.example.test/app?workspace=demo",
          insecureTransportConfirmed: false,
          connectTimeoutMs: 10_000,
          nonSensitiveHeaders: { "X-Client-Mode": "desktop" },
        },
        events: { kind: "test-channel" },
      },
    });
  });

  it("作为 ProtocolTransport 发送无 jsonrpc 包装的文本 JSON", async () => {
    const ipc = new FakeIpc();
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await DirectWebSocketConnection.connect(
      request,
      { onProtocolMessage: vi.fn(), onStatus: vi.fn() },
      ipc,
    );

    await connection.write({
      id: "rpc:1:1",
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });

    expect(ipc.calls[1]).toEqual({
      command: "send_remote_websocket_message",
      arguments: {
        request: {
          connectionId: "remote",
          json:
            '{"id":"rpc:1:1","method":"initialize","params":{"capabilities":{"experimentalApi":true}}}',
        },
      },
    });
  });

  it("拒绝跨连接和畸形状态事件且诊断不包含原始内容", async () => {
    const ipc = new FakeIpc();
    const errors: DirectWebSocketBridgeError[] = [];
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    await DirectWebSocketConnection.connect(
      request,
      {
        onProtocolMessage: vi.fn(),
        onStatus: vi.fn(),
        onBridgeError: (error) => errors.push(error),
      },
      ipc,
    );

    ipc.emit({
      kind: "protocolMessage",
      connectionId: "other",
      json: '{"token":"DO_NOT_REPORT"}',
    });
    ipc.emit({
      kind: "progress",
      connectionId: "remote",
      stage: "unknownNetworkStage",
    });
    ipc.emit({
      kind: "status",
      connectionId: "remote",
      status: "connected",
      reason: "remoteClosed",
      closeCode: 1000,
      forced: false,
    });
    await Promise.resolve();

    expect(errors.map(({ code }) => code)).toEqual([
      "invalidConnectionEvent",
      "invalidConnectionEvent",
      "invalidConnectionEvent",
    ]);
    expect(JSON.stringify(errors)).not.toContain("DO_NOT_REPORT");
    expect(ipc.calls.map(({ command }) => command)).toContain(
      "disconnect_remote_websocket",
    );
  });

  it("终态关闭 writer，远端关闭码只接受受限整数", async () => {
    const ipc = new FakeIpc();
    const statuses: DirectWebSocketStatusEvent[] = [];
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await DirectWebSocketConnection.connect(
      request,
      {
        onProtocolMessage: vi.fn(),
        onStatus: (status) => statuses.push(status),
      },
      ipc,
    );
    ipc.emit({
      kind: "status",
      connectionId: "remote",
      status: "disconnected",
      reason: "remoteClosed",
      closeCode: 1000,
      forced: false,
    });

    await expect(connection.write({ id: 1, result: null })).rejects.toThrow(
      "not active",
    );
    expect(statuses.at(-1)).toMatchObject({
      status: "disconnected",
      reason: "remoteClosed",
      closeCode: 1000,
    });
    await connection.close();
    expect(ipc.calls.map(({ command }) => command)).not.toContain(
      "disconnect_remote_websocket",
    );
  });

  it("拒绝不可序列化消息和带额外字段的连接响应", async () => {
    const ipc = new FakeIpc();
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await DirectWebSocketConnection.connect(
      request,
      { onProtocolMessage: vi.fn(), onStatus: vi.fn() },
      ipc,
    );
    const cyclic: Record<string, unknown> = { id: 1, result: null };
    cyclic.self = cyclic;
    await expect(
      connection.write(cyclic as JSONRPCMessage),
    ).rejects.toMatchObject({ code: "invalidOutboundMessage" });

    const invalidResponseIpc = new FakeIpc();
    invalidResponseIpc.connectResponse = {
      connectionId: "remote",
      token: "DO_NOT_REPORT",
    };
    invalidResponseIpc.eventsBeforeConnectResponse.push(connectedEvent);
    await expect(
      DirectWebSocketConnection.connect(
        request,
        { onProtocolMessage: vi.fn(), onStatus: vi.fn() },
        invalidResponseIpc,
      ),
    ).rejects.toMatchObject({ code: "invalidConnectResponse" });
  });

  it("适配器把终态和桥接错误映射为传输生命周期事件", async () => {
    const ipc = new FakeIpc();
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const handlers: ProtocolTransportEventHandlers = {
      onProtocolMessage: vi.fn(),
      onTransportClosed: vi.fn(),
      onTransportFailure: vi.fn(),
    };
    const transport = await createDirectWebSocketTransportConnector(request, ipc)(
      handlers,
    );

    ipc.emit({
      kind: "status",
      connectionId: "remote",
      status: "error",
      reason: "readFailed",
      forced: true,
    });
    expect(handlers.onTransportClosed).toHaveBeenCalledOnce();
    expect(handlers.onTransportFailure).not.toHaveBeenCalled();
    await transport.close();
  });
});
