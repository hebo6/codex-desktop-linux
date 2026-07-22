import { describe, expect, it } from "vitest";

import type {
  InitializeResponse,
  JSONRPCMessage,
  ServerNotification,
  ServerRequest,
} from "../generated";
import {
  RpcConnectionClosedError,
  RpcConnectionError,
  RpcInitializationFailedError,
  RpcInitializationStateError,
  RpcInvalidResultError,
  RpcQueueCapacityError,
  RpcRemoteError,
  RpcRouter,
  RpcWriteError,
} from ".";
import type {
  MethodValidationResult,
  ProtocolBoundary,
  RpcDiagnostic,
  RpcWriter,
  ValidationResult,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "codex-desktop-linux",
    title: "Codex Desktop Linux",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: false,
    optOutNotificationMethods: ["unused/notification"],
  },
};

const INITIALIZE_RESPONSE: InitializeResponse = {
  codexHome: "/home/user/.codex",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "codex-test",
};

const SAFE_INITIALIZE_FAILURE = {
  code: "invalid_params",
  stage: "params",
  summary: "initialize 响应校验失败（原始内容已隐藏）",
} as const;

const SAFE_UNKNOWN_METHOD = {
  code: "unknown_method",
  stage: "method",
  summary: "未知方法（方法名已隐藏）",
} as const;

const SAFE_INVALID_PARAMS = {
  code: "invalid_params",
  stage: "params",
  summary: "参数校验失败（原始内容已隐藏）",
} as const;

function recordOf(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function requestIdAt(writer: RecordingWriter, index: number): string | number {
  const id = recordOf(writer.messages[index])?.id;
  if (!isRequestId(id)) {
    throw new Error(`Message ${index} does not contain a request ID`);
  }
  return id;
}

class StrictBoundary implements ProtocolBoundary {
  validateMessage(value: unknown): ValidationResult<JSONRPCMessage> {
    const record = recordOf(value);
    if (record === null) {
      return {
        ok: false,
        error: {
          code: "invalid_envelope",
          stage: "envelope",
          summary: "JSON-RPC envelope 校验失败（原始内容已隐藏）",
        },
      };
    }

    if (typeof record.method === "string") {
      if (hasOwn(record, "id") && !isRequestId(record.id)) {
        return { ok: false };
      }
      return { ok: true, value: record as JSONRPCMessage };
    }

    if (!isRequestId(record.id)) {
      return { ok: false };
    }
    if (hasOwn(record, "result") && !hasOwn(record, "error")) {
      return { ok: true, value: record as JSONRPCMessage };
    }

    const error = recordOf(record.error);
    if (
      error !== null &&
      typeof error.code === "number" &&
      typeof error.message === "string" &&
      !hasOwn(record, "result")
    ) {
      return { ok: true, value: record as JSONRPCMessage };
    }
    return { ok: false };
  }

  validateInitializeResponse(value: unknown): ValidationResult<InitializeResponse> {
    const record = recordOf(value);
    if (
      record === null ||
      typeof record.codexHome !== "string" ||
      typeof record.platformFamily !== "string" ||
      typeof record.platformOs !== "string" ||
      typeof record.userAgent !== "string"
    ) {
      return { ok: false, error: SAFE_INITIALIZE_FAILURE };
    }
    return { ok: true, value: record as InitializeResponse };
  }

  validateServerNotification(
    message: JSONRPCMessage,
  ): MethodValidationResult<ServerNotification> {
    const record = recordOf(message);
    if (record?.method !== "serverRequest/resolved") {
      return { kind: "unknown_method", validation: SAFE_UNKNOWN_METHOD };
    }

    const params = recordOf(record.params);
    if (
      params === null ||
      !isRequestId(params.requestId) ||
      typeof params.threadId !== "string"
    ) {
      return { kind: "invalid_params", validation: SAFE_INVALID_PARAMS };
    }
    return { kind: "valid", value: message as ServerNotification };
  }

  validateServerRequest(
    message: JSONRPCMessage,
  ): MethodValidationResult<ServerRequest> {
    const record = recordOf(message);
    if (record?.method !== "currentTime/read") {
      return { kind: "unknown_method", validation: SAFE_UNKNOWN_METHOD };
    }

    const params = recordOf(record.params);
    if (params === null || typeof params.threadId !== "string") {
      return { kind: "invalid_params", validation: SAFE_INVALID_PARAMS };
    }
    return { kind: "valid", value: message as ServerRequest };
  }
}

class RecordingWriter implements RpcWriter {
  readonly messages: JSONRPCMessage[] = [];

  async write(message: JSONRPCMessage): Promise<void> {
    this.messages.push(message);
  }
}

interface DeferredWrite {
  readonly resolve: () => void;
  readonly reject: () => void;
}

class ControlledWriter extends RecordingWriter {
  private readonly writes: DeferredWrite[] = [];

  override write(message: JSONRPCMessage): Promise<void> {
    this.messages.push(message);
    return new Promise<void>((resolve, reject) => {
      this.writes.push({ resolve, reject: () => reject(new Error("write failed")) });
    });
  }

  resolveNext(): void {
    const write = this.writes.shift();
    if (write === undefined) {
      throw new Error("No pending write");
    }
    write.resolve();
  }

  rejectNext(): void {
    const write = this.writes.shift();
    if (write === undefined) {
      throw new Error("No pending write");
    }
    write.reject();
  }
}

class ServerResponseFailingWriter extends RecordingWriter {
  failServerResponses = false;

  override async write(message: JSONRPCMessage): Promise<void> {
    this.messages.push(message);
    const record = recordOf(message);
    if (
      this.failServerResponses &&
      record !== null &&
      (hasOwn(record, "result") || hasOwn(record, "error"))
    ) {
      throw new Error("server response write failed");
    }
  }
}

function stringResult(value: unknown): ValidationResult<string> {
  return typeof value === "string"
    ? { ok: true, value }
    : { ok: false };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function establishConnection(
  router: RpcRouter,
  writer: RecordingWriter,
  epoch: number,
): Promise<void> {
  const initialization = router.initialize(INITIALIZE_PARAMS);
  await flushMicrotasks();
  await router.handleIncoming(epoch, {
    id: requestIdAt(writer, 0),
    result: INITIALIZE_RESPONSE,
  });
  await expect(initialization).resolves.toEqual(INITIALIZE_RESPONSE);
}

async function establishControlledConnection(
  router: RpcRouter,
  writer: ControlledWriter,
  epoch: number,
): Promise<void> {
  const initialization = router.initialize(INITIALIZE_PARAMS);
  writer.resolveNext();
  await flushMicrotasks();
  const incoming = router.handleIncoming(epoch, {
    id: requestIdAt(writer, 0),
    result: INITIALIZE_RESPONSE,
  });
  writer.resolveNext();
  await incoming;
  await expect(initialization).resolves.toEqual(INITIALIZE_RESPONSE);
}

describe("RpcRouter 初始化状态机", () => {
  it("固定握手契约并拒绝错误调用顺序和调用方旁路", async () => {
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });

    expect(() => router.initialize(INITIALIZE_PARAMS)).toThrow(RpcConnectionError);
    const writer = new RecordingWriter();
    const epoch = router.open(writer);
    await expect(router.sendNotification(epoch, "thread/changed")).rejects.toBeInstanceOf(
      RpcInitializationStateError,
    );
    expect(() =>
      router.sendRequest({
        method: "initialize",
        params: INITIALIZE_PARAMS,
        validateResult: stringResult,
      }),
    ).toThrow(RpcInitializationStateError);

    const initialization = router.initialize(INITIALIZE_PARAMS);
    expect(() => router.initialize(INITIALIZE_PARAMS)).toThrow(
      RpcInitializationStateError,
    );
    await flushMicrotasks();
    expect(writer.messages[0]).toMatchObject({
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["unused/notification"],
        },
      },
    });

    await router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      result: INITIALIZE_RESPONSE,
    });
    await expect(initialization).resolves.toEqual(INITIALIZE_RESPONSE);
    expect(writer.messages[1]).toEqual({ method: "initialized" });
    expect(() => router.initialize(INITIALIZE_PARAMS)).toThrow(
      RpcInitializationStateError,
    );
    await expect(router.sendNotification(epoch, "initialized")).rejects.toBeInstanceOf(
      RpcInitializationStateError,
    );
  });

  it("initialized 成功写出前业务请求保持有界 FIFO 队列", async () => {
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 2,
    });
    const epoch = router.open(writer);
    const first = router.sendRequest({
      method: "first/read",
      params: { private: "first body" },
      validateResult: stringResult,
    });
    const second = router.sendRequest({
      method: "second/read",
      validateResult: stringResult,
    });
    const initialization = router.initialize(INITIALIZE_PARAMS);

    expect(first.stage).toBe("queued");
    expect(second.stage).toBe("queued");
    expect(writer.messages.map((message) => recordOf(message)?.method)).toEqual([
      "initialize",
    ]);

    writer.resolveNext();
    await flushMicrotasks();
    const incoming = router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      result: INITIALIZE_RESPONSE,
    });
    await flushMicrotasks();
    expect(writer.messages.map((message) => recordOf(message)?.method)).toEqual([
      "initialize",
      "initialized",
    ]);
    expect(first.stage).toBe("queued");
    expect(second.stage).toBe("queued");

    writer.resolveNext();
    await flushMicrotasks();
    await expect(initialization).resolves.toEqual(INITIALIZE_RESPONSE);
    expect(first.stage).toBe("writing");
    expect(second.stage).toBe("queued");

    writer.resolveNext();
    await flushMicrotasks();
    expect(first.stage).toBe("pending");
    expect(second.stage).toBe("writing");
    expect(writer.messages.map((message) => recordOf(message)?.method)).toEqual([
      "initialize",
      "initialized",
      "first/read",
      "second/read",
    ]);

    writer.resolveNext();
    await incoming;
    expect(second.stage).toBe("pending");
    await router.handleIncoming(epoch, { id: first.id, result: "one" });
    await router.handleIncoming(epoch, { id: second.id, result: "two" });
    await expect(first.result).resolves.toBe("one");
    await expect(second.result).resolves.toBe("two");
  });

  it("初始化前队列达到上限时立即拒绝新增业务请求", async () => {
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const epoch = router.open(new RecordingWriter());
    const queued = router.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });

    expect(() =>
      router.sendRequest({
        method: "model/list",
        validateResult: stringResult,
      }),
    ).toThrow(RpcQueueCapacityError);
    const rejected = expect(queued.result).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    router.close(epoch);
    await rejected;
  });

  it("initialize 请求写失败后拒绝队列且同一连接不可重试", async () => {
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    router.open(writer);
    const queued = router.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const initialization = router.initialize(INITIALIZE_PARAMS);
    const initializationRejected = expect(initialization).rejects.toBeInstanceOf(
      RpcWriteError,
    );
    const queuedRejected = expect(queued.result).rejects.toBeInstanceOf(
      RpcInitializationFailedError,
    );

    writer.rejectNext();
    await initializationRejected;
    await queuedRejected;
    expect(() => router.initialize(INITIALIZE_PARAMS)).toThrow(
      RpcInitializationStateError,
    );
    expect(() =>
      router.sendRequest({ method: "thread/read", validateResult: stringResult }),
    ).toThrow(RpcInitializationFailedError);
  });

  it("initialize 非法结果由固定校验器拒绝并透传安全诊断", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    const queued = router.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const initialization = router.initialize(INITIALIZE_PARAMS);
    const initializationRejected = expect(initialization).rejects.toBeInstanceOf(
      RpcInvalidResultError,
    );
    const queuedRejected = expect(queued.result).rejects.toBeInstanceOf(
      RpcInitializationFailedError,
    );
    await flushMicrotasks();

    await router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      result: { private: "DO_NOT_LOG_INITIALIZE_RESULT" },
    });
    await initializationRejected;
    await queuedRejected;
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "invalid_response_result",
        method: "initialize",
        validation: SAFE_INITIALIZE_FAILURE,
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_INITIALIZE_RESULT");
    expect(writer.messages).toHaveLength(1);
  });

  it("initialize 错误响应拒绝队列且不发送 initialized", async () => {
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const epoch = router.open(writer);
    const queued = router.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const initialization = router.initialize(INITIALIZE_PARAMS);
    const initializationRejected = expect(initialization).rejects.toMatchObject({
      name: "RpcRemoteError",
      code: -32000,
    });
    const queuedRejected = expect(queued.result).rejects.toBeInstanceOf(
      RpcInitializationFailedError,
    );
    await flushMicrotasks();

    await router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      error: { code: -32000, message: "initialization failed" },
    });
    await initializationRejected;
    await queuedRejected;
    expect(writer.messages).toHaveLength(1);
  });

  it("initialized 通知写失败后拒绝初始化和队列", async () => {
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const epoch = router.open(writer);
    const queued = router.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const initialization = router.initialize(INITIALIZE_PARAMS);
    const initializationRejected = expect(initialization).rejects.toBeInstanceOf(
      RpcWriteError,
    );
    const queuedRejected = expect(queued.result).rejects.toBeInstanceOf(
      RpcInitializationFailedError,
    );
    writer.resolveNext();
    await flushMicrotasks();

    const incoming = router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      result: INITIALIZE_RESPONSE,
    });
    writer.rejectNext();
    await incoming;
    await initializationRejected;
    await queuedRejected;
    expect(writer.messages.map((message) => recordOf(message)?.method)).toEqual([
      "initialize",
      "initialized",
    ]);
  });

  it("响应早于 initialize 写 Promise 完成时仍等待写成功再继续握手", async () => {
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const epoch = router.open(writer);
    const initialization = router.initialize(INITIALIZE_PARAMS);

    await router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      result: INITIALIZE_RESPONSE,
    });
    expect(writer.messages).toHaveLength(1);

    writer.resolveNext();
    await flushMicrotasks();
    expect(writer.messages[1]).toEqual({ method: "initialized" });
    writer.resolveNext();
    await expect(initialization).resolves.toEqual(INITIALIZE_RESPONSE);
  });

  it("close 与 initialized 在途写竞态不会结算旧连接或误报", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    const queued = router.sendRequest({
      method: "thread/list",
      validateResult: stringResult,
    });
    const initialization = router.initialize(INITIALIZE_PARAMS);
    writer.resolveNext();
    await flushMicrotasks();
    const incoming = router.handleIncoming(epoch, {
      id: requestIdAt(writer, 0),
      result: INITIALIZE_RESPONSE,
    });
    const initializationRejected = expect(initialization).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    const queuedRejected = expect(queued.result).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );

    expect(router.close(epoch)).toBe(true);
    writer.rejectNext();
    await incoming;
    await initializationRejected;
    await queuedRejected;
    expect(diagnostics).toEqual([]);

    const nextWriter = new RecordingWriter();
    const nextEpoch = router.open(nextWriter);
    const nextInitialization = router.initialize(INITIALIZE_PARAMS);
    expect(nextWriter.messages).toHaveLength(1);
    const nextRejected = expect(nextInitialization).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    router.close(nextEpoch);
    await nextRejected;
  });

  it("不同 RpcRouter 实例分配的 epoch 和请求 ID 不冲突", async () => {
    const firstRouter = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const secondRouter = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const firstWriter = new RecordingWriter();
    const secondWriter = new RecordingWriter();
    const firstEpoch = firstRouter.open(firstWriter);
    const secondEpoch = secondRouter.open(secondWriter);
    const firstInitialization = firstRouter.initialize(INITIALIZE_PARAMS);
    const secondInitialization = secondRouter.initialize(INITIALIZE_PARAMS);

    expect(firstEpoch).not.toBe(secondEpoch);
    expect(requestIdAt(firstWriter, 0)).not.toBe(requestIdAt(secondWriter, 0));
    expect(requestIdAt(firstWriter, 0)).toMatch(
      /^rpc:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:\d+:\d+$/u,
    );
    const firstRejected = expect(firstInitialization).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    const secondRejected = expect(secondInitialization).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    firstRouter.close(firstEpoch);
    secondRouter.close(secondEpoch);
    await firstRejected;
    await secondRejected;
  });
});

describe("RpcRouter 请求生命周期", () => {
  it("记录响应解析与校验耗时且诊断回调失败不影响结果", async () => {
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const epoch = router.open(writer);
    await establishConnection(router, writer, epoch);
    const timings: unknown[] = [];
    const request = router.sendRequest({
      method: "model/read",
      validateResult: stringResult,
      onResponseTiming: (timing) => {
        timings.push(timing);
        throw new Error("diagnostic failure");
      },
    });

    await router.handleIncoming(
      epoch,
      { id: request.id, result: "ready" },
      { jsonCharacters: 128, jsonParseMs: 2 },
    );

    await expect(request.result).resolves.toBe("ready");
    expect(timings).toEqual([
      expect.objectContaining({
        jsonCharacters: 128,
        jsonParseMs: 2,
        envelopeValidationMs: expect.any(Number),
        resultValidationMs: expect.any(Number),
      }),
    ]);
  });

  it("业务请求写失败只拒绝对应请求且诊断不含正文", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    await establishControlledConnection(router, writer, epoch);
    writer.messages.length = 0;

    const request = router.sendRequest({
      method: "secret/read",
      params: { content: "DO_NOT_LOG_PARAMS" },
      validateResult: stringResult,
    });
    writer.rejectNext();
    await expect(request.result).rejects.toBeInstanceOf(RpcWriteError);
    expect(request.stage).toBe("settled");
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "write_failed",
        method: "secret/read",
        requestId: request.id,
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_PARAMS");
  });

  it("用调用方 validator 校验业务响应并路由远端错误", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    await establishConnection(router, writer, epoch);
    writer.messages.length = 0;
    const invalid = router.sendRequest({
      method: "model/list",
      validateResult: stringResult,
    });
    const remoteError = router.sendRequest({
      method: "thread/read",
      validateResult: stringResult,
    });

    await router.handleIncoming(epoch, {
      id: invalid.id,
      result: { private: "DO_NOT_LOG_RESULT" },
    });
    await router.handleIncoming(epoch, {
      id: remoteError.id,
      error: { code: -32000, message: "request failed" },
    });

    await expect(invalid.result).rejects.toBeInstanceOf(RpcInvalidResultError);
    await expect(remoteError.result).rejects.toBeInstanceOf(RpcRemoteError);
    await expect(remoteError.result).rejects.toMatchObject({ code: -32000 });
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_RESULT");
  });

  it("断线拒绝待响应请求，新连接不重发且不复用 ID", async () => {
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
    });
    const firstWriter = new RecordingWriter();
    const firstEpoch = router.open(firstWriter);
    await establishConnection(router, firstWriter, firstEpoch);
    firstWriter.messages.length = 0;
    const pending = router.sendRequest({
      method: "thread/read",
      validateResult: stringResult,
    });
    const pendingRejected = expect(pending.result).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );

    router.close(firstEpoch);
    await pendingRejected;
    const secondWriter = new RecordingWriter();
    const secondEpoch = router.open(secondWriter);
    const nextInitialization = router.initialize(INITIALIZE_PARAMS);
    expect(secondWriter.messages).toHaveLength(1);
    expect(requestIdAt(secondWriter, 0)).not.toBe(pending.id);
    const nextRejected = expect(nextInitialization).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    router.close(secondEpoch);
    await nextRejected;
  });
});

describe("RpcRouter 入站路由", () => {
  it("区分旧 epoch、旧内部 ID 与未知外部 ID，并隐藏外部 ID", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const firstWriter = new RecordingWriter();
    const firstEpoch = router.open(firstWriter);
    const oldInitialization = router.initialize(INITIALIZE_PARAMS);
    const oldId = requestIdAt(firstWriter, 0);
    const oldRejected = expect(oldInitialization).rejects.toBeInstanceOf(
      RpcConnectionClosedError,
    );
    router.close(firstEpoch);
    await oldRejected;
    const currentEpoch = router.open(new RecordingWriter());

    await router.handleIncoming(firstEpoch, { id: oldId, result: "late" });
    await router.handleIncoming(currentEpoch, { id: oldId, result: "late" });
    await router.handleIncoming(currentEpoch, {
      id: "DO_NOT_LOG_EXTERNAL_ID",
      result: "unknown",
    });

    expect(diagnostics.map(({ code }) => code)).toEqual([
      "stale_epoch_message",
      "stale_response",
      "unknown_response",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_EXTERNAL_ID");
    expect(router.diagnosticCounts()).toMatchObject({
      staleResponses: 1,
      unknownResponses: 1,
    });
  });

  it("已知通知校验后分发，未知方法和非法参数仅记录安全诊断", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const received: ServerNotification[] = [];
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    await establishConnection(router, writer, epoch);
    router.subscribeNotifications((notification) => {
      received.push(notification);
    });

    await router.handleIncoming(epoch, {
      method: "serverRequest/resolved",
      params: { requestId: 7, threadId: "thread-1" },
    });
    await router.handleIncoming(epoch, {
      method: "future/DO_NOT_LOG_NOTIFICATION",
      params: { content: "DO_NOT_LOG_NOTIFICATION_BODY" },
    });
    await router.handleIncoming(epoch, {
      method: "serverRequest/resolved",
      params: { requestId: 7, threadId: 12 },
    });

    expect(received).toHaveLength(1);
    expect(router.diagnosticCounts().unknownNotifications).toBe(1);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "unknown_notification",
      "invalid_notification",
    ]);
    expect(diagnostics[0]).not.toHaveProperty("method");
    expect(diagnostics[0]).toHaveProperty("validation", SAFE_UNKNOWN_METHOD);
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_NOTIFICATION");
  });

  it("服务端请求对成功、未知、未实现、非法参数和处理失败显式响应", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    await establishConnection(router, writer, epoch);
    writer.messages.length = 0;
    router.registerServerRequestHandler("currentTime/read", (request) => {
      const params = recordOf(recordOf(request)?.params);
      if (params?.threadId === "throw") {
        throw new Error("private handler detail");
      }
      return { unixSeconds: 123 };
    });

    await router.handleIncoming(epoch, {
      id: 1,
      method: "currentTime/read",
      params: { threadId: "thread-1" },
    });
    await router.handleIncoming(epoch, {
      id: "DO_NOT_LOG_SERVER_ID",
      method: "future/DO_NOT_LOG_REQUEST",
      params: { private: "unknown body" },
    });
    await router.handleIncoming(epoch, {
      id: 3,
      method: "currentTime/read",
      params: { threadId: 3 },
    });
    await router.handleIncoming(epoch, {
      id: 4,
      method: "currentTime/read",
      params: { threadId: "throw" },
    });
    const remove = router.registerServerRequestHandler(
      "currentTime/read",
      () => ({ unused: true }),
    );
    remove();
    await router.handleIncoming(epoch, {
      id: 5,
      method: "currentTime/read",
      params: { threadId: "unimplemented" },
    });

    expect(writer.messages).toEqual([
      { id: 1, result: { unixSeconds: 123 } },
      {
        id: "DO_NOT_LOG_SERVER_ID",
        error: { code: -32601, message: "Method not found" },
      },
      { id: 3, error: { code: -32602, message: "Invalid params" } },
      { id: 4, error: { code: -32603, message: "Internal error" } },
      { id: 5, error: { code: -32601, message: "Method not found" } },
    ]);
    const unknown = diagnostics.find(({ code }) => code === "unknown_server_request");
    expect(unknown).toEqual({
      code: "unknown_server_request",
      direction: "inbound",
      epoch,
      validation: SAFE_UNKNOWN_METHOD,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_SERVER_ID");
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_REQUEST");
  });

  it("诊断回调异常不会阻止协议错误响应", async () => {
    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: () => {
        throw new Error("diagnostic sink failed");
      },
    });
    const epoch = router.open(writer);
    await establishConnection(router, writer, epoch);
    writer.messages.length = 0;

    await expect(router.handleIncoming(epoch, {
      id: 77,
      method: "future/request",
      params: {},
    })).resolves.toBeUndefined();
    expect(writer.messages).toEqual([
      { id: 77, error: { code: -32601, message: "Method not found" } },
    ]);
  });

  it("服务端成功响应写失败只尝试一次并终止连接", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new ServerResponseFailingWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    await establishConnection(router, writer, epoch);
    writer.messages.length = 0;
    router.registerServerRequestHandler("currentTime/read", () => ({ unixSeconds: 1 }));
    const pending = router.sendRequest({
      method: "thread/read",
      validateResult: stringResult,
    });
    const pendingRejected = expect(pending.result).rejects.toBeInstanceOf(RpcWriteError);
    writer.failServerResponses = true;

    await expect(router.handleIncoming(epoch, {
      id: "external-id",
      method: "currentTime/read",
      params: { threadId: "thread-1" },
    })).rejects.toBeInstanceOf(RpcWriteError);
    await pendingRejected;
    expect(writer.messages).toEqual([
      expect.objectContaining({ method: "thread/read" }),
      { id: "external-id", result: { unixSeconds: 1 } },
    ]);
    expect(diagnostics).toEqual([
      {
        code: "write_failed",
        direction: "outbound",
        epoch,
        method: "currentTime/read",
      },
    ]);
    expect(() =>
      router.sendRequest({ method: "thread/list", validateResult: stringResult }),
    ).toThrow(RpcConnectionError);
  });

  it("客户端业务通知写失败显式返回错误但不泄漏参数", async () => {
    const diagnostics: RpcDiagnostic[] = [];
    const writer = new ControlledWriter();
    const router = new RpcRouter({
      boundary: new StrictBoundary(),
      queueCapacity: 1,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const epoch = router.open(writer);
    await establishControlledConnection(router, writer, epoch);

    const notification = router.sendNotification(epoch, "thread/changed", {
      private: "DO_NOT_LOG_NOTIFICATION_PARAMS",
    });
    writer.rejectNext();
    await expect(notification).rejects.toBeInstanceOf(RpcWriteError);
    expect(diagnostics).toEqual([
      {
        code: "write_failed",
        direction: "outbound",
        epoch,
        method: "thread/changed",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("DO_NOT_LOG_NOTIFICATION_PARAMS");
  });
});
