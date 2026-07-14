import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  AppServerThreadClient,
  AppServerConversationClient,
  AppServerCapabilityClient,
  AppServerFileClient,
  AppServerInteractionClient,
  AppServerAccountClient,
  createConfiguredServerAppServerSession,
} from "../appServer";
import type {
  AppServerConnectionStage,
  AppServerSessionErrorCode,
  AppServerSessionState,
} from "../appServer";
import type { ServerId } from "../configuration/model";
import type { ConnectionViewState } from "../store/connectionSlice";
import type { ConnectConfiguredServerRequest } from "../transport/configuredServer";
import type { LocalProcessTermination } from "../transport";

const CONNECTION_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const MAX_CONNECTION_ID_ALLOCATION_ATTEMPTS = 16;
const MAX_RETAINED_CONNECTION_IDS = 1_024;
export const RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 20_000, 30_000]);
export const SHORT_LOCAL_PROCESS_EXIT_MS = 10_000;
const MAX_SHORT_LOCAL_PROCESS_EXITS = 3;

const DISCONNECTED_VIEW = Object.freeze({
  phase: "disconnected",
  detail: null,
}) satisfies ConnectionViewState;

const CONNECTING_VIEW = Object.freeze({
  phase: "connecting",
  detail: null,
}) satisfies ConnectionViewState;

const INITIALIZING_VIEW = Object.freeze({
  phase: "initializing",
  detail: "app-server 初始化",
}) satisfies ConnectionViewState;

const READY_VIEW = Object.freeze({
  phase: "ready",
  detail: null,
}) satisfies ConnectionViewState;

const ERROR_DETAILS: Readonly<Record<AppServerSessionErrorCode, string>> =
  Object.freeze({
    invalidState: "连接会话状态无效",
    sessionClosed: "连接会话已关闭",
    transportConnectFailed: "无法建立服务器连接",
    transportConnectCancelFailed: "无法取消正在建立的服务器连接",
    transportClosed: "服务器连接已断开",
    transportFailure: "服务器连接发生故障",
    invalidTransportJson: "服务器返回了无效消息",
    inboundQueueOverflow: "服务器消息处理队列已满",
    inboundProcessingFailed: "无法处理服务器消息",
    initializationRejected: "app-server 拒绝初始化",
    invalidInitializationResponse: "app-server 返回了无效初始化响应",
    initializationWriteFailed: "无法发送 app-server 初始化请求",
    initializationInterrupted: "app-server 初始化已中断",
    initializationFailed: "app-server 初始化失败",
  });

const CONNECTION_START_FAILED_DETAIL = "连接启动失败";
const CONNECTION_SESSION_CREATION_FAILED_DETAIL = "无法创建连接会话";
const CONNECTION_ID_FAILED_DETAIL = "无法生成有效的连接标识";
const CONNECTION_CLOSE_FAILED_DETAIL = "无法关闭上一连接";

const CONNECTION_STAGE_DETAILS: Readonly<Record<AppServerConnectionStage, string>> =
  Object.freeze({
    resolvingTarget: "解析目标",
    connectingProxy: "连接代理",
    proxyAuthentication: "代理认证",
    establishingTunnel: "建立隧道",
    targetTls: "目标 TLS",
    webSocketHandshake: "WebSocket 握手",
    appServerInitialization: "app-server 初始化",
  });

export interface ConfiguredServerSessionHandle {
  readonly threadClient?: AppServerThreadClient;
  readonly conversationClient?: AppServerConversationClient;
  readonly capabilityClient?: AppServerCapabilityClient;
  readonly fileClient?: AppServerFileClient;
  readonly interactionClient?: AppServerInteractionClient;
  readonly accountClient?: AppServerAccountClient;
  start(): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConfiguredServerSessionFactoryOptions {
  readonly request: ConnectConfiguredServerRequest;
  readonly onStateChange: (state: AppServerSessionState) => void;
}

export type ConfiguredServerSessionFactory = (
  options: ConfiguredServerSessionFactoryOptions,
) => ConfiguredServerSessionHandle;

export type ConfiguredServerConnectionIdFactory = () => string;

export interface ConfiguredServerConnectionControllerOptions {
  readonly sessionFactory?: ConfiguredServerSessionFactory;
  readonly connectionIdFactory?: ConfiguredServerConnectionIdFactory;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface ReconnectViewState {
  readonly attempt: number;
  readonly nextAttemptAt: number | null;
}

export interface ConfiguredServerConnectionSnapshot {
  readonly currentServerId: ServerId | null;
  readonly connectionStage: AppServerConnectionStage | null;
  readonly threadClient: AppServerThreadClient | null;
  readonly conversationClient: AppServerConversationClient | null;
  readonly capabilityClient: AppServerCapabilityClient | null;
  readonly fileClient: AppServerFileClient | null;
  readonly interactionClient: AppServerInteractionClient | null;
  readonly accountClient: AppServerAccountClient | null;
  readonly reconnect: ReconnectViewState | null;
  readonly view: ConnectionViewState;
}

export interface ConfiguredServerConnectionControls extends ConfiguredServerConnectionSnapshot {
  readonly connect: (serverId: ServerId) => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly stopReconnect: () => void;
}

interface ConnectionTarget {
  readonly serverId: ServerId;
}

interface ActiveAttempt {
  readonly generation: number;
  session: ConfiguredServerSessionHandle | null;
}

export class ConfiguredServerConnectionController {
  private readonly sessionFactory: ConfiguredServerSessionFactory;
  private readonly connectionIdFactory: ConfiguredServerConnectionIdFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly usedConnectionIds = new Set<string>();
  private readonly usedConnectionIdOrder: string[] = [];
  private readonly listeners = new Set<() => void>();

  private snapshotValue: ConfiguredServerConnectionSnapshot = Object.freeze({
    currentServerId: null,
    connectionStage: null,
    threadClient: null,
    conversationClient: null,
    capabilityClient: null,
    fileClient: null,
    interactionClient: null,
    accountClient: null,
    reconnect: null,
    view: DISCONNECTED_VIEW,
  });
  private currentTarget: ConnectionTarget | null = null;
  private activeAttempt: ActiveAttempt | null = null;
  private closeBarrier: Promise<void> = Promise.resolve();
  private closeFailed = false;
  private generation = 0;
  private retainCount = 0;
  private releaseVersion = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectStopped = false;
  private hasReachedReady = false;
  private attemptStartedAt: number | null = null;
  private shortLocalProcessExitCount = 0;
  private connectionStage: AppServerConnectionStage | null = null;

  constructor(options: ConfiguredServerConnectionControllerOptions = {}) {
    this.sessionFactory =
      options.sessionFactory ?? defaultConfiguredServerSessionFactory;
    this.connectionIdFactory =
      options.connectionIdFactory ?? defaultConfiguredServerConnectionIdFactory;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  readonly getSnapshot = (): ConfiguredServerConnectionSnapshot =>
    this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly connect = (serverId: ServerId): Promise<void> => {
    const targetChanged = this.currentTarget?.serverId !== serverId;
    this.resumeReconnect(targetChanged);
    return this.replaceConnection({ serverId }, false);
  };

  readonly retry = (): Promise<void> => {
    const target = this.currentTarget;
    if (target === null || this.disposed) {
      return Promise.resolve();
    }
    this.resumeReconnect(false);
    return this.replaceConnection(target, false);
  };

  readonly stopReconnect = (): void => {
    this.reconnectStopped = true;
    this.clearReconnectTimer();
    this.updateSnapshot(
      this.snapshotValue.currentServerId,
      this.snapshotValue.view,
      null,
    );
  };

  readonly disconnect = async (): Promise<void> => {
    if (this.disposed) {
      return;
    }

    const generation = ++this.generation;
    this.reconnectStopped = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.connectionStage = null;
    this.attemptStartedAt = null;
    const session = this.detachActiveSession();
    this.updateSnapshot(
      this.currentTarget?.serverId ?? null,
      DISCONNECTED_VIEW,
    );
    await this.enqueueClose(session);

    if (!this.disposed && generation === this.generation && this.closeFailed) {
      this.updateSnapshot(
        this.currentTarget?.serverId ?? null,
        errorView(CONNECTION_CLOSE_FAILED_DETAIL),
      );
    }
  };

  retain(): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    this.retainCount += 1;
    this.releaseVersion += 1;
    let released = false;
    return () => {
      if (released || this.disposed) {
        return;
      }
      released = true;
      this.retainCount -= 1;
      const releaseVersion = ++this.releaseVersion;
      queueMicrotask(() => {
        if (
          !this.disposed &&
          this.retainCount === 0 &&
          releaseVersion === this.releaseVersion
        ) {
          void this.dispose();
        }
      });
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      return this.disposePromise;
    }

    this.disposed = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.listeners.clear();
    const session = this.detachActiveSession();
    this.disposePromise = this.enqueueClose(session);
    return this.disposePromise;
  }

  private async replaceConnection(
    target: ConnectionTarget,
    automatic: boolean,
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const generation = ++this.generation;
    this.currentTarget = target;
    this.connectionStage = null;
    const previousSession = this.detachActiveSession();
    this.updateSnapshot(
      target.serverId,
      CONNECTING_VIEW,
      automatic ? { attempt: this.reconnectAttempt, nextAttemptAt: null } : null,
    );
    await this.enqueueClose(previousSession);

    if (this.disposed || generation !== this.generation) {
      return;
    }
    if (this.closeFailed) {
      this.updateSnapshot(
        target.serverId,
        errorView(CONNECTION_CLOSE_FAILED_DETAIL),
      );
      return;
    }

    let connectionId: string;
    try {
      connectionId = this.allocateConnectionId();
    } catch {
      this.updateSnapshot(
        target.serverId,
        errorView(CONNECTION_ID_FAILED_DETAIL),
      );
      return;
    }

    const attempt: ActiveAttempt = { generation, session: null };
    this.activeAttempt = attempt;
    const request: ConnectConfiguredServerRequest = {
      connectionId,
      serverId: target.serverId,
    };

    let session: ConfiguredServerSessionHandle;
    try {
      session = this.sessionFactory({
        request,
        onStateChange: (state) => {
          this.handleSessionState(attempt, state);
        },
      });
    } catch {
      if (this.isCurrentAttempt(attempt)) {
        this.activeAttempt = null;
        this.updateSnapshot(
          target.serverId,
          errorView(CONNECTION_SESSION_CREATION_FAILED_DETAIL),
        );
      }
      return;
    }
    attempt.session = session;
    this.attemptStartedAt = this.now();

    if (!this.isCurrentAttempt(attempt)) {
      await this.enqueueClose(session);
      return;
    }

    try {
      await session.start();
    } catch (error) {
      if (!this.isCurrentAttempt(attempt)) {
        return;
      }
      if (this.snapshotValue.view.phase !== "error") {
        const errorCode = appServerSessionErrorCode(error);
        const detail =
          errorCode === null
            ? CONNECTION_START_FAILED_DETAIL
            : ERROR_DETAILS[errorCode];
        this.handleAttemptError(target.serverId, errorView(detail), errorCode);
      }
    }
  }

  private handleSessionState(
    attempt: ActiveAttempt,
    state: AppServerSessionState,
  ): void {
    if (!this.isCurrentAttempt(attempt)) {
      return;
    }
    const serverId = this.currentTarget?.serverId ?? null;
    this.connectionStage = state.connectionStage;
    const termination = state.transportTermination;
    const view = termination?.kind === "localProcess"
      ? errorView(localProcessExitDetail(termination, false))
      : mapAppServerSessionStateToConnectionView(state);
    if (state.phase === "ready") {
      this.hasReachedReady = true;
      this.reconnectAttempt = 0;
      this.reconnectStopped = false;
      this.clearReconnectTimer();
      this.updateSnapshot(serverId, view, null);
      return;
    }
    if (state.phase === "error") {
      if (this.recordLocalProcessExit(termination)) {
        this.reconnectStopped = true;
        this.clearReconnectTimer();
        this.updateSnapshot(
          serverId,
          errorView(localProcessExitDetail(termination!, true)),
          null,
        );
        return;
      }
      this.handleAttemptError(serverId, view, state.errorCode);
      return;
    }
    this.updateSnapshot(serverId, view, this.snapshotValue.reconnect);
  }

  private isCurrentAttempt(attempt: ActiveAttempt): boolean {
    return (
      !this.disposed &&
      this.activeAttempt === attempt &&
      attempt.generation === this.generation
    );
  }

  private detachActiveSession(): ConfiguredServerSessionHandle | null {
    const session = this.activeAttempt?.session ?? null;
    this.activeAttempt = null;
    return session;
  }

  private handleAttemptError(
    serverId: ServerId | null,
    view: ConnectionViewState,
    errorCode: AppServerSessionErrorCode | null,
  ): void {
    if (this.snapshotValue.view.phase === "error" && this.snapshotValue.reconnect !== null) {
      return;
    }
    if (
      serverId !== null &&
      this.hasReachedReady &&
      !this.reconnectStopped &&
      isRetryableConnectionError(errorCode)
    ) {
      this.scheduleReconnect(serverId, view);
    } else {
      this.updateSnapshot(serverId, view, null);
    }
  }

  private scheduleReconnect(serverId: ServerId, view: ConnectionViewState): void {
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const baseDelay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1)]!;
    const delay = Math.round(baseDelay * (0.9 + this.random() * 0.2));
    const nextAttemptAt = this.now() + delay;
    const scheduledGeneration = this.generation;
    this.updateSnapshot(serverId, view, {
      attempt: this.reconnectAttempt,
      nextAttemptAt,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (
        this.disposed ||
        this.reconnectStopped ||
        scheduledGeneration !== this.generation ||
        this.currentTarget?.serverId !== serverId
      ) {
        return;
      }
      void this.replaceConnection({ serverId }, true);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resumeReconnect(targetChanged: boolean): void {
    this.reconnectStopped = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.shortLocalProcessExitCount = 0;
    this.attemptStartedAt = null;
    if (targetChanged) {
      this.hasReachedReady = false;
    }
  }

  private recordLocalProcessExit(
    termination: AppServerSessionState["transportTermination"],
  ): boolean {
    if (termination?.kind !== "localProcess") {
      this.shortLocalProcessExitCount = 0;
      this.attemptStartedAt = null;
      return false;
    }
    const runtime = this.attemptStartedAt === null
      ? Number.POSITIVE_INFINITY
      : this.now() - this.attemptStartedAt;
    this.attemptStartedAt = null;
    this.shortLocalProcessExitCount = runtime <= SHORT_LOCAL_PROCESS_EXIT_MS
      ? this.shortLocalProcessExitCount + 1
      : 0;
    return this.shortLocalProcessExitCount >= MAX_SHORT_LOCAL_PROCESS_EXITS;
  }

  private enqueueClose(
    session: ConfiguredServerSessionHandle | null,
  ): Promise<void> {
    this.closeBarrier = this.closeBarrier.then(async () => {
      if (session === null) {
        return;
      }
      try {
        await session.close();
      } catch {
        this.closeFailed = true;
      }
    });
    return this.closeBarrier;
  }

  private allocateConnectionId(): string {
    for (
      let attempt = 0;
      attempt < MAX_CONNECTION_ID_ALLOCATION_ATTEMPTS;
      attempt += 1
    ) {
      const connectionId = this.connectionIdFactory();
      if (
        CONNECTION_ID_PATTERN.test(connectionId) &&
        !this.usedConnectionIds.has(connectionId)
      ) {
        this.usedConnectionIds.add(connectionId);
        this.usedConnectionIdOrder.push(connectionId);
        if (this.usedConnectionIdOrder.length > MAX_RETAINED_CONNECTION_IDS) {
          const expiredConnectionId = this.usedConnectionIdOrder.shift();
          if (expiredConnectionId !== undefined) {
            this.usedConnectionIds.delete(expiredConnectionId);
          }
        }
        return connectionId;
      }
    }
    throw new TypeError("invalid connection id");
  }

  private updateSnapshot(
    currentServerId: ServerId | null,
    view: ConnectionViewState,
    reconnect: ReconnectViewState | null = null,
  ): void {
    if (this.disposed) {
      return;
    }
    const threadClient =
      view.phase === "ready"
        ? (this.activeAttempt?.session?.threadClient ?? null)
        : null;
    const conversationClient =
      view.phase === "ready"
        ? (this.activeAttempt?.session?.conversationClient ?? null)
        : null;
    const capabilityClient =
      view.phase === "ready"
        ? (this.activeAttempt?.session?.capabilityClient ?? null)
        : null;
    const fileClient =
      view.phase === "ready"
        ? (this.activeAttempt?.session?.fileClient ?? null)
        : null;
    const interactionClient =
      view.phase === "ready"
        ? (this.activeAttempt?.session?.interactionClient ?? null)
        : null;
    const accountClient =
      view.phase === "ready"
        ? (this.activeAttempt?.session?.accountClient ?? null)
        : null;
    if (
      this.snapshotValue.currentServerId === currentServerId &&
      this.snapshotValue.connectionStage === this.connectionStage &&
      this.snapshotValue.threadClient === threadClient &&
      this.snapshotValue.conversationClient === conversationClient &&
      this.snapshotValue.capabilityClient === capabilityClient &&
      this.snapshotValue.fileClient === fileClient &&
      this.snapshotValue.interactionClient === interactionClient &&
      this.snapshotValue.accountClient === accountClient &&
      this.snapshotValue.reconnect?.attempt === reconnect?.attempt &&
      this.snapshotValue.reconnect?.nextAttemptAt === reconnect?.nextAttemptAt &&
      this.snapshotValue.view.phase === view.phase &&
      this.snapshotValue.view.detail === view.detail
    ) {
      return;
    }
    this.snapshotValue = Object.freeze({
      currentServerId,
      connectionStage: this.connectionStage,
      threadClient,
      conversationClient,
      capabilityClient,
      fileClient,
      interactionClient,
      accountClient,
      reconnect,
      view,
    });
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function useConfiguredServerConnection(
  options: ConfiguredServerConnectionControllerOptions = {},
): ConfiguredServerConnectionControls {
  const [controller] = useState(
    () => new ConfiguredServerConnectionController(options),
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => controller.retain(), [controller]);

  return useMemo(
    () => ({
      ...snapshot,
      connect: controller.connect,
      retry: controller.retry,
      disconnect: controller.disconnect,
      stopReconnect: controller.stopReconnect,
    }),
    [controller, snapshot],
  );
}

export function mapAppServerSessionStateToConnectionView(
  state: AppServerSessionState,
): ConnectionViewState {
  switch (state.phase) {
    case "idle":
    case "closing":
    case "closed":
      return DISCONNECTED_VIEW;
    case "connecting":
      return state.connectionStage === null
        ? CONNECTING_VIEW
        : Object.freeze({
            phase: "connecting",
            detail: CONNECTION_STAGE_DETAILS[state.connectionStage],
          });
    case "initializing":
      return INITIALIZING_VIEW;
    case "ready":
      return READY_VIEW;
    case "error":
      return errorView(
        state.errorCode === null
          ? CONNECTION_START_FAILED_DETAIL
          : ERROR_DETAILS[state.errorCode],
      );
  }
}

export function connectionStageDetail(stage: AppServerConnectionStage): string {
  return CONNECTION_STAGE_DETAILS[stage];
}

function defaultConfiguredServerSessionFactory(
  options: ConfiguredServerSessionFactoryOptions,
): ConfiguredServerSessionHandle {
  const session = createConfiguredServerAppServerSession(options);
  const interactionClient = new AppServerInteractionClient(session);
  return {
    threadClient: new AppServerThreadClient(session),
    conversationClient: new AppServerConversationClient(session),
    capabilityClient: new AppServerCapabilityClient(session),
    fileClient: new AppServerFileClient(session),
    interactionClient,
    accountClient: new AppServerAccountClient(session),
    start: () => session.start(),
    close: async () => {
      interactionClient.dispose();
      await session.close();
    },
  };
}

function defaultConfiguredServerConnectionIdFactory(): string {
  return crypto.randomUUID();
}

function errorView(detail: string): ConnectionViewState {
  return Object.freeze({ phase: "error", detail });
}

function appServerSessionErrorCode(
  error: unknown,
): AppServerSessionErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = error.code;
  return typeof code === "string" && Object.hasOwn(ERROR_DETAILS, code)
    ? (code as AppServerSessionErrorCode)
    : null;
}

function isRetryableConnectionError(
  errorCode: AppServerSessionErrorCode | null,
): boolean {
  return errorCode === "transportClosed" ||
    errorCode === "transportFailure" ||
    errorCode === "transportConnectFailed";
}

function localProcessExitDetail(
  termination: LocalProcessTermination,
  restartStopped: boolean,
): string {
  if (restartStopped) {
    return "本机进程连续 3 次短时间退出，请检查服务器配置后手动重新启动";
  }
  const result = termination.exitCode !== undefined
    ? `退出码 ${termination.exitCode}`
    : termination.signal !== undefined
      ? `信号 ${termination.signal}`
      : "退出状态未知";
  const stderr = termination.stderrBytes === 0
    ? "无标准错误输出"
    : `标准错误输出 ${termination.stderrBytes} 字节（内容已脱敏隐藏）`;
  return `本机进程已退出（${result}；${stderr}）`;
}
