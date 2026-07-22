import type {
  InitializeParams,
  InitializeResponse,
  JSONRPCMessage,
} from "../generated";

import {
  RpcConnectionClosedError,
  RpcConnectionError,
  RpcInitializationFailedError,
  RpcInitializationStateError,
  RpcInvalidResultError,
  RpcQueueCapacityError,
  RpcRemoteError,
  RpcWriteError,
} from "./errors";
import type {
  RequestHandle,
  RequestStage,
  ResultValidator,
  RpcDiagnostic,
  RpcDiagnosticCode,
  RpcDiagnosticCounts,
  RpcInboundTiming,
  RpcRequestId,
  RpcResponseTiming,
  RpcRouterOptions,
  RpcWriter,
  SendRequestOptions,
  ServerNotificationHandler,
  ServerRequestHandler,
  ValidationResult,
} from "./types";

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

let connectionEpochSequence = 0;
const clientInstanceId = crypto.randomUUID();

type InitializationState =
  | "awaiting_initialize"
  | "initializing"
  | "sending_initialized"
  | "ready"
  | "failed";

type RequestKind = "initialization" | "business";

interface RequestRecord {
  readonly kind: RequestKind;
  readonly epoch: number;
  readonly id: RpcRequestId;
  readonly method: string;
  readonly params: unknown;
  stage: RequestStage;
  readonly validateResult: ResultValidator<unknown>;
  readonly onResponseTiming: ((timing: RpcResponseTiming) => void) | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface ActiveConnection {
  readonly epoch: number;
  readonly writer: RpcWriter;
  readonly requests: Map<RpcRequestId, RequestRecord>;
  readonly queue: RequestRecord[];
  initializationState: InitializationState;
  initializationRequest: RequestRecord | null;
  initializationResponse: InitializeResponse | null;
  draining: boolean;
  nextRequestSequence: number;
}

interface MutableDiagnosticCounts {
  unknownNotifications: number;
  unknownServerRequests: number;
  staleResponses: number;
  unknownResponses: number;
}

type MessageRecord = Record<string, unknown>;

function nextConnectionEpoch(): number {
  if (connectionEpochSequence >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("JSON-RPC connection epoch sequence is exhausted");
  }

  connectionEpochSequence += 1;
  return connectionEpochSequence;
}

function asRecord(value: unknown): MessageRecord | null {
  return typeof value === "object" && value !== null
    ? (value as MessageRecord)
    : null;
}

function hasOwn(record: MessageRecord, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function requestIdOf(record: MessageRecord): RpcRequestId | null {
  const id = record.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function requestEpochOf(id: RpcRequestId): number | null {
  if (typeof id !== "string") {
    return null;
  }

  const parts = id.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "rpc" ||
    parts[1] !== clientInstanceId ||
    !/^\d+$/u.test(parts[2] ?? "") ||
    !/^\d+$/u.test(parts[3] ?? "")
  ) {
    return null;
  }

  const epochText = parts[2]!;
  const epoch = Number(epochText);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function requestMessage(record: RequestRecord): JSONRPCMessage {
  if (record.params === undefined) {
    return {
      id: record.id,
      method: record.method,
    };
  }

  return {
    id: record.id,
    method: record.method,
    params: record.params,
  };
}

function notificationMessage(method: string, params: unknown): JSONRPCMessage {
  if (params === undefined) {
    return { method };
  }

  return { method, params };
}

export class RpcRouter {
  private readonly boundary: RpcRouterOptions["boundary"];
  private readonly queueCapacity: number;
  private readonly onDiagnostic: ((diagnostic: RpcDiagnostic) => void) | undefined;
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private readonly notificationHandlers = new Set<ServerNotificationHandler>();
  private readonly counts: MutableDiagnosticCounts = {
    unknownNotifications: 0,
    unknownServerRequests: 0,
    staleResponses: 0,
    unknownResponses: 0,
  };
  private connection: ActiveConnection | null = null;

  constructor(options: RpcRouterOptions) {
    if (!Number.isSafeInteger(options.queueCapacity) || options.queueCapacity < 0) {
      throw new RangeError("queueCapacity must be a non-negative safe integer");
    }

    this.boundary = options.boundary;
    this.queueCapacity = options.queueCapacity;
    this.onDiagnostic = options.onDiagnostic;
  }

  open(writer: RpcWriter): number {
    const epoch = nextConnectionEpoch();
    if (this.connection !== null) {
      this.close(this.connection.epoch);
    }

    this.connection = {
      epoch,
      writer,
      requests: new Map(),
      queue: [],
      initializationState: "awaiting_initialize",
      initializationRequest: null,
      initializationResponse: null,
      draining: false,
      nextRequestSequence: 0,
    };
    return epoch;
  }

  close(epoch: number): boolean {
    const connection = this.connection;
    if (connection === null || connection.epoch !== epoch) {
      return false;
    }

    this.connection = null;
    this.rejectConnectionRequests(connection, new RpcConnectionClosedError());
    return true;
  }

  initialize(params: InitializeParams): Promise<InitializeResponse> {
    const connection = this.requireConnection();
    if (connection.initializationState !== "awaiting_initialize") {
      throw new RpcInitializationStateError();
    }

    const protectedParams: InitializeParams = {
      ...params,
      capabilities: {
        ...(params.capabilities ?? {}),
        experimentalApi: true,
      },
    };
    const { request, handle } = this.createRequest(
      connection,
      "initialization",
      "initialize",
      protectedParams,
      (value) => this.boundary.validateInitializeResponse(value),
      undefined,
      "writing",
    );

    connection.initializationState = "initializing";
    connection.initializationRequest = request;
    connection.requests.set(request.id, request);
    void this.writeRequest(connection, request);
    return handle.result;
  }

  sendRequest<T>(options: SendRequestOptions<T>): RequestHandle<T> {
    const connection = this.requireConnection();
    if (options.method === "initialize") {
      throw new RpcInitializationStateError(
        "Use RpcRouter.initialize() for the initialize request",
      );
    }
    if (connection.initializationState === "failed") {
      throw new RpcInitializationFailedError();
    }

    const shouldQueue = connection.initializationState !== "ready" ||
      connection.draining;
    if (shouldQueue && connection.queue.length >= this.queueCapacity) {
      throw new RpcQueueCapacityError(this.queueCapacity);
    }

    const { request, handle } = this.createRequest(
      connection,
      "business",
      options.method,
      options.params,
      options.validateResult,
      options.onResponseTiming,
      shouldQueue ? "queued" : "writing",
    );

    connection.requests.set(request.id, request);
    if (shouldQueue) {
      connection.queue.push(request);
    } else {
      void this.writeRequest(connection, request);
    }

    return handle;
  }

  async sendNotification(
    epoch: number,
    method: string,
    params?: unknown,
  ): Promise<void> {
    const connection = this.requireConnection(epoch);
    if (method === "initialized") {
      throw new RpcInitializationStateError(
        "The initialized notification is managed by RpcRouter.initialize()",
      );
    }
    if (connection.initializationState === "failed") {
      throw new RpcInitializationFailedError();
    }
    if (connection.initializationState !== "ready" || connection.draining) {
      throw new RpcInitializationStateError(
        "JSON-RPC notifications require a fully initialized connection",
      );
    }

    try {
      await connection.writer.write(notificationMessage(method, params));
    } catch {
      if (this.connection !== connection) {
        return;
      }
      this.emit({
        code: "write_failed",
        direction: "outbound",
        epoch,
        method,
      });
      throw new RpcWriteError();
    }
  }

  registerServerRequestHandler(
    method: string,
    handler: ServerRequestHandler,
  ): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  subscribeNotifications(handler: ServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  diagnosticCounts(): RpcDiagnosticCounts {
    return { ...this.counts };
  }

  async handleIncoming(
    epoch: number,
    value: unknown,
    inboundTiming?: RpcInboundTiming,
  ): Promise<void> {
    const connection = this.connection;
    if (connection === null || connection.epoch !== epoch) {
      this.emit({
        code: "stale_epoch_message",
        direction: "inbound",
        epoch,
      });
      return;
    }

    const envelopeValidationStartedAt = performance.now();
    const envelope = this.boundary.validateMessage(value);
    const envelopeValidationMs = performance.now() - envelopeValidationStartedAt;
    if (!envelope.ok) {
      this.emit({
        code: "invalid_message",
        direction: "inbound",
        epoch,
        ...(envelope.error === undefined ? {} : { validation: envelope.error }),
      });
      return;
    }

    const record = asRecord(envelope.value);
    if (record === null) {
      this.emit({
        code: "invalid_message",
        direction: "inbound",
        epoch,
      });
      return;
    }

    if (typeof record.method === "string") {
      if (hasOwn(record, "id")) {
        await this.handleServerRequest(connection, envelope.value, record);
      } else {
        await this.handleServerNotification(connection, envelope.value, record.method);
      }
      return;
    }

    if (hasOwn(record, "result")) {
      await this.handleSuccessResponse(
        connection,
        record,
        inboundTiming === undefined
          ? undefined
          : { ...inboundTiming, envelopeValidationMs },
      );
      return;
    }

    if (hasOwn(record, "error")) {
      this.handleErrorResponse(connection, record);
      return;
    }

    this.emit({
      code: "invalid_message",
      direction: "inbound",
      epoch,
    });
  }

  private requireConnection(epoch?: number): ActiveConnection {
    const connection = this.connection;
    if (connection === null || (epoch !== undefined && connection.epoch !== epoch)) {
      throw new RpcConnectionError();
    }
    return connection;
  }

  private createRequest<T>(
    connection: ActiveConnection,
    kind: RequestKind,
    method: string,
    params: unknown,
    validateResult: ResultValidator<T>,
    onResponseTiming: ((timing: RpcResponseTiming) => void) | undefined,
    initialStage: RequestStage,
  ): { readonly request: RequestRecord; readonly handle: RequestHandle<T> } {
    if (connection.nextRequestSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("JSON-RPC request sequence is exhausted");
    }

    const id = `rpc:${clientInstanceId}:${connection.epoch}:${++connection.nextRequestSequence}`;
    let stage = initialStage;
    let resolvePromise: (value: T) => void = () => undefined;
    let rejectPromise: (reason: Error) => void = () => undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const request: RequestRecord = {
      kind,
      epoch: connection.epoch,
      id,
      method,
      params,
      get stage() {
        return stage;
      },
      set stage(value: RequestStage) {
        stage = value;
      },
      validateResult: (value) => validateResult(value),
      onResponseTiming,
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
    };
    const handle: RequestHandle<T> = {
      epoch: connection.epoch,
      id,
      get stage() {
        return stage;
      },
      result,
    };

    return { request, handle };
  }

  private async writeRequest(
    connection: ActiveConnection,
    request: RequestRecord,
  ): Promise<void> {
    if (this.connection !== connection || !connection.requests.has(request.id)) {
      return;
    }

    request.stage = "writing";
    try {
      await connection.writer.write(requestMessage(request));
    } catch {
      if (this.connection !== connection || !connection.requests.has(request.id)) {
        return;
      }

      this.emit({
        code: "write_failed",
        direction: "outbound",
        epoch: connection.epoch,
        method: request.method,
        requestId: request.id,
      });
      if (request.kind === "initialization") {
        this.failInitialization(connection, new RpcWriteError());
      } else {
        this.rejectRequest(connection, request, new RpcWriteError());
      }
      return;
    }

    if (this.connection !== connection || !connection.requests.has(request.id)) {
      return;
    }

    request.stage = "pending";
    if (
      request.kind === "initialization" &&
      connection.initializationResponse !== null
    ) {
      await this.completeInitialization(
        connection,
        request,
        connection.initializationResponse,
      );
    }
  }

  private async handleSuccessResponse(
    connection: ActiveConnection,
    message: MessageRecord,
    inboundTiming?: RpcInboundTiming & { readonly envelopeValidationMs: number },
  ): Promise<void> {
    const request = this.responseRequest(connection, message);
    if (request === null) {
      return;
    }

    if (
      request.kind === "initialization" &&
      (connection.initializationState !== "initializing" ||
        connection.initializationRequest !== request ||
        connection.initializationResponse !== null)
    ) {
      this.emit({
        code: "unexpected_response_stage",
        direction: "inbound",
        epoch: connection.epoch,
        method: request.method,
        requestId: request.id,
      });
      return;
    }

    const resultValidationStartedAt = performance.now();
    const validation = request.validateResult(message.result);
    const resultValidationMs = performance.now() - resultValidationStartedAt;
    if (inboundTiming !== undefined && request.onResponseTiming !== undefined) {
      try {
        request.onResponseTiming({ ...inboundTiming, resultValidationMs });
      } catch {
        // 性能诊断旁路不得影响协议结果
      }
    }
    if (!validation.ok) {
      const error = new RpcInvalidResultError(request.method);
      this.emit({
        code: "invalid_response_result",
        direction: "inbound",
        epoch: connection.epoch,
        method: request.method,
        requestId: request.id,
        ...(validation.error === undefined ? {} : { validation: validation.error }),
      });
      if (request.kind === "initialization") {
        this.failInitialization(connection, error);
      } else {
        this.rejectRequest(connection, request, error);
      }
      return;
    }

    if (request.kind === "initialization") {
      const response = validation.value as InitializeResponse;
      if (request.stage === "writing") {
        connection.initializationResponse = response;
        return;
      }
      await this.completeInitialization(connection, request, response);
      return;
    }

    this.resolveRequest(connection, request, validation.value);
  }

  private handleErrorResponse(
    connection: ActiveConnection,
    message: MessageRecord,
  ): void {
    const request = this.responseRequest(connection, message);
    if (request === null) {
      return;
    }

    if (
      request.kind === "initialization" &&
      (connection.initializationState !== "initializing" ||
        connection.initializationRequest !== request ||
        connection.initializationResponse !== null)
    ) {
      this.emit({
        code: "unexpected_response_stage",
        direction: "inbound",
        epoch: connection.epoch,
        method: request.method,
        requestId: request.id,
      });
      return;
    }

    const error = asRecord(message.error);
    if (error === null || typeof error.code !== "number" ||
      typeof error.message !== "string") {
      return;
    }

    const remoteError = new RpcRemoteError(error.code, error.message);
    if (request.kind === "initialization") {
      this.failInitialization(connection, remoteError);
    } else {
      this.rejectRequest(connection, request, remoteError);
    }
  }

  private responseRequest(
    connection: ActiveConnection,
    message: MessageRecord,
  ): RequestRecord | null {
    const id = requestIdOf(message);
    if (id === null) {
      this.emit({
        code: "invalid_message",
        direction: "inbound",
        epoch: connection.epoch,
      });
      return null;
    }

    const request = connection.requests.get(id);
    if (request === undefined) {
      const responseEpoch = requestEpochOf(id);
      if (responseEpoch !== null && responseEpoch !== connection.epoch) {
        this.counts.staleResponses += 1;
        this.emit({
          code: "stale_response",
          direction: "inbound",
          epoch: connection.epoch,
        });
      } else {
        this.counts.unknownResponses += 1;
        this.emit({
          code: "unknown_response",
          direction: "inbound",
          epoch: connection.epoch,
        });
      }
      return null;
    }

    if (request.stage === "queued") {
      this.emit({
        code: "unexpected_response_stage",
        direction: "inbound",
        epoch: connection.epoch,
        method: request.method,
        requestId: request.id,
      });
      return null;
    }

    return request;
  }

  private async completeInitialization(
    connection: ActiveConnection,
    request: RequestRecord,
    response: InitializeResponse,
  ): Promise<void> {
    if (
      this.connection !== connection ||
      !connection.requests.has(request.id) ||
      connection.initializationState !== "initializing"
    ) {
      return;
    }

    connection.initializationState = "sending_initialized";
    connection.initializationResponse = null;
    try {
      await connection.writer.write({ method: "initialized" });
    } catch {
      if (
        this.connection !== connection ||
        !connection.requests.has(request.id) ||
        connection.initializationState !== "sending_initialized"
      ) {
        return;
      }

      this.emit({
        code: "write_failed",
        direction: "outbound",
        epoch: connection.epoch,
        method: "initialized",
      });
      this.failInitialization(connection, new RpcWriteError());
      return;
    }

    if (
      this.connection !== connection ||
      !connection.requests.has(request.id) ||
      connection.initializationState !== "sending_initialized"
    ) {
      return;
    }

    connection.initializationState = "ready";
    connection.initializationRequest = null;
    this.resolveRequest(connection, request, response);
    await this.drainQueue(connection);
  }

  private async drainQueue(connection: ActiveConnection): Promise<void> {
    connection.draining = true;
    try {
      while (connection.queue.length > 0 && this.connection === connection) {
        const request = connection.queue.shift();
        if (request !== undefined && connection.requests.has(request.id)) {
          await this.writeRequest(connection, request);
        }
      }
    } finally {
      connection.draining = false;
    }
  }

  private failInitialization(connection: ActiveConnection, reason: Error): void {
    if (
      this.connection !== connection ||
      connection.initializationState === "failed" ||
      connection.initializationState === "ready"
    ) {
      return;
    }

    connection.initializationState = "failed";
    connection.initializationRequest = null;
    connection.initializationResponse = null;
    connection.queue.length = 0;
    for (const request of connection.requests.values()) {
      request.stage = "settled";
      request.reject(
        request.kind === "initialization"
          ? reason
          : new RpcInitializationFailedError(),
      );
    }
    connection.requests.clear();
  }

  private resolveRequest(
    connection: ActiveConnection,
    request: RequestRecord,
    value: unknown,
  ): void {
    if (!connection.requests.delete(request.id)) {
      return;
    }
    request.stage = "settled";
    request.resolve(value);
  }

  private rejectRequest(
    connection: ActiveConnection,
    request: RequestRecord,
    reason: Error,
  ): void {
    if (!connection.requests.delete(request.id)) {
      return;
    }
    request.stage = "settled";
    request.reject(reason);
  }

  private rejectConnectionRequests(
    connection: ActiveConnection,
    reason: Error,
  ): void {
    connection.queue.length = 0;
    connection.initializationRequest = null;
    connection.initializationResponse = null;
    for (const request of connection.requests.values()) {
      request.stage = "settled";
      request.reject(reason);
    }
    connection.requests.clear();
  }

  private terminateConnection(connection: ActiveConnection, reason: Error): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = null;
    this.rejectConnectionRequests(connection, reason);
  }

  private async handleServerNotification(
    connection: ActiveConnection,
    message: JSONRPCMessage,
    method: string,
  ): Promise<void> {
    const validation = this.boundary.validateServerNotification(message);
    if (validation.kind === "unknown_method") {
      this.counts.unknownNotifications += 1;
      this.emit({
        code: "unknown_notification",
        direction: "inbound",
        epoch: connection.epoch,
        ...(validation.validation === undefined
          ? {}
          : { validation: validation.validation }),
      });
      return;
    }
    if (validation.kind === "invalid_params") {
      this.emit({
        code: "invalid_notification",
        direction: "inbound",
        epoch: connection.epoch,
        method,
        ...(validation.validation === undefined
          ? {}
          : { validation: validation.validation }),
      });
      return;
    }

    for (const handler of this.notificationHandlers) {
      try {
        await handler(validation.value);
      } catch {
        this.emit({
          code: "notification_handler_failed",
          direction: "inbound",
          epoch: connection.epoch,
          method,
        });
      }
    }
  }

  private async handleServerRequest(
    connection: ActiveConnection,
    message: JSONRPCMessage,
    record: MessageRecord,
  ): Promise<void> {
    const id = requestIdOf(record);
    const method = typeof record.method === "string" ? record.method : "";
    if (id === null) {
      this.emit({
        code: "invalid_message",
        direction: "inbound",
        epoch: connection.epoch,
      });
      return;
    }

    const validation = this.boundary.validateServerRequest(message);
    if (validation.kind === "unknown_method") {
      this.counts.unknownServerRequests += 1;
      this.emit({
        code: "unknown_server_request",
        direction: "inbound",
        epoch: connection.epoch,
        ...(validation.validation === undefined
          ? {}
          : { validation: validation.validation }),
      });
      await this.writeServerError(connection, id, METHOD_NOT_FOUND, "Method not found");
      return;
    }
    if (validation.kind === "invalid_params") {
      this.emit({
        code: "invalid_server_request",
        direction: "inbound",
        epoch: connection.epoch,
        method,
        errorCode: INVALID_PARAMS,
        ...(validation.validation === undefined
          ? {}
          : { validation: validation.validation }),
      });
      await this.writeServerError(connection, id, INVALID_PARAMS, "Invalid params");
      return;
    }

    const handler = this.serverRequestHandlers.get(method);
    if (handler === undefined) {
      this.counts.unknownServerRequests += 1;
      this.emit({
        code: "unimplemented_server_request",
        direction: "inbound",
        epoch: connection.epoch,
        method,
        errorCode: METHOD_NOT_FOUND,
      });
      await this.writeServerError(connection, id, METHOD_NOT_FOUND, "Method not found");
      return;
    }

    let result: unknown;
    try {
      result = await handler(validation.value);
      if (result === undefined) {
        throw new TypeError("Server request handlers must return a JSON value");
      }
    } catch {
      this.emit({
        code: "server_request_handler_failed",
        direction: "inbound",
        epoch: connection.epoch,
        method,
        errorCode: INTERNAL_ERROR,
      });
      await this.writeServerError(connection, id, INTERNAL_ERROR, "Internal error");
      return;
    }

    await this.writeServerResult(connection, id, result, method);
  }

  private async writeServerResult(
    connection: ActiveConnection,
    id: RpcRequestId,
    result: unknown,
    method: string,
  ): Promise<void> {
    await this.writeServerMessage(connection, { id, result }, method);
  }

  private async writeServerError(
    connection: ActiveConnection,
    id: RpcRequestId,
    code: number,
    message: string,
  ): Promise<void> {
    await this.writeServerMessage(
      connection,
      { id, error: { code, message } },
      undefined,
    );
  }

  private async writeServerMessage(
    connection: ActiveConnection,
    message: JSONRPCMessage,
    method: string | undefined,
  ): Promise<void> {
    if (this.connection !== connection) {
      return;
    }

    try {
      await connection.writer.write(message);
    } catch {
      if (this.connection !== connection) {
        return;
      }

      const diagnostic: RpcDiagnostic = method === undefined
        ? {
            code: "write_failed",
            direction: "outbound",
            epoch: connection.epoch,
          }
        : {
            code: "write_failed",
            direction: "outbound",
            epoch: connection.epoch,
            method,
          };
      this.emit(diagnostic);
      const error = new RpcWriteError();
      this.terminateConnection(connection, error);
      throw error;
    }
  }

  private emit(diagnostic: RpcDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // 诊断旁路不得改变协议响应、请求结算或连接状态
    }
  }
}

export type { RpcDiagnosticCode };
