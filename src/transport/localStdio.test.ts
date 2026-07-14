import { describe, expect, it, vi } from "vitest";

import type { JSONRPCMessage } from "../protocol/generated";
import {
  LocalStdioBridgeError,
  LocalStdioConnection,
} from "./localStdio";
import type {
  ConnectLocalStdioRequest,
  LocalStdioIpc,
  LocalStdioStatusEvent,
} from "./localStdio";

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements LocalStdioIpc {
  readonly calls: InvokeCall[] = [];
  readonly eventsBeforeConnectResponse: unknown[] = [];
  connectResponse: unknown = { connectionId: "local" };
  private eventHandler: ((event: unknown) => void) | undefined;

  createEventChannel(onMessage: (event: unknown) => void): { channel: unknown } {
    this.eventHandler = onMessage;
    return { channel: { kind: "test-channel" } };
  }

  async invoke<T>(command: string, arguments_: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, arguments: arguments_ });
    if (command === "connect_local_stdio") {
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

const request: ConnectLocalStdioRequest = {
  connectionId: "local",
  executablePath: "/usr/bin/codex",
  arguments: ["app-server"],
  workingDirectory: "/workspace",
  nonSensitiveEnvironment: { CODEX_HOME: "/workspace/.codex" },
};

const connectedEvent = {
  kind: "status",
  connectionId: "local",
  status: "connected",
  stderrBytes: 0,
  forced: false,
};

describe("LocalStdioConnection", () => {
  it("在 invoke 前安装 Channel 回调并接收连接响应前的消息", async () => {
    const ipc = new FakeIpc();
    const messages: string[] = [];
    const statuses: LocalStdioStatusEvent[] = [];
    ipc.eventsBeforeConnectResponse.push(
      connectedEvent,
      {
        kind: "protocolMessage",
        connectionId: "local",
        json: '{"id":1,"result":null}',
      },
    );

    const connection = await LocalStdioConnection.connect(
      request,
      {
        onProtocolMessage: (json) => messages.push(json),
        onStatus: (status) => statuses.push(status),
      },
      ipc,
    );

    expect(connection.connectionId).toBe("local");
    expect(messages).toEqual(['{"id":1,"result":null}']);
    expect(statuses.map(({ status }) => status)).toEqual(["connected"]);
    expect(ipc.calls[0]).toEqual({
      command: "connect_local_stdio",
      arguments: {
        request: {
          connectionId: "local",
          executablePath: "/usr/bin/codex",
          arguments: ["app-server"],
          workingDirectory: "/workspace",
          nonSensitiveEnvironment: { CODEX_HOME: "/workspace/.codex" },
        },
        events: { kind: "test-channel" },
      },
    });
  });

  it("作为 RpcWriter 发送不附加 jsonrpc 字段的单行 JSON", async () => {
    const ipc = new FakeIpc();
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await LocalStdioConnection.connect(
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
      command: "send_local_stdio_message",
      arguments: {
        request: {
          connectionId: "local",
          json:
            '{"id":"rpc:1:1","method":"initialize","params":{"capabilities":{"experimentalApi":true}}}',
        },
      },
    });
  });

  it("拒绝跨连接或畸形事件且诊断不包含原始内容", async () => {
    const ipc = new FakeIpc();
    const errors: LocalStdioBridgeError[] = [];
    const messages: string[] = [];
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    await LocalStdioConnection.connect(
      request,
      {
        onProtocolMessage: (json) => messages.push(json),
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
    await Promise.resolve();

    expect(messages).toEqual([]);
    expect(errors.map(({ code }) => code)).toEqual(["invalidConnectionEvent"]);
    expect(JSON.stringify(errors)).not.toContain("DO_NOT_REPORT");
    expect(ipc.calls.map(({ command }) => command)).toContain(
      "disconnect_local_stdio",
    );
  });

  it("终态事件关闭 writer，后续断开保持无副作用", async () => {
    const ipc = new FakeIpc();
    const statuses: LocalStdioStatusEvent[] = [];
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await LocalStdioConnection.connect(
      request,
      {
        onProtocolMessage: vi.fn(),
        onStatus: (status) => statuses.push(status),
      },
      ipc,
    );

    ipc.emit({
      kind: "status",
      connectionId: "local",
      status: "exited",
      reason: "processExited",
      exitCode: 0,
      stderrBytes: 0,
      forced: false,
    });

    await expect(connection.write({ id: 1, result: null })).rejects.toThrow(
      "not active",
    );
    expect(statuses.map(({ status }) => status)).toEqual([
      "connected",
      "exited",
    ]);
    const firstDisconnect = connection.disconnect();
    const secondDisconnect = connection.disconnect();
    await Promise.all([firstDisconnect, secondDisconnect]);
    expect(ipc.calls.map(({ command }) => command)).not.toContain(
      "disconnect_local_stdio",
    );
  });

  it("拒绝不可序列化消息和不匹配的连接响应", async () => {
    const ipc = new FakeIpc();
    const errors: LocalStdioBridgeError[] = [];
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await LocalStdioConnection.connect(
      request,
      {
        onProtocolMessage: vi.fn(),
        onStatus: vi.fn(),
        onBridgeError: (error) => errors.push(error),
      },
      ipc,
    );
    const cyclic: Record<string, unknown> = { id: 1, result: null };
    cyclic.self = cyclic;

    await expect(
      connection.write(cyclic as JSONRPCMessage),
    ).rejects.toMatchObject({ code: "invalidOutboundMessage" });

    const invalidResponseIpc = new FakeIpc();
    invalidResponseIpc.connectResponse = { connectionId: "other" };
    invalidResponseIpc.eventsBeforeConnectResponse.push(connectedEvent);
    await expect(
      LocalStdioConnection.connect(
        request,
        {
          onProtocolMessage: vi.fn(),
          onStatus: vi.fn(),
          onBridgeError: (error) => errors.push(error),
        },
        invalidResponseIpc,
      ),
    ).rejects.toMatchObject({ code: "invalidConnectResponse" });
    expect(errors.map(({ code }) => code)).toContain("invalidConnectResponse");
    expect(invalidResponseIpc.calls.map(({ command }) => command)).toContain(
      "disconnect_local_stdio",
    );
  });

  it("活动连接的重复断开只发送一次命令", async () => {
    const ipc = new FakeIpc();
    ipc.eventsBeforeConnectResponse.push(connectedEvent);
    const connection = await LocalStdioConnection.connect(
      request,
      { onProtocolMessage: vi.fn(), onStatus: vi.fn() },
      ipc,
    );

    const first = connection.disconnect();
    const second = connection.disconnect();

    expect(first).toBe(second);
    await first;
    expect(
      ipc.calls.filter(({ command }) => command === "disconnect_local_stdio"),
    ).toHaveLength(1);
  });
});
