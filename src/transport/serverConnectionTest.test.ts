import { describe, expect, it, vi } from "vitest";

import type {
  LocalStdioServerConfigurationInput,
  ProxyId,
  RemoteWebSocketServerConfigurationInput,
  ServerCredential,
  ServerId,
} from "../configuration";
import type { JSONRPCMessage } from "../protocol/generated";
import * as publicTransport from "./index";
import type { ProtocolTransportEventHandlers } from "./protocolTransport";
import {
  createServerConnectionTestTransportConnector,
  parseServerConnectionTestCommandError,
  ServerConnectionTestBridgeError,
  ServerConnectionTestCommandError,
  ServerConnectionTestConnection,
} from "./serverConnectionTest";
import type {
  ConnectServerConnectionTestRequest,
  ServerConnectionTestIpc,
  ServerConnectionTestTransport,
} from "./serverConnectionTest";

const CONNECTION_ID = "server-test-connection";
const OTHER_CONNECTION_ID = "other-test-connection";
const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const PROXY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProxyId;

interface Invocation {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements ServerConnectionTestIpc {
  readonly invocations: Invocation[] = [];
  readonly connectEvents: unknown[] = [];
  readonly commandFailures = new Map<string, unknown>();
  connectResponse: unknown;
  connectFailure: unknown;
  private eventHandler: ((event: unknown) => void) | undefined;

  constructor(connectResponse: unknown) {
    this.connectResponse = connectResponse;
  }

  createEventChannel(onMessage: (event: unknown) => void) {
    this.eventHandler = onMessage;
    return { channel: "server-test-events" };
  }

  async invoke<Result>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<Result> {
    this.invocations.push({ command, arguments: arguments_ });
    if (command === "connect_server_connection_test") {
      for (const event of this.connectEvents) {
        this.emit(event);
      }
      if (this.connectFailure !== undefined) {
        throw this.connectFailure;
      }
      return this.connectResponse as Result;
    }
    if (this.commandFailures.has(command)) {
      throw this.commandFailures.get(command);
    }
    return undefined as Result;
  }

  emit(event: unknown): void {
    if (this.eventHandler === undefined) {
      throw new Error("event channel was not created");
    }
    this.eventHandler(event);
  }
}

class PendingConnectIpc implements ServerConnectionTestIpc {
  readonly invocations: Invocation[] = [];
  cancelFailure: unknown;
  disconnectFailure: unknown;
  rejectOnCancel = true;
  private resolveConnect: ((response: unknown) => void) | undefined;
  private rejectConnect: ((reason: unknown) => void) | undefined;

  createEventChannel(): { channel: unknown } {
    return { channel: "pending-server-test-events" };
  }

  async invoke<Result>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<Result> {
    this.invocations.push({ command, arguments: arguments_ });
    if (command === "connect_server_connection_test") {
      return await new Promise<Result>((resolve, reject) => {
        this.resolveConnect = resolve as (response: unknown) => void;
        this.rejectConnect = reject;
      });
    }
    if (command === "cancel_server_connection_test") {
      if (this.cancelFailure !== undefined) {
        throw this.cancelFailure;
      }
      if (this.rejectOnCancel) {
        this.rejectConnect?.({
          code: "connectionCancelled",
          message: "backend cancellation detail",
        });
      }
      return undefined as Result;
    }
    if (
      (command === "disconnect_local_stdio" ||
        command === "disconnect_remote_websocket") &&
      this.disconnectFailure !== undefined
    ) {
      throw this.disconnectFailure;
    }
    return undefined as Result;
  }

  complete(response: unknown): void {
    this.resolveConnect?.(response);
  }
}

function localRequest(
  credentialSource: ConnectServerConnectionTestRequest["credentialSource"] = {
    type: "none",
  },
): ConnectServerConnectionTestRequest & {
  readonly configuration: LocalStdioServerConfigurationInput;
} {
  return {
    connectionId: CONNECTION_ID,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["app-server"],
      defaultWorkingDirectory: "/workspace",
      nonSensitiveEnvironment: { CODEX_MODE: "desktop" },
    },
    credentialSource,
  };
}

function remoteRequest(
  credentialSource: ConnectServerConnectionTestRequest["credentialSource"] = {
    type: "none",
  },
): ConnectServerConnectionTestRequest & {
  readonly configuration: RemoteWebSocketServerConfigurationInput;
} {
  return {
    connectionId: CONNECTION_ID,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app",
      authentication: credentialSource.type === "provided" ? "bearer" : "none",
      nonSensitiveHeaders: { "X-Codex-Client": "desktop" },
      connectTimeoutMs: 10_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialSource,
  };
}

function localResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    connectionId: CONNECTION_ID,
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
    transport: "remoteWebSocket",
    connectionPath: "direct",
    ...overrides,
  };
}

function localEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { transport: "localStdio", event };
}

function remoteEvent(event: Record<string, unknown>): Record<string, unknown> {
  return { transport: "remoteWebSocket", event };
}

function connectedLocalEvent(connectionId = CONNECTION_ID): unknown {
  return localEvent({
    kind: "status",
    connectionId,
    status: "connected",
    stderrBytes: 0,
    forced: false,
  });
}

function connectedRemoteEvent(connectionId = CONNECTION_ID): unknown {
  return remoteEvent({
    kind: "status",
    connectionId,
    status: "connected",
    forced: false,
  });
}

function handlers() {
  return {
    onProtocolMessage: vi.fn<(json: string) => void>(),
    onTransportClosed: vi.fn<() => void>(),
    onTransportFailure: vi.fn<() => void>(),
  } satisfies ProtocolTransportEventHandlers;
}

describe("ServerConnectionTestConnection", () => {
  it("从公共传输入口导出独立测试连接边界", () => {
    expect(publicTransport.ServerConnectionTestConnection).toBe(
      ServerConnectionTestConnection,
    );
    expect(publicTransport.createServerConnectionTestTransportConnector).toBe(
      createServerConnectionTestTransportConnector,
    );
  });

  it("只转发规范化草稿和凭据快照并交付早到的本机事件", async () => {
    const credential: ServerCredential = {
      type: "sensitiveEnvironment",
      values: { CODEX_API_TOKEN: "draft-secret" },
    };
    const baseRequest = localRequest({ type: "provided", credential });
    const request = {
      ...baseRequest,
      ignored: "not-forwarded",
    } as typeof baseRequest & { ignored: string };
    const mutableArguments = baseRequest.configuration.arguments as string[];
    const mutableEnvironment = baseRequest.configuration
      .nonSensitiveEnvironment as Record<string, string>;
    const mutableSecrets = credential.values as Record<string, string>;
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

    const connector = createServerConnectionTestTransportConnector(
      request,
      ipc,
    );
    mutableArguments[0] = "rewritten";
    mutableEnvironment.CODEX_MODE = "rewritten";
    mutableSecrets.CODEX_API_TOKEN = "rewritten-secret";

    const connection = await connector(eventHandlers);

    expect(ipc.invocations[0]).toEqual({
      command: "connect_server_connection_test",
      arguments: {
        request: {
          connectionId: CONNECTION_ID,
          configuration: {
            type: "localStdio",
            executablePath: "/usr/bin/codex",
            arguments: ["app-server"],
            defaultWorkingDirectory: "/workspace",
            nonSensitiveEnvironment: { CODEX_MODE: "desktop" },
          },
          credentialSource: {
            type: "provided",
            credential: {
              type: "sensitiveEnvironment",
              values: { CODEX_API_TOKEN: "draft-secret" },
            },
          },
        },
        events: "server-test-events",
      },
    });
    expect(eventHandlers.onProtocolMessage).toHaveBeenCalledWith(
      '{"method":"ready"}',
    );
    expect(
      (connection as ServerConnectionTestTransport).connectionInfo,
    ).toEqual(localResponse());

    await connection.write({ method: "initialized" } as JSONRPCMessage);
    await connection.close();
    await connection.close();
    expect(ipc.invocations.slice(1)).toEqual([
      {
        command: "send_local_stdio_message",
        arguments: {
          request: {
            connectionId: CONNECTION_ID,
            json: '{"method":"initialized"}',
          },
        },
      },
      {
        command: "disconnect_local_stdio",
        arguments: { request: { connectionId: CONNECTION_ID } },
      },
    ]);
  });

  it("转发带版本的已存凭据来源并严格保留代理响应", async () => {
    const baseRequest = remoteRequest({
      type: "stored",
      serverId: SERVER_ID,
      expectedVersion: 7,
    });
    const request: ConnectServerConnectionTestRequest = {
      ...baseRequest,
      configuration: {
        ...baseRequest.configuration,
        authentication: "bearer",
        proxyId: PROXY_ID,
      },
    };
    const ipc = new FakeIpc(
      remoteResponse({
        connectionPath: "sshDirectTcpip",
        proxyId: PROXY_ID,
        proxyVersion: 5,
      }),
    );
    ipc.connectEvents.push(connectedRemoteEvent());

    const connection = await ServerConnectionTestConnection.connect(
      request,
      handlers(),
      ipc,
    );

    expect(
      (ipc.invocations[0]?.arguments.request as Record<string, unknown>)
        .credentialSource,
    ).toEqual({
      type: "stored",
      serverId: SERVER_ID,
      expectedVersion: 7,
    });
    expect(connection.connectionInfo).toEqual({
      connectionId: CONNECTION_ID,
      transport: "remoteWebSocket",
      connectionPath: "sshDirectTcpip",
      proxyId: PROXY_ID,
      proxyVersion: 5,
    });

    await connection.close();
    expect(ipc.invocations.at(-1)).toEqual({
      command: "disconnect_remote_websocket",
      arguments: { request: { connectionId: CONNECTION_ID } },
    });
  });

  it("拒绝与请求 connectionId 不一致或带未知字段的响应并清理传输", async () => {
    for (const response of [
      remoteResponse({ connectionId: OTHER_CONNECTION_ID }),
      remoteResponse({ diagnostic: "must-not-cross-boundary" }),
      remoteResponse({
        connectionPath: "httpConnect",
        proxyId: PROXY_ID,
      }),
    ]) {
      const ipc = new FakeIpc(response);
      const eventHandlers = handlers();

      await expect(
        ServerConnectionTestConnection.connect(
          remoteRequest(),
          eventHandlers,
          ipc,
        ),
      ).rejects.toEqual(
        new ServerConnectionTestBridgeError("invalidConnectResponse"),
      );
      expect(eventHandlers.onTransportFailure).toHaveBeenCalledOnce();
      expect(ipc.invocations.at(-1)).toEqual({
        command: "disconnect_remote_websocket",
        arguments: { request: { connectionId: CONNECTION_ID } },
      });
    }
  });

  it("响应无法提供可信 transport 时仍按草稿类型清理已建立连接", async () => {
    for (const response of [
      {
        connectionId: CONNECTION_ID,
        connectionPath: "localStdio",
      },
      remoteResponse(),
    ]) {
      const ipc = new FakeIpc(response);

      await expect(
        ServerConnectionTestConnection.connect(localRequest(), handlers(), ipc),
      ).rejects.toEqual(
        new ServerConnectionTestBridgeError("invalidConnectResponse"),
      );
      expect(ipc.invocations.at(-1)).toEqual({
        command: "disconnect_local_stdio",
        arguments: { request: { connectionId: CONNECTION_ID } },
      });
    }
  });

  it("异常响应后的清理失败优先报告稳定的清理错误", async () => {
    const ipc = new FakeIpc(remoteResponse({ diagnostic: "invalid" }));
    ipc.commandFailures.set(
      "disconnect_remote_websocket",
      new Error("DO_NOT_REPORT cleanup detail"),
    );

    await expect(
      ServerConnectionTestConnection.connect(remoteRequest(), handlers(), ipc),
    ).rejects.toEqual(
      new ServerConnectionTestBridgeError("connectionCancellationFailed"),
    );
  });

  it("拒绝 connectionId 不一致和 envelope 扩展的事件", async () => {
    for (const event of [
      connectedRemoteEvent(OTHER_CONNECTION_ID),
      {
        ...(connectedRemoteEvent() as Record<string, unknown>),
        serverId: SERVER_ID,
      },
    ]) {
      const ipc = new FakeIpc(remoteResponse());
      const eventHandlers = handlers();
      ipc.connectEvents.push(event);

      await expect(
        ServerConnectionTestConnection.connect(
          remoteRequest(),
          eventHandlers,
          ipc,
        ),
      ).rejects.toEqual(
        new ServerConnectionTestBridgeError("invalidConnectionEvent"),
      );
      expect(eventHandlers.onTransportFailure).toHaveBeenCalledOnce();
      expect(ipc.invocations.at(-1)?.command).toBe(
        "disconnect_remote_websocket",
      );
    }
  });

  it("事件处理器失败时报告稳定桥接错误并关闭连接", async () => {
    const ipc = new FakeIpc(localResponse());
    const eventHandlers = handlers();
    eventHandlers.onProtocolMessage.mockImplementation(() => {
      throw new Error("consumer secret");
    });
    ipc.connectEvents.push(
      connectedLocalEvent(),
      localEvent({
        kind: "protocolMessage",
        connectionId: CONNECTION_ID,
        json: '{"method":"ready"}',
      }),
    );

    await expect(
      ServerConnectionTestConnection.connect(
        localRequest(),
        eventHandlers,
        ipc,
      ),
    ).rejects.toEqual(
      new ServerConnectionTestBridgeError("eventHandlerFailed"),
    );
    expect(ipc.invocations.at(-1)?.command).toBe("disconnect_local_stdio");
  });

  it("校验草稿和凭据类型且不把无关字段带入 IPC", async () => {
    expect(() =>
      createServerConnectionTestTransportConnector({
        ...localRequest(),
        connectionId: "Invalid_ID",
      }),
    ).toThrow(new ServerConnectionTestBridgeError("invalidConnectRequest"));

    expect(() =>
      createServerConnectionTestTransportConnector(
        localRequest({
          type: "provided",
          credential: { type: "bearerToken", value: "secret" },
        }),
      ),
    ).toThrow(new ServerConnectionTestBridgeError("invalidConnectRequest"));

    expect(() =>
      createServerConnectionTestTransportConnector(
        remoteRequest({
          type: "stored",
          serverId: SERVER_ID,
          expectedVersion: 0,
        }),
      ),
    ).toThrow(new ServerConnectionTestBridgeError("invalidConnectRequest"));
  });

  it("将已知后端错误映射为本地稳定结构且不暴露原始消息", async () => {
    const ipc = new FakeIpc(remoteResponse());
    ipc.connectFailure = {
      code: "networkConnectFailed",
      message: "secret endpoint and token detail",
    };

    let failure: unknown;
    try {
      await ServerConnectionTestConnection.connect(
        remoteRequest(),
        handlers(),
        ipc,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toEqual(
      new ServerConnectionTestCommandError("networkConnectFailed"),
    );
    expect(String(failure)).not.toMatch(/secret endpoint|token detail/u);
  });

  it("写入和生命周期关闭也不暴露原始 IPC 错误", async () => {
    const ipc = new FakeIpc(localResponse());
    ipc.connectEvents.push(connectedLocalEvent());
    const connection = await ServerConnectionTestConnection.connect(
      localRequest(),
      handlers(),
      ipc,
    );
    ipc.commandFailures.set("send_local_stdio_message", {
      code: "protocolWriteFailed",
      message: "secret write detail",
    });

    await expect(
      connection.write({ method: "initialized" } as JSONRPCMessage),
    ).rejects.toEqual(
      new ServerConnectionTestCommandError("protocolWriteFailed"),
    );

    ipc.commandFailures.set(
      "disconnect_local_stdio",
      new Error("secret disconnect detail"),
    );
    await expect(connection.close()).rejects.toEqual(
      new ServerConnectionTestCommandError("connectionTestFailed"),
    );
  });

  it("将未知或扩展的后端错误收敛为通用脱敏错误", () => {
    for (const failure of [
      new Error("secret backend stack"),
      { code: "futureSecretError", message: "secret backend detail" },
      {
        code: "networkConnectFailed",
        message: "safe static message",
        internal: "secret backend detail",
      },
    ]) {
      const parsed = parseServerConnectionTestCommandError(failure);

      expect(parsed).toEqual(
        new ServerConnectionTestCommandError("connectionTestFailed"),
      );
      expect(String(parsed)).not.toMatch(/secret|futureSecretError/u);
    }
  });

  it("只保留严格校验后的 HTTP 状态和 SSH 主机密钥详情", () => {
    const fingerprint = `SHA256:${"A".repeat(43)}`;
    expect(
      parseServerConnectionTestCommandError({
        code: "httpProxyConnectRejected",
        message: "ignored backend text",
        statusCode: 407,
      }),
    ).toEqual(
      new ServerConnectionTestCommandError("httpProxyConnectRejected", {
        statusCode: 407,
      }),
    );
    expect(
      parseServerConnectionTestCommandError({
        code: "sshHostKeyUnknown",
        message: "ignored backend text",
        details: {
          kind: "sshHostKeyUnknown",
          host: "ssh.example.test",
          port: 22,
          received: {
            algorithm: "ssh-ed25519",
            sha256Fingerprint: fingerprint,
          },
        },
      }),
    ).toEqual(
      new ServerConnectionTestCommandError("sshHostKeyUnknown", {
        details: {
          kind: "sshHostKeyUnknown",
          host: "ssh.example.test",
          port: 22,
          received: {
            algorithm: "ssh-ed25519",
            sha256Fingerprint: fingerprint,
          },
        },
      }),
    );
    expect(
      parseServerConnectionTestCommandError({
        code: "sshHostKeyUnknown",
        message: "ignored backend text",
        details: {
          kind: "sshHostKeyUnknown",
          host: "ssh.example.test",
          port: 22,
          received: {
            algorithm: "ssh-ed25519",
            sha256Fingerprint: "not-a-fingerprint",
          },
        },
      }).code,
    ).toBe("connectionTestFailed");
  });
});

describe("createServerConnectionTestTransportConnector", () => {
  it("连接启动前取消时不创建 IPC reservation", async () => {
    const ipc = new PendingConnectIpc();
    const connector = createServerConnectionTestTransportConnector(
      localRequest(),
      ipc,
    );

    await connector.cancelPending();

    await expect(connector(handlers())).rejects.toEqual(
      new ServerConnectionTestBridgeError("connectionCancelled"),
    );
    expect(ipc.invocations).toEqual([]);
  });

  it("按 connectionId 取消建立中的测试且并发取消只发送一次", async () => {
    const ipc = new PendingConnectIpc();
    const connector = createServerConnectionTestTransportConnector(
      localRequest(),
      ipc,
    );
    const connecting = connector(handlers()).catch((error: unknown) => error);

    await Promise.all([connector.cancelPending(), connector.cancelPending()]);

    expect(await connecting).toEqual(
      new ServerConnectionTestBridgeError("connectionCancelled"),
    );
    expect(ipc.invocations).toEqual([
      {
        command: "connect_server_connection_test",
        arguments: {
          request: localRequest(),
          events: "pending-server-test-events",
        },
      },
      {
        command: "cancel_server_connection_test",
        arguments: { request: { connectionId: CONNECTION_ID } },
      },
    ]);
  });

  it("取消与成功响应竞态时关闭已建立传输且不返回给调用方", async () => {
    const ipc = new PendingConnectIpc();
    ipc.rejectOnCancel = false;
    const connector = createServerConnectionTestTransportConnector(
      localRequest(),
      ipc,
    );
    const connecting = connector(handlers()).catch((error: unknown) => error);

    await connector.cancelPending();
    ipc.complete(localResponse());

    expect(await connecting).toEqual(
      new ServerConnectionTestBridgeError("connectionCancelled"),
    );
    expect(ipc.invocations.map(({ command }) => command)).toEqual([
      "connect_server_connection_test",
      "cancel_server_connection_test",
      "disconnect_local_stdio",
    ]);
  });

  it("取消成功响应竞态中的连接清理失败时不得报告取消成功", async () => {
    const ipc = new PendingConnectIpc();
    ipc.rejectOnCancel = false;
    ipc.disconnectFailure = new Error("DO_NOT_REPORT disconnect detail");
    const connector = createServerConnectionTestTransportConnector(
      localRequest(),
      ipc,
    );
    const connecting = connector(handlers()).catch((error: unknown) => error);

    await connector.cancelPending();
    ipc.complete(localResponse());

    expect(await connecting).toEqual(
      new ServerConnectionTestBridgeError("connectionCancellationFailed"),
    );
    expect(String(await connecting)).not.toContain("DO_NOT_REPORT");
  });

  it("取消命令失败时只暴露稳定桥接错误", async () => {
    const ipc = new PendingConnectIpc();
    ipc.cancelFailure = new Error("secret cancellation failure");
    const connector = createServerConnectionTestTransportConnector(
      remoteRequest(),
      ipc,
    );
    const connecting = connector(handlers()).catch(() => undefined);

    await expect(connector.cancelPending()).rejects.toEqual(
      new ServerConnectionTestBridgeError("connectionCancellationFailed"),
    );
    ipc.complete(remoteResponse());
    await connecting;
  });

  it("连接器为单次生命周期且完成后的取消不影响已返回连接", async () => {
    const ipc = new FakeIpc(localResponse());
    ipc.connectEvents.push(connectedLocalEvent());
    const connector = createServerConnectionTestTransportConnector(
      localRequest(),
      ipc,
    );

    const connection = await connector(handlers());
    await connector.cancelPending();
    await expect(connector(handlers())).rejects.toEqual(
      new ServerConnectionTestBridgeError("invalidConnectRequest"),
    );
    expect(
      ipc.invocations.some(
        ({ command }) => command === "cancel_server_connection_test",
      ),
    ).toBe(false);

    await connection.close();
  });

  it("转发未持久化代理草稿并接受无持久化标识的代理响应", async () => {
    const request: ConnectServerConnectionTestRequest = {
      ...remoteRequest(),
      proxy: {
        configuration: {
          type: "httpConnect",
          url: "http://proxy.example.test:8080",
          authentication: "basic",
          username: "draft-user",
          connectTimeoutMs: 5_000,
          tlsCertificatePolicy: "strict",
        },
        credentialSource: {
          type: "provided",
          credential: { type: "httpBasicPassword", value: "draft-secret" },
        },
      },
    };
    const ipc = new FakeIpc(remoteResponse({ connectionPath: "httpConnect" }));
    ipc.connectEvents.push(connectedRemoteEvent());

    const connection = await ServerConnectionTestConnection.connect(
      request,
      handlers(),
      ipc,
    );

    expect(
      (ipc.invocations[0]?.arguments.request as Record<string, unknown>).proxy,
    ).toEqual(expect.objectContaining({
      credentialSource: request.proxy?.credentialSource,
      configuration: expect.objectContaining({
        ...request.proxy?.configuration,
        nonSensitiveHeaders: {},
      }),
    }));
    expect(connection.connectionInfo).toEqual({
      connectionId: CONNECTION_ID,
      transport: "remoteWebSocket",
      connectionPath: "httpConnect",
    });
    await connection.close();
  });
});
