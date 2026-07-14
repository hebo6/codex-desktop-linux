import type { JSONRPCMessage } from "../protocol/generated";
import type {
  ProtocolTransport,
  ProtocolTransportConnector,
  ProtocolTransportTermination,
} from "./protocolTransport";
import { tauriIpc } from "./tauriIpc";
import type { TauriIpc } from "./tauriIpc";

const CONNECT_COMMAND = "connect_local_stdio";
const SEND_COMMAND = "send_local_stdio_message";
const DISCONNECT_COMMAND = "disconnect_local_stdio";

const TERMINAL_STATUSES = new Set<LocalStdioStatus>([
  "disconnected",
  "exited",
  "error",
]);

const STATUSES = new Set<LocalStdioStatus>([
  "connected",
  "disconnected",
  "exited",
  "error",
]);

const TERMINATION_REASONS = new Set<LocalStdioTerminationReason>([
  "requested",
  "processExited",
  "invalidUtf8",
  "invalidJson",
  "lineTooLong",
  "stdoutReadFailed",
  "eventDeliveryFailed",
  "childWaitFailed",
]);

export type LocalStdioStatus = "connected" | "disconnected" | "exited" | "error";

export type LocalStdioTerminationReason =
  | "requested"
  | "processExited"
  | "invalidUtf8"
  | "invalidJson"
  | "lineTooLong"
  | "stdoutReadFailed"
  | "eventDeliveryFailed"
  | "childWaitFailed";

export interface ConnectLocalStdioRequest {
  readonly connectionId: string;
  readonly executablePath: string;
  readonly arguments?: readonly string[];
  readonly workingDirectory: string;
  readonly nonSensitiveEnvironment?: Readonly<Record<string, string>>;
}

export interface LocalStdioStatusEvent {
  readonly kind: "status";
  readonly connectionId: string;
  readonly status: LocalStdioStatus;
  readonly reason?: LocalStdioTerminationReason;
  readonly exitCode?: number;
  readonly signal?: number;
  readonly stderrBytes: number;
  readonly forced: boolean;
}

export interface LocalStdioProtocolMessageEvent {
  readonly kind: "protocolMessage";
  readonly connectionId: string;
  readonly json: string;
}

export type LocalStdioConnectionEvent =
  | LocalStdioProtocolMessageEvent
  | LocalStdioStatusEvent;

export type LocalStdioBridgeErrorCode =
  | "invalidConnectionEvent"
  | "eventHandlerFailed"
  | "invalidConnectResponse"
  | "invalidOutboundMessage";

export class LocalStdioBridgeError extends Error {
  readonly code: LocalStdioBridgeErrorCode;

  constructor(code: LocalStdioBridgeErrorCode) {
    super(`Local stdio bridge failed: ${code}`);
    this.name = "LocalStdioBridgeError";
    this.code = code;
  }
}

export interface LocalStdioEventHandlers {
  readonly onProtocolMessage: (json: string) => void;
  readonly onStatus: (event: LocalStdioStatusEvent) => void;
  readonly onBridgeError?: (error: LocalStdioBridgeError) => void;
}

interface ConnectLocalStdioResponse {
  readonly connectionId: string;
}

export type LocalStdioIpc = TauriIpc;

type ConnectionState = "connecting" | "active" | "disconnecting" | "closed";

export class LocalStdioConnection implements ProtocolTransport {
  readonly connectionId: string;

  private state: ConnectionState = "connecting";
  private disconnectPromise: Promise<void> | undefined;

  private constructor(
    connectionId: string,
    private readonly handlers: LocalStdioEventHandlers,
    private readonly ipc: LocalStdioIpc,
  ) {
    this.connectionId = connectionId;
  }

  static async connect(
    request: ConnectLocalStdioRequest,
    handlers: LocalStdioEventHandlers,
    ipc: LocalStdioIpc = tauriIpc,
  ): Promise<LocalStdioConnection> {
    const connection = new LocalStdioConnection(request.connectionId, handlers, ipc);
    const eventChannel = ipc.createEventChannel((event) => connection.handleEvent(event));

    let response: ConnectLocalStdioResponse;
    try {
      response = await ipc.invoke<ConnectLocalStdioResponse>(CONNECT_COMMAND, {
        request: normalizedRequest(request),
        events: eventChannel.channel,
      });
    } catch (error) {
      connection.state = "closed";
      throw error;
    }

    if (!isConnectResponse(response) || response.connectionId !== request.connectionId) {
      connection.notifyBridgeError(new LocalStdioBridgeError("invalidConnectResponse"));
      await connection.disconnectAfterInvalidEvent();
      throw new LocalStdioBridgeError("invalidConnectResponse");
    }

    if (connection.state === "connecting") {
      connection.state = "active";
    }
    return connection;
  }

  async write(message: JSONRPCMessage): Promise<void> {
    if (this.state !== "active") {
      throw new Error("Local stdio connection is not active");
    }

    let json: string;
    try {
      json = JSON.stringify(message);
    } catch {
      throw new LocalStdioBridgeError("invalidOutboundMessage");
    }
    if (json === undefined) {
      throw new LocalStdioBridgeError("invalidOutboundMessage");
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
    const event = parseLocalStdioConnectionEvent(value);
    if (event === undefined || event.connectionId !== this.connectionId) {
      this.notifyBridgeError(new LocalStdioBridgeError("invalidConnectionEvent"));
      void this.disconnectAfterInvalidEvent();
      return;
    }

    try {
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
      this.notifyBridgeError(new LocalStdioBridgeError("eventHandlerFailed"));
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

  private notifyBridgeError(error: LocalStdioBridgeError): void {
    try {
      this.handlers.onBridgeError?.(error);
    } catch {
      // 诊断旁路不能改变连接清理路径
    }
  }
}

export function createLocalStdioTransportConnector(
  request: ConnectLocalStdioRequest,
  ipc: LocalStdioIpc = tauriIpc,
): ProtocolTransportConnector {
  return (handlers) =>
    LocalStdioConnection.connect(
      request,
      {
        onProtocolMessage: handlers.onProtocolMessage,
        onStatus(event) {
          if (TERMINAL_STATUSES.has(event.status)) {
            handlers.onTransportClosed(localProcessTermination(event));
          }
        },
        onBridgeError() {
          handlers.onTransportFailure();
        },
      },
      ipc,
    );
}

function localProcessTermination(
  event: LocalStdioStatusEvent,
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

function normalizedRequest(request: ConnectLocalStdioRequest): Record<string, unknown> {
  return {
    connectionId: request.connectionId,
    executablePath: request.executablePath,
    arguments: request.arguments === undefined ? [] : [...request.arguments],
    workingDirectory: request.workingDirectory,
    nonSensitiveEnvironment:
      request.nonSensitiveEnvironment === undefined
        ? {}
        : { ...request.nonSensitiveEnvironment },
  };
}

function isConnectResponse(value: unknown): value is ConnectLocalStdioResponse {
  const record = asRecord(value);
  return record !== undefined && typeof record.connectionId === "string";
}

export function parseLocalStdioConnectionEvent(
  value: unknown,
): LocalStdioConnectionEvent | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.connectionId !== "string") {
    return undefined;
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
    !STATUSES.has(record.status as LocalStdioStatus) ||
    typeof record.stderrBytes !== "number" ||
    !Number.isSafeInteger(record.stderrBytes) ||
    record.stderrBytes < 0 ||
    typeof record.forced !== "boolean" ||
    !isOptionalInteger(record.exitCode) ||
    !isOptionalInteger(record.signal) ||
    !isOptionalReason(record.reason) ||
    !hasOnlyKeys(record, [
      "kind",
      "connectionId",
      "status",
      "reason",
      "exitCode",
      "signal",
      "stderrBytes",
      "forced",
    ])
  ) {
    return undefined;
  }

  const status = record.status as LocalStdioStatus;
  const reason = record.reason as LocalStdioTerminationReason | undefined;
  if (
    (status === "connected" &&
      (reason !== undefined ||
        record.exitCode !== undefined ||
        record.signal !== undefined ||
        record.stderrBytes !== 0 ||
        record.forced)) ||
    (status !== "connected" &&
      (reason === undefined || statusForReason(reason) !== status))
  ) {
    return undefined;
  }

  return {
    kind: "status",
    connectionId: record.connectionId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode as number }),
    ...(record.signal === undefined ? {} : { signal: record.signal as number }),
    stderrBytes: record.stderrBytes,
    forced: record.forced,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isOptionalInteger(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}

function isOptionalReason(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "string" &&
      TERMINATION_REASONS.has(value as LocalStdioTerminationReason));
}

function statusForReason(reason: LocalStdioTerminationReason): LocalStdioStatus {
  if (reason === "requested") {
    return "disconnected";
  }
  if (reason === "processExited") {
    return "exited";
  }
  return "error";
}
