import type { ProxyId, ServerId } from "../configuration/model";
import type { JSONRPCMessage } from "../protocol/generated";
import { parseLocalStdioConnectionEvent } from "./localStdio";
import type { LocalStdioConnectionEvent } from "./localStdio";
import type {
  ProtocolTransport,
  ProtocolTransportConnector,
  ProtocolTransportEventHandlers,
  ProtocolTransportTermination,
} from "./protocolTransport";
import { parseRemoteWebSocketConnectionEvent } from "./remoteWebSocket";
import type { RemoteWebSocketConnectionEvent } from "./remoteWebSocket";
import { tauriIpc } from "./tauriIpc";
import type { TauriIpc } from "./tauriIpc";

const CONNECT_COMMAND = "connect_configured_server";
const CANCEL_CONNECT_COMMAND = "cancel_configured_server_connection";
const SEND_COMMAND = "send_configured_server_message";
const DISCONNECT_COMMAND = "disconnect_configured_server";
const MAX_PENDING_CONNECTION_EVENTS = 64;

const CONNECTION_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type ConfiguredServerTransportKind = "localStdio" | "remoteWebSocket";

export type ConfiguredServerConnectionPath =
  "localStdio" | "direct" | "httpConnect" | "socks5" | "sshDirectTcpip";

export interface ConnectConfiguredServerRequest {
  readonly connectionId: string;
  readonly serverId: ServerId;
}

interface BaseConnectionInfo {
  readonly connectionId: string;
  readonly serverId: ServerId;
  readonly serverVersion: number;
}

export type ConfiguredServerConnectionInfo =
  | (BaseConnectionInfo & {
      readonly transport: "localStdio";
      readonly connectionPath: "localStdio";
    })
  | (BaseConnectionInfo & {
      readonly transport: "remoteWebSocket";
      readonly connectionPath: "direct";
    })
  | (BaseConnectionInfo & {
      readonly transport: "remoteWebSocket";
      readonly connectionPath: "httpConnect" | "socks5" | "sshDirectTcpip";
      readonly proxyId: ProxyId;
      readonly proxyVersion: number;
    });

export type ConfiguredServerBridgeErrorCode =
  | "connectionCancelled"
  | "connectionCancellationFailed"
  | "invalidConnectRequest"
  | "invalidConnectResponse"
  | "invalidConnectionEvent"
  | "eventHandlerFailed"
  | "invalidOutboundMessage";

export class ConfiguredServerBridgeError extends Error {
  readonly code: ConfiguredServerBridgeErrorCode;

  constructor(code: ConfiguredServerBridgeErrorCode) {
    super(`Configured server bridge failed: ${code}`);
    this.name = "ConfiguredServerBridgeError";
    this.code = code;
  }
}

export type ConfiguredServerIpc = TauriIpc;

type ConnectionState = "connecting" | "active" | "disconnecting" | "closed";

type ParsedConnectionEvent =
  | {
      readonly transport: "localStdio";
      readonly event: LocalStdioConnectionEvent;
    }
  | {
      readonly transport: "remoteWebSocket";
      readonly event: RemoteWebSocketConnectionEvent;
    };

export interface ConfiguredServerTransport extends ProtocolTransport {
  readonly connectionId: string;
  readonly serverId: ServerId;
  readonly connectionInfo: ConfiguredServerConnectionInfo;
}

export type ConfiguredServerTransportConnector = ProtocolTransportConnector & {
  readonly cancelPending: () => Promise<void>;
};

export class ConfiguredServerConnection implements ConfiguredServerTransport {
  readonly connectionId: string;
  readonly serverId: ServerId;

  private state: ConnectionState = "connecting";
  private info: ConfiguredServerConnectionInfo | undefined;
  private observedTransport: ConfiguredServerTransportKind | undefined;
  private readonly pendingEvents: ParsedConnectionEvent[] = [];
  private bridgeFailure: ConfiguredServerBridgeError | undefined;
  private disconnectPromise: Promise<void> | undefined;
  private connectResponseReceived = false;

  private constructor(
    request: ConnectConfiguredServerRequest,
    private readonly handlers: ProtocolTransportEventHandlers,
    private readonly ipc: ConfiguredServerIpc,
  ) {
    this.connectionId = request.connectionId;
    this.serverId = request.serverId;
  }

  get connectionInfo(): ConfiguredServerConnectionInfo {
    if (this.info === undefined) {
      throw new ConfiguredServerBridgeError("invalidConnectResponse");
    }
    return this.info;
  }

  static async connect(
    request: ConnectConfiguredServerRequest,
    handlers: ProtocolTransportEventHandlers,
    ipc: ConfiguredServerIpc = tauriIpc,
  ): Promise<ConfiguredServerConnection> {
    const normalizedRequest = normalizeConnectRequest(request);
    const connection = new ConfiguredServerConnection(
      normalizedRequest,
      handlers,
      ipc,
    );
    const eventChannel = ipc.createEventChannel((event) => {
      connection.handleEvent(event);
    });

    let rawResponse: unknown;
    try {
      rawResponse = await ipc.invoke<unknown>(CONNECT_COMMAND, {
        request: normalizedRequest,
        events: eventChannel.channel,
      });
    } catch (error) {
      if (connection.bridgeFailure !== undefined) {
        await connection.finishFailedConnection();
        throw connection.bridgeFailure;
      }
      connection.state = "closed";
      throw error;
    }
    connection.connectResponseReceived = true;

    const info = parseConnectResponse(
      rawResponse,
      normalizedRequest.connectionId,
      normalizedRequest.serverId,
    );
    if (
      info === undefined ||
      (connection.observedTransport !== undefined &&
        connection.observedTransport !== info.transport)
    ) {
      connection.fail("invalidConnectResponse");
    } else {
      connection.info = info;
      connection.flushPendingEvents();
      if (
        connection.bridgeFailure === undefined &&
        connection.state === "connecting"
      ) {
        connection.state = "active";
      }
    }

    if (connection.bridgeFailure !== undefined) {
      await connection.finishFailedConnection();
      throw connection.bridgeFailure;
    }
    return connection;
  }

  async write(message: JSONRPCMessage): Promise<void> {
    if (this.state !== "active") {
      throw new Error("Configured server connection is not active");
    }

    let json: string;
    try {
      json = JSON.stringify(message);
    } catch {
      throw new ConfiguredServerBridgeError("invalidOutboundMessage");
    }
    if (json === undefined) {
      throw new ConfiguredServerBridgeError("invalidOutboundMessage");
    }

    await this.ipc.invoke<void>(SEND_COMMAND, {
      request: { connectionId: this.connectionId, json },
    });
  }

  close(): Promise<void> {
    if (this.state === "closed") {
      return Promise.resolve();
    }
    return this.disconnectConfigured();
  }

  private handleEvent(value: unknown): void {
    if (this.state === "closed" || this.bridgeFailure !== undefined) {
      return;
    }

    const parsed = parseConnectionEvent(
      value,
      this.connectionId,
      this.serverId,
    );
    if (parsed === undefined) {
      this.fail("invalidConnectionEvent");
      return;
    }
    if (
      (this.observedTransport !== undefined &&
        this.observedTransport !== parsed.transport) ||
      (this.info !== undefined && this.info.transport !== parsed.transport)
    ) {
      this.fail("invalidConnectionEvent");
      return;
    }
    this.observedTransport = parsed.transport;

    if (this.info === undefined) {
      if (this.pendingEvents.length >= MAX_PENDING_CONNECTION_EVENTS) {
        this.fail("invalidConnectionEvent");
        return;
      }
      this.pendingEvents.push(parsed);
      return;
    }
    this.deliverEvent(parsed);
  }

  private flushPendingEvents(): void {
    const pending = this.pendingEvents.splice(0);
    for (const event of pending) {
      if (this.bridgeFailure !== undefined) {
        break;
      }
      this.deliverEvent(event);
    }
  }

  private deliverEvent(parsed: ParsedConnectionEvent): void {
    try {
      if (parsed.event.kind === "progress") {
        if (this.state === "connecting") {
          this.handlers.onConnectionProgress?.(parsed.event.stage);
        }
        return;
      }
      if (parsed.event.kind === "protocolMessage") {
        if (this.state === "connecting" || this.state === "active") {
          this.handlers.onProtocolMessage(parsed.event.json);
        }
        return;
      }

      if (parsed.event.status === "connected" && this.state === "connecting") {
        this.state = "active";
      }
      if (parsed.event.status !== "connected") {
        this.state = "closed";
        this.handlers.onTransportClosed(
          parsed.transport === "localStdio"
            ? localProcessTermination(parsed.event)
            : undefined,
        );
      }
    } catch {
      this.fail("eventHandlerFailed");
    }
  }

  private fail(code: ConfiguredServerBridgeErrorCode): void {
    if (this.bridgeFailure !== undefined) {
      return;
    }
    this.bridgeFailure = new ConfiguredServerBridgeError(code);
    this.pendingEvents.splice(0);
    try {
      this.handlers.onTransportFailure();
    } catch {
      // 诊断旁路不能改变连接清理路径
    }
    if (this.connectResponseReceived) {
      void this.disconnectConfigured().catch(() => {
        this.state = "closed";
      });
    }
  }

  private async finishFailedConnection(): Promise<void> {
    if (this.disconnectPromise !== undefined) {
      try {
        await this.disconnectPromise;
      } catch {
        this.state = "closed";
      }
      return;
    }
    if (!this.connectResponseReceived) {
      this.state = "closed";
      return;
    }
    try {
      await this.disconnectConfigured();
    } catch {
      this.state = "closed";
    }
  }

  private disconnectConfigured(): Promise<void> {
    if (this.state === "closed") {
      return Promise.resolve();
    }
    if (this.disconnectPromise !== undefined) {
      return this.disconnectPromise;
    }

    this.state = "disconnecting";
    this.disconnectPromise = this.ipc
      .invoke<void>(DISCONNECT_COMMAND, {
        request: { connectionId: this.connectionId },
      })
      .finally(() => {
        this.state = "closed";
      });
    return this.disconnectPromise;
  }
}

function localProcessTermination(
  event: Extract<LocalStdioConnectionEvent, { kind: "status" }>,
): ProtocolTransportTermination {
  return {
    kind: "localProcess",
    status: event.status as "disconnected" | "exited" | "error",
    reason: event.reason!,
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.signal === undefined ? {} : { signal: event.signal }),
    stderrBytes: event.stderrBytes,
    forced: event.forced,
  };
}

export function createConfiguredServerTransportConnector(
  request: ConnectConfiguredServerRequest,
  ipc: ConfiguredServerIpc = tauriIpc,
): ConfiguredServerTransportConnector {
  const stableRequest = normalizeConnectRequest(request);
  let state: "idle" | "connecting" | "cancelling" | "cancelled" | "settled" =
    "idle";
  let cancellationPromise: Promise<void> | undefined;
  const currentState = () => state;

  const connect: ProtocolTransportConnector = async (handlers) => {
    if (state === "cancelled") {
      throw new ConfiguredServerBridgeError("connectionCancelled");
    }
    if (state !== "idle") {
      throw new ConfiguredServerBridgeError("invalidConnectRequest");
    }
    state = "connecting";
    try {
      return await ConfiguredServerConnection.connect(
        stableRequest,
        handlers,
        ipc,
      );
    } catch (error) {
      // state 可在等待 connect IPC 时由 cancelPending 闭包改变。通过读取函数
      // 显式表达这项并发事实，避免把进入 await 前的窄化状态当成当前状态
      if (currentState() === "cancelling") {
        throw new ConfiguredServerBridgeError("connectionCancelled");
      }
      throw error;
    } finally {
      state = "settled";
    }
  };

  const cancelPending = (): Promise<void> => {
    if (state === "idle") {
      state = "cancelled";
      return Promise.resolve();
    }
    if (state === "cancelled" || state === "settled") {
      return Promise.resolve();
    }
    if (cancellationPromise !== undefined) {
      return cancellationPromise;
    }

    state = "cancelling";
    cancellationPromise = ipc
      .invoke<void>(CANCEL_CONNECT_COMMAND, {
        request: { connectionId: stableRequest.connectionId },
      })
      .catch(() => {
        throw new ConfiguredServerBridgeError("connectionCancellationFailed");
      });
    return cancellationPromise;
  };

  return Object.assign(connect, { cancelPending });
}

function normalizeConnectRequest(
  request: ConnectConfiguredServerRequest,
): ConnectConfiguredServerRequest {
  const rawRequest = asRecord(request);
  if (
    rawRequest === undefined ||
    !hasOnlyKeys(rawRequest, ["connectionId", "serverId"]) ||
    typeof rawRequest.connectionId !== "string" ||
    !CONNECTION_ID_PATTERN.test(rawRequest.connectionId) ||
    typeof rawRequest.serverId !== "string" ||
    !UUID_V4_PATTERN.test(rawRequest.serverId)
  ) {
    throw new ConfiguredServerBridgeError("invalidConnectRequest");
  }

  return Object.freeze({
    connectionId: rawRequest.connectionId,
    serverId: rawRequest.serverId as ServerId,
  });
}

function parseConnectResponse(
  value: unknown,
  connectionId: string,
  serverId: ServerId,
): ConfiguredServerConnectionInfo | undefined {
  const response = asRecord(value);
  if (
    response === undefined ||
    response.connectionId !== connectionId ||
    response.serverId !== serverId ||
    !isVersion(response.serverVersion) ||
    !isTransport(response.transport) ||
    !isConnectionPath(response.connectionPath)
  ) {
    return undefined;
  }

  const base = {
    connectionId,
    serverId,
    serverVersion: response.serverVersion,
  } as const;
  if (response.transport === "localStdio") {
    return response.connectionPath === "localStdio" &&
      hasOnlyKeys(response, [
        "connectionId",
        "serverId",
        "serverVersion",
        "transport",
        "connectionPath",
      ])
      ? Object.freeze({
          ...base,
          transport: "localStdio",
          connectionPath: "localStdio",
        })
      : undefined;
  }
  if (response.connectionPath === "direct") {
    return hasOnlyKeys(response, [
      "connectionId",
      "serverId",
      "serverVersion",
      "transport",
      "connectionPath",
    ])
      ? Object.freeze({
          ...base,
          transport: "remoteWebSocket",
          connectionPath: "direct",
        })
      : undefined;
  }
  if (
    response.connectionPath === "localStdio" ||
    typeof response.proxyId !== "string" ||
    !UUID_V4_PATTERN.test(response.proxyId) ||
    !isVersion(response.proxyVersion) ||
    !hasOnlyKeys(response, [
      "connectionId",
      "serverId",
      "serverVersion",
      "transport",
      "connectionPath",
      "proxyId",
      "proxyVersion",
    ])
  ) {
    return undefined;
  }
  return Object.freeze({
    ...base,
    transport: "remoteWebSocket",
    connectionPath: response.connectionPath,
    proxyId: response.proxyId as ProxyId,
    proxyVersion: response.proxyVersion,
  });
}

function parseConnectionEvent(
  value: unknown,
  connectionId: string,
  serverId: ServerId,
): ParsedConnectionEvent | undefined {
  const envelope = asRecord(value);
  if (
    envelope === undefined ||
    envelope.serverId !== serverId ||
    !isTransport(envelope.transport) ||
    !hasOnlyKeys(envelope, ["serverId", "transport", "event"])
  ) {
    return undefined;
  }

  if (envelope.transport === "localStdio") {
    const event = parseLocalStdioConnectionEvent(envelope.event);
    return event?.connectionId === connectionId
      ? { transport: "localStdio", event }
      : undefined;
  }
  const event = parseRemoteWebSocketConnectionEvent(envelope.event);
  return event?.connectionId === connectionId
    ? { transport: "remoteWebSocket", event }
    : undefined;
}

function isTransport(value: unknown): value is ConfiguredServerTransportKind {
  return value === "localStdio" || value === "remoteWebSocket";
}

function isConnectionPath(
  value: unknown,
): value is ConfiguredServerConnectionPath {
  return (
    value === "localStdio" ||
    value === "direct" ||
    value === "httpConnect" ||
    value === "socks5" ||
    value === "sshDirectTcpip"
  );
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}
