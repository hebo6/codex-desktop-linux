import packageMetadata from "../../package.json";

import type {
  InitializeParams,
  InitializeResponse,
} from "../protocol/generated";
import {
  RpcConnectionClosedError,
  RpcConnectionError,
  RpcInitializationFailedError,
  RpcInvalidResultError,
  RpcRemoteError,
  RpcRouter,
  RpcWriteError,
  schemaProtocolBoundary,
} from "../protocol/rpc";
import type {
  RequestHandle,
  RpcDiagnostic,
  RpcDiagnosticCounts,
  SendRequestOptions,
  ServerNotificationHandler,
  ServerRequestHandler,
} from "../protocol/rpc";
import type {
  ProtocolTransport,
  ProtocolTransportConnector,
  ProtocolTransportTermination,
  TransportConnectionStage,
} from "../transport";

export const DEFAULT_APP_SERVER_REQUEST_QUEUE_CAPACITY = 64;
export const DEFAULT_APP_SERVER_INBOUND_QUEUE_CAPACITY = 256;

export const APP_SERVER_CLIENT_INFO = Object.freeze({
  name: packageMetadata.name,
  title: "Codex Desktop Linux",
  version: packageMetadata.version,
}) satisfies InitializeParams["clientInfo"];

const INITIALIZE_PARAMS: InitializeParams = Object.freeze({
  clientInfo: APP_SERVER_CLIENT_INFO,
  capabilities: Object.freeze({
    experimentalApi: true,
  }),
});

export type AppServerSessionPhase =
  | "idle"
  | "connecting"
  | "initializing"
  | "ready"
  | "closing"
  | "closed"
  | "error";

export type AppServerConnectionStage =
  | TransportConnectionStage
  | "appServerInitialization";

export type AppServerSessionErrorCode =
  | "invalidState"
  | "sessionClosed"
  | "transportConnectFailed"
  | "transportConnectCancelFailed"
  | "transportClosed"
  | "transportFailure"
  | "invalidTransportJson"
  | "inboundQueueOverflow"
  | "inboundProcessingFailed"
  | "initializationRejected"
  | "invalidInitializationResponse"
  | "initializationWriteFailed"
  | "initializationInterrupted"
  | "initializationFailed";

export interface AppServerSessionState {
  readonly phase: AppServerSessionPhase;
  readonly connectionStage: AppServerConnectionStage | null;
  readonly initializeResponse: InitializeResponse | null;
  readonly errorCode: AppServerSessionErrorCode | null;
  readonly transportTermination?: ProtocolTransportTermination;
}

export type AppServerSessionDiagnostic =
  | {
      readonly source: "rpc";
      readonly diagnostic: RpcDiagnostic;
    }
  | {
      readonly source: "session";
      readonly code:
        | "stateHandlerFailed"
        | "transportConnectCancelFailed"
        | "transportCloseFailed"
        | "transportFailure"
        | "invalidTransportJson"
        | "inboundQueueOverflow"
        | "inboundProcessingFailed";
      readonly phase: AppServerSessionPhase;
    };

export interface AppServerSessionOptions {
  readonly connectTransport: ProtocolTransportConnector;
  readonly cancelTransportConnect?: () => Promise<void>;
  readonly requestQueueCapacity?: number;
  readonly inboundQueueCapacity?: number;
  readonly onStateChange?: (state: AppServerSessionState) => void;
  readonly onDiagnostic?: (diagnostic: AppServerSessionDiagnostic) => void;
}

export class AppServerSessionError extends Error {
  readonly code: AppServerSessionErrorCode;

  constructor(code: AppServerSessionErrorCode) {
    super(`App-server session failed: ${code}`);
    this.name = "AppServerSessionError";
    this.code = code;
  }
}

export class AppServerSession {
  private readonly router: RpcRouter;
  private readonly connectTransport: ProtocolTransportConnector;
  private readonly cancelTransportConnect: (() => Promise<void>) | undefined;
  private readonly inboundQueueCapacity: number;
  private readonly onStateChange:
    ((state: AppServerSessionState) => void) | undefined;
  private readonly onDiagnostic:
    ((diagnostic: AppServerSessionDiagnostic) => void) | undefined;

  private phase: AppServerSessionPhase = "idle";
  private connectionStage: AppServerConnectionStage | null = null;
  private transportTermination: ProtocolTransportTermination | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private failureCode: AppServerSessionErrorCode | null = null;
  private transport: ProtocolTransport | null = null;
  private transportClosePromise: Promise<void> | null = null;
  private epoch: number | null = null;
  private startPromise: Promise<InitializeResponse> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly earlyInboundMessages: string[] = [];
  private bufferingInbound = true;
  private pendingInboundCount = 0;
  private inboundTail: Promise<void> = Promise.resolve();

  constructor(options: AppServerSessionOptions) {
    const requestQueueCapacity =
      options.requestQueueCapacity ?? DEFAULT_APP_SERVER_REQUEST_QUEUE_CAPACITY;
    const inboundQueueCapacity =
      options.inboundQueueCapacity ?? DEFAULT_APP_SERVER_INBOUND_QUEUE_CAPACITY;
    if (
      !Number.isSafeInteger(inboundQueueCapacity) ||
      inboundQueueCapacity <= 0
    ) {
      throw new RangeError(
        "inboundQueueCapacity must be a positive safe integer",
      );
    }

    this.connectTransport = options.connectTransport;
    this.cancelTransportConnect = options.cancelTransportConnect;
    this.inboundQueueCapacity = inboundQueueCapacity;
    this.onStateChange = options.onStateChange;
    this.onDiagnostic = options.onDiagnostic;
    this.router = new RpcRouter({
      boundary: schemaProtocolBoundary,
      queueCapacity: requestQueueCapacity,
      onDiagnostic: (diagnostic) => {
        this.emitDiagnostic({ source: "rpc", diagnostic });
      },
    });
  }

  get state(): AppServerSessionState {
    return this.snapshot();
  }

  start(): Promise<InitializeResponse> {
    if (this.phase !== "idle") {
      throw new AppServerSessionError("invalidState");
    }

    this.startPromise = Promise.resolve().then(() => this.startInternal());
    this.connectionStage = null;
    this.transition("connecting");
    return this.startPromise;
  }

  sendRequest<T>(options: SendRequestOptions<T>): RequestHandle<T> {
    return this.router.sendRequest(options);
  }

  sendNotification(method: string, params?: unknown): Promise<void> {
    if (this.epoch === null) {
      throw new RpcConnectionError();
    }
    return this.router.sendNotification(this.epoch, method, params);
  }

  registerServerRequestHandler(
    method: string,
    handler: ServerRequestHandler,
  ): () => void {
    return this.router.registerServerRequestHandler(method, handler);
  }

  subscribeNotifications(handler: ServerNotificationHandler): () => void {
    return this.router.subscribeNotifications(handler);
  }

  diagnosticCounts(): RpcDiagnosticCounts {
    return this.router.diagnosticCounts();
  }

  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }

    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async startInternal(): Promise<InitializeResponse> {
    if (isClosingOrClosed(this.phase)) {
      throw new AppServerSessionError("sessionClosed");
    }

    let transport: ProtocolTransport;
    try {
      transport = await this.connectTransport({
        onProtocolMessage: (json) => this.receiveProtocolMessage(json),
        onConnectionProgress: (stage) => this.handleConnectionProgress(stage),
        onTransportClosed: (termination) => {
          this.transportTermination = termination ?? null;
          this.fail("transportClosed");
        },
        onTransportFailure: () => {
          this.emitSessionDiagnostic("transportFailure");
          this.fail("transportFailure");
        },
      });
    } catch {
      if (isClosingOrClosed(this.phase)) {
        throw new AppServerSessionError("sessionClosed");
      }
      if (this.failureCode !== null) {
        throw new AppServerSessionError(this.failureCode);
      }
      this.fail("transportConnectFailed");
      throw new AppServerSessionError("transportConnectFailed");
    }

    this.transport = transport;
    if (!isProtocolTransport(transport)) {
      this.fail("transportConnectFailed");
      throw new AppServerSessionError("transportConnectFailed");
    }
    if (this.phase === "closing" || this.phase === "closed") {
      await this.closeTransport();
      throw new AppServerSessionError("sessionClosed");
    }
    if (this.failureCode !== null) {
      await this.closeTransport();
      throw new AppServerSessionError(this.failureCode);
    }

    const epoch = this.router.open(transport);
    this.epoch = epoch;
    this.connectionStage = "appServerInitialization";
    this.transition("initializing");
    if (isClosingOrClosed(this.phase)) {
      throw new AppServerSessionError("sessionClosed");
    }
    if (this.failureCode !== null) {
      throw new AppServerSessionError(this.failureCode);
    }

    let initialization: Promise<InitializeResponse>;
    try {
      initialization = this.router.initialize(INITIALIZE_PARAMS);
    } catch (error) {
      const code = initializationErrorCode(error);
      this.fail(code);
      throw new AppServerSessionError(code);
    }
    this.flushEarlyInboundMessages(epoch);

    let response: InitializeResponse;
    try {
      response = await initialization;
    } catch (error) {
      if (isClosingOrClosed(this.phase)) {
        throw new AppServerSessionError("sessionClosed");
      }
      if (this.failureCode !== null) {
        throw new AppServerSessionError(this.failureCode);
      }

      const code = initializationErrorCode(error);
      this.fail(code);
      throw new AppServerSessionError(code);
    }

    if (this.phase !== "initializing" || this.epoch !== epoch) {
      const code = this.failureCode ?? "sessionClosed";
      throw new AppServerSessionError(code);
    }

    const normalizedResponse = normalizeInitializeResponse(response);
    this.initializeResponse = normalizedResponse;
    this.connectionStage = null;
    this.transition("ready");
    return normalizedResponse;
  }

  private async closeInternal(): Promise<void> {
    if (this.phase === "closed") {
      return;
    }
    if (this.phase === "idle") {
      this.transition("closed");
      return;
    }

    this.transition("closing");
    this.closeRouter();
    this.discardEarlyInboundMessages();

    let transportConnectCancelFailed = false;
    if (this.transport === null && this.cancelTransportConnect !== undefined) {
      try {
        await this.cancelTransportConnect();
      } catch {
        this.emitSessionDiagnostic("transportConnectCancelFailed");
        transportConnectCancelFailed = true;
      }
    }

    if (this.startPromise !== null && !transportConnectCancelFailed) {
      try {
        await this.startPromise;
      } catch {
        // start 由关闭流程中断时只需继续回收传输
      }
    }

    await this.closeTransport();
    await this.inboundTail;
    this.transition("closed");
    if (transportConnectCancelFailed) {
      // 取消 IPC 失败后，连接命令可能永不返回。关闭状态必须及时对调用方可见，
      // 同时保留 startInternal 对迟到传输的回收责任，避免切换屏障永久等待
      void this.startPromise?.catch(() => undefined);
      throw new AppServerSessionError("transportConnectCancelFailed");
    }
  }

  private receiveProtocolMessage(json: string): void {
    if (
      this.phase === "closing" ||
      this.phase === "closed" ||
      this.phase === "error"
    ) {
      return;
    }
    if (this.pendingInboundCount >= this.inboundQueueCapacity) {
      this.emitSessionDiagnostic("inboundQueueOverflow");
      this.fail("inboundQueueOverflow");
      return;
    }

    this.pendingInboundCount += 1;
    if (this.bufferingInbound || this.epoch === null) {
      this.earlyInboundMessages.push(json);
      return;
    }
    this.enqueueInboundMessage(this.epoch, json);
  }

  private handleConnectionProgress(stage: TransportConnectionStage): void {
    if (this.phase !== "connecting" || this.connectionStage === stage) {
      return;
    }
    this.connectionStage = stage;
    try {
      this.onStateChange?.(this.snapshot());
    } catch {
      this.emitSessionDiagnostic("stateHandlerFailed");
    }
  }

  private flushEarlyInboundMessages(epoch: number): void {
    const messages = this.earlyInboundMessages.splice(0);
    this.bufferingInbound = false;
    for (const json of messages) {
      this.enqueueInboundMessage(epoch, json);
    }
  }

  private enqueueInboundMessage(epoch: number, json: string): void {
    this.inboundTail = this.inboundTail.then(async () => {
      try {
        if (this.epoch !== epoch) {
          return;
        }

        let message: unknown;
        try {
          message = JSON.parse(json) as unknown;
        } catch {
          this.emitSessionDiagnostic("invalidTransportJson");
          this.fail("invalidTransportJson");
          return;
        }

        await this.router.handleIncoming(epoch, message);
      } catch {
        this.emitSessionDiagnostic("inboundProcessingFailed");
        this.fail("inboundProcessingFailed");
      } finally {
        this.pendingInboundCount -= 1;
      }
    });
  }

  private fail(code: AppServerSessionErrorCode): void {
    if (
      this.phase === "closing" ||
      this.phase === "closed" ||
      this.phase === "error"
    ) {
      return;
    }

    this.failureCode = code;
    this.closeRouter();
    this.discardEarlyInboundMessages();
    this.transition("error");
    void this.closeTransport();
  }

  private closeRouter(): void {
    const epoch = this.epoch;
    this.epoch = null;
    if (epoch !== null) {
      this.router.close(epoch);
    }
  }

  private closeTransport(): Promise<void> {
    if (this.transport === null) {
      return Promise.resolve();
    }
    if (this.transportClosePromise !== null) {
      return this.transportClosePromise;
    }

    try {
      this.transportClosePromise = this.transport.close().catch(() => {
        this.emitSessionDiagnostic("transportCloseFailed");
      });
    } catch {
      this.emitSessionDiagnostic("transportCloseFailed");
      this.transportClosePromise = Promise.resolve();
    }
    return this.transportClosePromise;
  }

  private discardEarlyInboundMessages(): void {
    this.pendingInboundCount -= this.earlyInboundMessages.length;
    this.earlyInboundMessages.length = 0;
  }

  private transition(phase: AppServerSessionPhase): void {
    this.phase = phase;
    try {
      this.onStateChange?.(this.snapshot());
    } catch {
      this.emitSessionDiagnostic("stateHandlerFailed");
    }
  }

  private snapshot(): AppServerSessionState {
    return Object.freeze({
      phase: this.phase,
      connectionStage: this.connectionStage,
      initializeResponse: this.initializeResponse,
      errorCode: this.phase === "error" ? this.failureCode : null,
      ...(this.phase === "error" && this.transportTermination !== null
        ? { transportTermination: this.transportTermination }
        : {}),
    });
  }

  private emitSessionDiagnostic(
    code: Extract<AppServerSessionDiagnostic, { source: "session" }>["code"],
  ): void {
    this.emitDiagnostic({
      source: "session",
      code,
      phase: this.phase,
    });
  }

  private emitDiagnostic(diagnostic: AppServerSessionDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // 诊断旁路不得改变会话生命周期
    }
  }
}

function initializationErrorCode(error: unknown): AppServerSessionErrorCode {
  if (error instanceof RpcRemoteError) {
    return "initializationRejected";
  }
  if (error instanceof RpcInvalidResultError) {
    return "invalidInitializationResponse";
  }
  if (error instanceof RpcWriteError) {
    return "initializationWriteFailed";
  }
  if (
    error instanceof RpcConnectionClosedError ||
    error instanceof RpcConnectionError ||
    error instanceof RpcInitializationFailedError
  ) {
    return "initializationInterrupted";
  }
  return "initializationFailed";
}

function isClosingOrClosed(phase: AppServerSessionPhase): boolean {
  return phase === "closing" || phase === "closed";
}

function isProtocolTransport(value: unknown): value is ProtocolTransport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ProtocolTransport>;
  return (
    typeof candidate.write === "function" &&
    typeof candidate.close === "function"
  );
}

function normalizeInitializeResponse(
  response: InitializeResponse,
): InitializeResponse {
  return Object.freeze({
    codexHome: response.codexHome,
    platformFamily: response.platformFamily,
    platformOs: response.platformOs,
    userAgent: response.userAgent,
  });
}
