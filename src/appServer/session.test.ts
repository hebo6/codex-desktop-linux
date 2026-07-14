import { describe, expect, it, vi } from "vitest";

import type { JSONRPCMessage } from "../protocol/generated";
import {
  RpcConnectionClosedError,
  RpcInitializationFailedError,
} from "../protocol/rpc";
import type {
  ProtocolTransport,
  ProtocolTransportEventHandlers,
} from "../transport";
import { APP_SERVER_CLIENT_INFO, AppServerSession } from "./session";
import type {
  AppServerSessionDiagnostic,
  AppServerSessionState,
} from "./session";

const INITIALIZE_RESPONSE = {
  codexHome: "/home/user/.codex",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "codex-test",
} as const;

type MessageRecord = Record<string, unknown>;

function recordOf(value: unknown): MessageRecord {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("expected a message record");
  }
  return value as MessageRecord;
}

function requestIdOf(message: JSONRPCMessage): string | number {
  const id = recordOf(message).id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new TypeError("expected a request ID");
  }
  return id;
}

function stringResult(value: unknown) {
  return typeof value === "string"
    ? ({ ok: true, value } as const)
    : ({ ok: false } as const);
}

class RecordingTransport implements ProtocolTransport {
  readonly messages: JSONRPCMessage[] = [];
  closeCalls = 0;
  handlers: ProtocolTransportEventHandlers | undefined;
  onWrite: ((message: JSONRPCMessage) => void | Promise<void>) | undefined;

  async write(message: JSONRPCMessage): Promise<void> {
    this.messages.push(message);
    await this.onWrite?.(message);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  emit(message: unknown): void {
    this.emitRaw(JSON.stringify(message));
  }

  emitRaw(json: string): void {
    if (this.handlers === undefined) {
      throw new Error("transport handlers are not attached");
    }
    this.handlers.onProtocolMessage(json);
  }

  terminate(termination?: Parameters<ProtocolTransportEventHandlers["onTransportClosed"]>[0]): void {
    if (this.handlers === undefined) {
      throw new Error("transport handlers are not attached");
    }
    this.handlers.onTransportClosed(termination);
  }

  progress(stage: Parameters<NonNullable<ProtocolTransportEventHandlers["onConnectionProgress"]>>[0]): void {
    this.handlers?.onConnectionProgress?.(stage);
  }
}

function createSessionHarness(options?: {
  readonly beforeConnect?: (transport: RecordingTransport) => void;
  readonly inboundQueueCapacity?: number;
}) {
  const transport = new RecordingTransport();
  const states: AppServerSessionState[] = [];
  const diagnostics: AppServerSessionDiagnostic[] = [];
  const session = new AppServerSession({
    connectTransport: async (handlers) => {
      transport.handlers = handlers;
      options?.beforeConnect?.(transport);
      return transport;
    },
    ...(options?.inboundQueueCapacity === undefined
      ? {}
      : { inboundQueueCapacity: options.inboundQueueCapacity }),
    onStateChange: (state) => states.push(state),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { diagnostics, session, states, transport };
}

function respondToInitialize(transport: RecordingTransport): void {
  const initialize = transport.messages.find(
    (message) => recordOf(message).method === "initialize",
  );
  if (initialize === undefined) {
    throw new Error("initialize request was not written");
  }
  transport.emit({
    id: requestIdOf(initialize),
    result: INITIALIZE_RESPONSE,
  });
}

describe("AppServerSession", () => {
  it("按到达顺序接入早期消息并完成固定初始化握手", async () => {
    const notificationOrder: string[] = [];
    const { session, states, transport } = createSessionHarness({
      beforeConnect(connectedTransport) {
        connectedTransport.emit({
          method: "serverRequest/resolved",
          params: { requestId: "early", threadId: "thread-1" },
        });
      },
    });
    session.subscribeNotifications((notification) => {
      const params = recordOf(recordOf(notification).params);
      notificationOrder.push(String(params.requestId));
    });
    transport.onWrite = (message) => {
      if (recordOf(message).method === "initialize") {
        transport.emit({
          id: requestIdOf(message),
          result: INITIALIZE_RESPONSE,
        });
      }
    };

    await expect(session.start()).resolves.toEqual(INITIALIZE_RESPONSE);

    expect(notificationOrder).toEqual(["early"]);
    expect(transport.messages).toHaveLength(2);
    expect(transport.messages[0]).toEqual({
      id: expect.any(String),
      method: "initialize",
      params: {
        clientInfo: APP_SERVER_CLIENT_INFO,
        capabilities: { experimentalApi: true },
      },
    });
    expect(transport.messages[1]).toEqual({ method: "initialized" });
    expect(JSON.stringify(transport.messages)).not.toContain("jsonrpc");
    expect(states.map(({ phase }) => phase)).toEqual([
      "connecting",
      "initializing",
      "ready",
    ]);
    expect(session.state).toEqual({
      phase: "ready",
      connectionStage: null,
      initializeResponse: INITIALIZE_RESPONSE,
      errorCode: null,
    });

    const firstClose = session.close();
    const secondClose = session.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;
    expect(transport.closeCalls).toBe(1);
    expect(session.state.phase).toBe("closed");
  });

  it("按真实传输事件报告连接阶段并在初始化完成后清空", async () => {
    const { session, states, transport } = createSessionHarness({
      beforeConnect(connectingTransport) {
        connectingTransport.progress("resolvingTarget");
        connectingTransport.progress("webSocketHandshake");
      },
    });
    transport.onWrite = (message) => {
      if (recordOf(message).method === "initialize") {
        transport.emit({ id: requestIdOf(message), result: INITIALIZE_RESPONSE });
      }
    };

    await session.start();

    expect(states.map(({ phase, connectionStage }) => [phase, connectionStage])).toEqual([
      ["connecting", null],
      ["connecting", "resolvingTarget"],
      ["connecting", "webSocketHandshake"],
      ["initializing", "appServerInitialization"],
      ["ready", null],
    ]);
  });

  it("初始化完成前有界排队业务请求并在 initialized 后按序写出", async () => {
    const { session, transport } = createSessionHarness();
    const initialization = session.start();
    await vi.waitFor(() => expect(transport.messages).toHaveLength(1));

    const business = session.sendRequest({
      method: "model/list",
      params: { limit: 10 },
      validateResult: stringResult,
    });
    expect(business.stage).toBe("queued");
    expect(transport.messages).toHaveLength(1);

    respondToInitialize(transport);
    await expect(initialization).resolves.toEqual(INITIALIZE_RESPONSE);
    await vi.waitFor(() => expect(transport.messages).toHaveLength(3));
    expect(
      transport.messages.map((message) => recordOf(message).method),
    ).toEqual(["initialize", "initialized", "model/list"]);

    transport.emit({ id: business.id, result: "done" });
    await expect(business.result).resolves.toBe("done");
    await session.close();
  });

  it("串行处理通知，异步处理器不会打乱同一传输的到达顺序", async () => {
    const { session, transport } = createSessionHarness();
    transport.onWrite = (message) => {
      if (recordOf(message).method === "initialize") {
        transport.emit({
          id: requestIdOf(message),
          result: INITIALIZE_RESPONSE,
        });
      }
    };
    await session.start();

    let releaseFirst: (() => void) | undefined;
    const firstHandled = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handled: string[] = [];
    session.subscribeNotifications(async (notification) => {
      const params = recordOf(recordOf(notification).params);
      const requestId = String(params.requestId);
      handled.push(requestId);
      if (requestId === "first") {
        await firstHandled;
      }
    });

    transport.emit({
      method: "serverRequest/resolved",
      params: { requestId: "first", threadId: "thread-1" },
    });
    transport.emit({
      method: "serverRequest/resolved",
      params: { requestId: "second", threadId: "thread-1" },
    });

    await vi.waitFor(() => expect(handled).toEqual(["first"]));
    releaseFirst?.();
    await vi.waitFor(() => expect(handled).toEqual(["first", "second"]));
    await session.close();
  });

  it("畸形传输 JSON 终止初始化且错误与诊断不泄露原始内容", async () => {
    const { diagnostics, session, transport } = createSessionHarness();
    const initialization = session.start();
    const rejection = expect(initialization).rejects.toMatchObject({
      code: "invalidTransportJson",
    });
    await vi.waitFor(() => expect(transport.messages).toHaveLength(1));

    transport.emitRaw('{"token":"DO_NOT_REPORT"');

    await rejection;
    expect(session.state).toMatchObject({
      phase: "error",
      errorCode: "invalidTransportJson",
    });
    expect(JSON.stringify({ diagnostics, state: session.state })).not.toContain(
      "DO_NOT_REPORT",
    );
    expect(transport.closeCalls).toBe(1);
    await session.close();
  });

  it("隐藏初始化远端错误正文并统一关闭已排队请求", async () => {
    const { session, transport } = createSessionHarness();
    const initialization = session.start();
    const rejectedInitialization = expect(initialization).rejects.toMatchObject(
      {
        code: "initializationRejected",
      },
    );
    await vi.waitFor(() => expect(transport.messages).toHaveLength(1));
    const business = session.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const rejectedBusiness = expect(business.result).rejects.toBeInstanceOf(
      RpcInitializationFailedError,
    );

    transport.emit({
      id: requestIdOf(transport.messages[0] as JSONRPCMessage),
      error: { code: -32602, message: "DO_NOT_REPORT" },
    });

    await rejectedInitialization;
    await rejectedBusiness;
    expect(JSON.stringify(session.state)).not.toContain("DO_NOT_REPORT");
    expect(session.state.errorCode).toBe("initializationRejected");
    expect(transport.closeCalls).toBe(1);
    await session.close();
  });

  it("传输终止时结束初始化与全部未完成请求", async () => {
    const { session, transport } = createSessionHarness();
    const initialization = session.start();
    const rejectedInitialization = expect(initialization).rejects.toMatchObject(
      {
        code: "transportClosed",
      },
    );
    await vi.waitFor(() => expect(transport.messages).toHaveLength(1));
    const business = session.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const rejectedBusiness = expect(business.result).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );

    transport.terminate();

    await rejectedInitialization;
    await rejectedBusiness;
    expect(session.state).toMatchObject({
      phase: "error",
      errorCode: "transportClosed",
    });
    expect(transport.closeCalls).toBe(1);
    await session.close();
  });

  it("保留本机进程退出诊断但不接触标准错误原文", async () => {
    const { session, transport } = createSessionHarness();
    const initialization = session.start();
    const rejectedInitialization = expect(initialization).rejects.toMatchObject({
      code: "transportClosed",
    });
    await vi.waitFor(() => expect(transport.messages).toHaveLength(1));

    transport.terminate({
      kind: "localProcess",
      status: "exited",
      reason: "processExited",
      signal: 9,
      stderrBytes: 42,
      forced: false,
    });

    await rejectedInitialization;
    expect(session.state.transportTermination).toEqual({
      kind: "localProcess",
      status: "exited",
      reason: "processExited",
      signal: 9,
      stderrBytes: 42,
      forced: false,
    });
    expect(JSON.stringify(session.state)).not.toContain("stderrSummary");
    await session.close();
  });

  it("入站积压超过上限时立即终止连接并记录安全诊断", async () => {
    const { diagnostics, session, transport } = createSessionHarness({
      inboundQueueCapacity: 1,
    });
    transport.onWrite = (message) => {
      if (recordOf(message).method === "initialize") {
        transport.emit({
          id: requestIdOf(message),
          result: INITIALIZE_RESPONSE,
        });
      }
    };
    await session.start();

    transport.emit({
      method: "serverRequest/resolved",
      params: { requestId: "first", threadId: "thread-1" },
    });
    transport.emit({
      method: "serverRequest/resolved",
      params: { requestId: "second", threadId: "thread-1" },
    });

    expect(session.state).toMatchObject({
      phase: "error",
      errorCode: "inboundQueueOverflow",
    });
    expect(diagnostics).toContainEqual({
      source: "session",
      code: "inboundQueueOverflow",
      phase: "ready",
    });
    expect(transport.closeCalls).toBe(1);
    await session.close();
  });

  it("连接建立前关闭时不发送 initialize 并完整回收迟到传输", async () => {
    const transport = new RecordingTransport();
    let attachTransport: ((transport: ProtocolTransport) => void) | undefined;
    let handlers: ProtocolTransportEventHandlers | undefined;
    const session = new AppServerSession({
      connectTransport: (nextHandlers) => {
        handlers = nextHandlers;
        return new Promise<ProtocolTransport>((resolve) => {
          attachTransport = resolve;
        });
      },
    });

    const initialization = session.start();
    const rejectedInitialization = expect(initialization).rejects.toMatchObject(
      {
        code: "sessionClosed",
      },
    );
    await vi.waitFor(() => expect(attachTransport).toBeTypeOf("function"));
    const closing = session.close();
    transport.handlers = handlers;
    attachTransport?.(transport);

    await rejectedInitialization;
    await closing;
    expect(transport.messages).toEqual([]);
    expect(transport.closeCalls).toBe(1);
    expect(session.state.phase).toBe("closed");
  });

  it("取消建立中连接失败时关闭立即失败且仍回收迟到传输", async () => {
    const transport = new RecordingTransport();
    const diagnostics: AppServerSessionDiagnostic[] = [];
    let attachTransport: ((transport: ProtocolTransport) => void) | undefined;
    const session = new AppServerSession({
      connectTransport: (handlers) => {
        transport.handlers = handlers;
        return new Promise<ProtocolTransport>((resolve) => {
          attachTransport = resolve;
        });
      },
      cancelTransportConnect: async () => {
        throw new Error("raw cancellation failure");
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const initialization = session.start();
    const rejectedInitialization = expect(initialization).rejects.toMatchObject(
      {
        code: "sessionClosed",
      },
    );
    await vi.waitFor(() => expect(attachTransport).toBeTypeOf("function"));

    await expect(session.close()).rejects.toMatchObject({
      code: "transportConnectCancelFailed",
    });
    expect(session.state.phase).toBe("closed");
    expect(diagnostics).toContainEqual({
      source: "session",
      code: "transportConnectCancelFailed",
      phase: "closing",
    });

    attachTransport?.(transport);
    await rejectedInitialization;
    await vi.waitFor(() => expect(transport.closeCalls).toBe(1));
    expect(transport.messages).toEqual([]);
  });
});
