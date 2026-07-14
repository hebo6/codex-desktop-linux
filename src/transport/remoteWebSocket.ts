import type { JSONRPCMessage } from "../protocol/generated";
import type {
  ProtocolTransport,
  ProtocolTransportConnector,
  TransportConnectionStage,
} from "./protocolTransport";
import { tauriIpc } from "./tauriIpc";
import type { TauriIpc } from "./tauriIpc";

const DIRECT_CONNECT_COMMAND = "connect_direct_websocket";
const SEND_COMMAND = "send_remote_websocket_message";
const DISCONNECT_COMMAND = "disconnect_remote_websocket";

const STATUSES = new Set<RemoteWebSocketStatus>([
  "connected",
  "disconnected",
  "error",
]);

const TERMINAL_STATUSES = new Set<RemoteWebSocketStatus>([
  "disconnected",
  "error",
]);

const TERMINATION_REASONS = new Set<RemoteWebSocketTerminationReason>([
  "requested",
  "remoteClosed",
  "invalidJson",
  "binaryMessage",
  "unsupportedMessage",
  "messageTooLarge",
  "readFailed",
  "writeFailed",
  "eventDeliveryFailed",
  "sshKeepAliveTimedOut",
]);

const CONNECTION_STAGES = new Set<TransportConnectionStage>([
  "resolvingTarget",
  "connectingProxy",
  "proxyAuthentication",
  "establishingTunnel",
  "targetTls",
  "webSocketHandshake",
]);

export type RemoteWebSocketStatus = "connected" | "disconnected" | "error";

export type RemoteWebSocketTerminationReason =
  | "requested"
  | "remoteClosed"
  | "invalidJson"
  | "binaryMessage"
  | "unsupportedMessage"
  | "messageTooLarge"
  | "readFailed"
  | "writeFailed"
  | "eventDeliveryFailed"
  | "sshKeepAliveTimedOut";

export interface ConnectDirectWebSocketRequest {
  readonly connectionId: string;
  readonly url: string;
  readonly insecureTransportConfirmed: boolean;
  readonly connectTimeoutMs: number;
  readonly nonSensitiveHeaders?: Readonly<Record<string, string>>;
}

export interface RemoteWebSocketStatusEvent {
  readonly kind: "status";
  readonly connectionId: string;
  readonly status: RemoteWebSocketStatus;
  readonly reason?: RemoteWebSocketTerminationReason;
  readonly closeCode?: number;
  readonly forced: boolean;
}

export interface RemoteWebSocketProtocolMessageEvent {
  readonly kind: "protocolMessage";
  readonly connectionId: string;
  readonly json: string;
}

export interface RemoteWebSocketProgressEvent {
  readonly kind: "progress";
  readonly connectionId: string;
  readonly stage: TransportConnectionStage;
}

export type RemoteWebSocketConnectionEvent =
  | RemoteWebSocketProgressEvent
  | RemoteWebSocketProtocolMessageEvent
  | RemoteWebSocketStatusEvent;

export type RemoteWebSocketBridgeErrorCode =
  | "invalidConnectionEvent"
  | "eventHandlerFailed"
  | "invalidConnectResponse"
  | "invalidOutboundMessage";

export class RemoteWebSocketBridgeError extends Error {
  readonly code: RemoteWebSocketBridgeErrorCode;

  constructor(code: RemoteWebSocketBridgeErrorCode) {
    super(`Remote WebSocket bridge failed: ${code}`);
    this.name = "RemoteWebSocketBridgeError";
    this.code = code;
  }
}

export interface RemoteWebSocketEventHandlers {
  readonly onProtocolMessage: (json: string) => void;
  readonly onProgress?: (event: RemoteWebSocketProgressEvent) => void;
  readonly onStatus: (event: RemoteWebSocketStatusEvent) => void;
  readonly onBridgeError?: (error: RemoteWebSocketBridgeError) => void;
}

interface ConnectRemoteWebSocketResponse {
  readonly connectionId: string;
}

export type RemoteWebSocketIpc = TauriIpc;

type ConnectionState = "connecting" | "active" | "disconnecting" | "closed";
export type RemoteWebSocketConnectCommand =
  | "connect_direct_websocket"
  | "connect_http_proxy_websocket"
  | "connect_socks5_proxy_websocket"
  | "connect_ssh_tunnel_websocket";

export class RemoteWebSocketConnection implements ProtocolTransport {
  readonly connectionId: string;

  private state: ConnectionState = "connecting";
  private disconnectPromise: Promise<void> | undefined;

  private constructor(
    connectionId: string,
    private readonly handlers: RemoteWebSocketEventHandlers,
    private readonly ipc: RemoteWebSocketIpc,
  ) {
    this.connectionId = connectionId;
  }

  static async connect(
    connectionId: string,
    connectCommand: RemoteWebSocketConnectCommand,
    request: Record<string, unknown>,
    handlers: RemoteWebSocketEventHandlers,
    ipc: RemoteWebSocketIpc = tauriIpc,
  ): Promise<RemoteWebSocketConnection> {
    const connection = new RemoteWebSocketConnection(
      connectionId,
      handlers,
      ipc,
    );
    const eventChannel = ipc.createEventChannel((event) =>
      connection.handleEvent(event),
    );

    let response: ConnectRemoteWebSocketResponse;
    try {
      response = await ipc.invoke<ConnectRemoteWebSocketResponse>(connectCommand, {
        request,
        events: eventChannel.channel,
      });
    } catch (error) {
      connection.state = "closed";
      throw error;
    }

    if (
      !isConnectResponse(response) ||
      response.connectionId !== connectionId
    ) {
      connection.notifyBridgeError(
        new RemoteWebSocketBridgeError("invalidConnectResponse"),
      );
      await connection.disconnectAfterInvalidEvent();
      throw new RemoteWebSocketBridgeError("invalidConnectResponse");
    }

    if (connection.state === "connecting") {
      connection.state = "active";
    }
    return connection;
  }

  async write(message: JSONRPCMessage): Promise<void> {
    if (this.state !== "active") {
      throw new Error("Remote WebSocket connection is not active");
    }

    let json: string;
    try {
      json = JSON.stringify(message);
    } catch {
      throw new RemoteWebSocketBridgeError("invalidOutboundMessage");
    }
    if (json === undefined) {
      throw new RemoteWebSocketBridgeError("invalidOutboundMessage");
    }

    await this.ipc.invoke<void>(SEND_COMMAND, {
      request: { connectionId: this.connectionId, json },
    });
  }

  disconnect(): Promise<void> {
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

  close(): Promise<void> {
    return this.disconnect();
  }

  private handleEvent(value: unknown): void {
    const event = parseRemoteWebSocketConnectionEvent(value);
    if (event === undefined || event.connectionId !== this.connectionId) {
      this.notifyBridgeError(
        new RemoteWebSocketBridgeError("invalidConnectionEvent"),
      );
      void this.disconnectAfterInvalidEvent();
      return;
    }

    try {
      if (event.kind === "progress") {
        if (this.state === "connecting") {
          this.handlers.onProgress?.(event);
        }
        return;
      }
      if (event.kind === "protocolMessage") {
        if (this.state === "connecting" || this.state === "active") {
          this.handlers.onProtocolMessage(event.json);
        }
        return;
      }

      if (event.status === "connected" && this.state === "connecting") {
        this.state = "active";
      }
      if (TERMINAL_STATUSES.has(event.status)) {
        this.state = "closed";
      }
      this.handlers.onStatus(event);
    } catch {
      this.notifyBridgeError(
        new RemoteWebSocketBridgeError("eventHandlerFailed"),
      );
      void this.disconnectAfterInvalidEvent();
    }
  }

  private async disconnectAfterInvalidEvent(): Promise<void> {
    try {
      await this.disconnect();
    } catch {
      this.state = "closed";
    }
  }

  private notifyBridgeError(error: RemoteWebSocketBridgeError): void {
    try {
      this.handlers.onBridgeError?.(error);
    } catch {
      // 诊断旁路不能改变连接清理路径
    }
  }
}

export const DirectWebSocketConnection = Object.freeze({
  connect(
    request: ConnectDirectWebSocketRequest,
    handlers: RemoteWebSocketEventHandlers,
    ipc: RemoteWebSocketIpc = tauriIpc,
  ): Promise<RemoteWebSocketConnection> {
    return RemoteWebSocketConnection.connect(
      request.connectionId,
      DIRECT_CONNECT_COMMAND,
      normalizedRequest(request),
      handlers,
      ipc,
    );
  },
});

export function createDirectWebSocketTransportConnector(
  request: ConnectDirectWebSocketRequest,
  ipc: RemoteWebSocketIpc = tauriIpc,
): ProtocolTransportConnector {
  return (handlers) =>
    DirectWebSocketConnection.connect(
      request,
      {
        onProtocolMessage: handlers.onProtocolMessage,
        onProgress(event) {
          handlers.onConnectionProgress?.(event.stage);
        },
        onStatus(event) {
          if (TERMINAL_STATUSES.has(event.status)) {
            handlers.onTransportClosed();
          }
        },
        onBridgeError() {
          handlers.onTransportFailure();
        },
      },
      ipc,
    );
}

function normalizedRequest(
  request: ConnectDirectWebSocketRequest,
): Record<string, unknown> {
  return {
    connectionId: request.connectionId,
    url: request.url,
    insecureTransportConfirmed: request.insecureTransportConfirmed,
    connectTimeoutMs: request.connectTimeoutMs,
    nonSensitiveHeaders:
      request.nonSensitiveHeaders === undefined
        ? {}
        : { ...request.nonSensitiveHeaders },
  };
}

function isConnectResponse(value: unknown): value is ConnectRemoteWebSocketResponse {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.connectionId === "string" &&
    hasOnlyKeys(record, ["connectionId"])
  );
}

export function parseRemoteWebSocketConnectionEvent(
  value: unknown,
): RemoteWebSocketConnectionEvent | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.connectionId !== "string") {
    return undefined;
  }

  if (
    record.kind === "progress" &&
    typeof record.stage === "string" &&
    CONNECTION_STAGES.has(record.stage as TransportConnectionStage) &&
    hasOnlyKeys(record, ["kind", "connectionId", "stage"])
  ) {
    return {
      kind: "progress",
      connectionId: record.connectionId,
      stage: record.stage as TransportConnectionStage,
    };
  }

  if (
    record.kind === "protocolMessage" &&
    typeof record.json === "string" &&
    hasOnlyKeys(record, ["kind", "connectionId", "json"])
  ) {
    return {
      kind: "protocolMessage",
      connectionId: record.connectionId,
      json: record.json,
    };
  }

  if (
    record.kind !== "status" ||
    typeof record.status !== "string" ||
    !STATUSES.has(record.status as RemoteWebSocketStatus) ||
    typeof record.forced !== "boolean" ||
    !isOptionalReason(record.reason) ||
    !isOptionalCloseCode(record.closeCode) ||
    !hasOnlyKeys(record, [
      "kind",
      "connectionId",
      "status",
      "reason",
      "closeCode",
      "forced",
    ])
  ) {
    return undefined;
  }

  const status = record.status as RemoteWebSocketStatus;
  const reason = record.reason as RemoteWebSocketTerminationReason | undefined;
  if (
    (status === "connected" &&
      (reason !== undefined || record.closeCode !== undefined || record.forced)) ||
    (status !== "connected" &&
      (reason === undefined || statusForReason(reason) !== status)) ||
    (record.closeCode !== undefined && reason !== "remoteClosed")
  ) {
    return undefined;
  }

  return {
    kind: "status",
    connectionId: record.connectionId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(record.closeCode === undefined
      ? {}
      : { closeCode: record.closeCode as number }),
    forced: record.forced,
  };
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

function isOptionalReason(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      TERMINATION_REASONS.has(value as RemoteWebSocketTerminationReason))
  );
}

function isOptionalCloseCode(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 65_535)
  );
}

function statusForReason(
  reason: RemoteWebSocketTerminationReason,
): RemoteWebSocketStatus {
  return reason === "requested" || reason === "remoteClosed"
    ? "disconnected"
    : "error";
}
