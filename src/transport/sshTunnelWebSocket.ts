import type { ProtocolTransportConnector } from "./protocolTransport";
import { RemoteWebSocketConnection } from "./remoteWebSocket";
import type {
  RemoteWebSocketEventHandlers,
  RemoteWebSocketIpc,
} from "./remoteWebSocket";
import { tauriIpc } from "./tauriIpc";

const CONNECT_COMMAND = "connect_ssh_tunnel_websocket";
const DEFAULT_SSH_PORT = 22;

export interface SshTunnelWebSocketTargetRequest {
  readonly url: string;
  readonly insecureTransportConfirmed: boolean;
  readonly connectTimeoutMs: number;
  readonly nonSensitiveHeaders?: Readonly<Record<string, string>>;
}

export type SshTunnelAuthenticationRequest =
  | { readonly type: "agent" }
  | { readonly type: "privateKey"; readonly privateKeyPath: string };

export interface SshHostKeyRequest {
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
}

export interface SshTunnelRequest {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly authentication: SshTunnelAuthenticationRequest;
  readonly hostKey?: SshHostKeyRequest;
  readonly connectTimeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly keepAliveMaxFailures: number;
}

export interface ConnectSshTunnelWebSocketRequest {
  readonly connectionId: string;
  readonly target: SshTunnelWebSocketTargetRequest;
  readonly tunnel: SshTunnelRequest;
}

export interface SshHostKeyIdentity {
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
}

export type SshHostKeyErrorDetails =
  | {
      readonly kind: "sshHostKeyUnknown";
      readonly host: string;
      readonly port: number;
      readonly received: SshHostKeyIdentity;
    }
  | {
      readonly kind: "sshHostKeyChanged";
      readonly host: string;
      readonly port: number;
      readonly expected: SshHostKeyIdentity;
      readonly received: SshHostKeyIdentity;
    };

export type SshHostKeyCommandError =
  | {
      readonly code: "sshHostKeyUnknown";
      readonly message: string;
      readonly details: Extract<
        SshHostKeyErrorDetails,
        { readonly kind: "sshHostKeyUnknown" }
      >;
    }
  | {
      readonly code: "sshHostKeyChanged";
      readonly message: string;
      readonly details: Extract<
        SshHostKeyErrorDetails,
        { readonly kind: "sshHostKeyChanged" }
      >;
    };

export type SshTunnelWebSocketIpc = RemoteWebSocketIpc;

export const SshTunnelWebSocketConnection = Object.freeze({
  connect(
    request: ConnectSshTunnelWebSocketRequest,
    handlers: RemoteWebSocketEventHandlers,
    ipc: SshTunnelWebSocketIpc = tauriIpc,
  ): Promise<RemoteWebSocketConnection> {
    return RemoteWebSocketConnection.connect(
      request.connectionId,
      CONNECT_COMMAND,
      normalizedRequest(request),
      handlers,
      ipc,
    );
  },
});

export function createSshTunnelWebSocketTransportConnector(
  request: ConnectSshTunnelWebSocketRequest,
  ipc: SshTunnelWebSocketIpc = tauriIpc,
): ProtocolTransportConnector {
  return (handlers) =>
    SshTunnelWebSocketConnection.connect(
      request,
      {
        onProtocolMessage: handlers.onProtocolMessage,
        onStatus(event) {
          if (event.status !== "connected") {
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

export function isSshHostKeyCommandError(
  value: unknown,
): value is SshHostKeyCommandError {
  const error = asRecord(value);
  if (
    error === undefined ||
    !hasOnlyKeys(error, ["code", "message", "details"]) ||
    (error.code !== "sshHostKeyUnknown" && error.code !== "sshHostKeyChanged") ||
    typeof error.message !== "string"
  ) {
    return false;
  }
  const details = asRecord(error.details);
  if (
    details === undefined ||
    details.kind !== error.code ||
    typeof details.host !== "string" ||
    details.host.length === 0 ||
    !isPort(details.port) ||
    !isHostKeyIdentity(details.received)
  ) {
    return false;
  }
  if (error.code === "sshHostKeyUnknown") {
    return hasOnlyKeys(details, ["kind", "host", "port", "received"]);
  }
  return (
    hasOnlyKeys(details, ["kind", "host", "port", "expected", "received"]) &&
    isHostKeyIdentity(details.expected)
  );
}

function normalizedRequest(
  request: ConnectSshTunnelWebSocketRequest,
): Record<string, unknown> {
  const tunnel: Record<string, unknown> = {
    host: request.tunnel.host,
    port: request.tunnel.port ?? DEFAULT_SSH_PORT,
    username: request.tunnel.username,
    authentication: normalizedAuthentication(request.tunnel.authentication),
    connectTimeoutMs: request.tunnel.connectTimeoutMs,
    keepAliveIntervalMs: request.tunnel.keepAliveIntervalMs,
    keepAliveMaxFailures: request.tunnel.keepAliveMaxFailures,
  };
  if (request.tunnel.hostKey !== undefined) {
    tunnel.hostKey = {
      algorithm: request.tunnel.hostKey.algorithm,
      sha256Fingerprint: request.tunnel.hostKey.sha256Fingerprint,
    };
  }
  return {
    connectionId: request.connectionId,
    target: {
      url: request.target.url,
      insecureTransportConfirmed: request.target.insecureTransportConfirmed,
      connectTimeoutMs: request.target.connectTimeoutMs,
      nonSensitiveHeaders:
        request.target.nonSensitiveHeaders === undefined
          ? {}
          : { ...request.target.nonSensitiveHeaders },
    },
    tunnel,
  };
}

function normalizedAuthentication(
  authentication: SshTunnelAuthenticationRequest,
): Record<string, unknown> {
  switch (authentication.type) {
    case "agent":
      return { type: "agent" };
    case "privateKey":
      return {
        type: "privateKey",
        privateKeyPath: authentication.privateKeyPath,
      };
  }
}

function isHostKeyIdentity(value: unknown): value is SshHostKeyIdentity {
  const identity = asRecord(value);
  return (
    identity !== undefined &&
    hasOnlyKeys(identity, ["algorithm", "sha256Fingerprint"]) &&
    typeof identity.algorithm === "string" &&
    identity.algorithm.length > 0 &&
    typeof identity.sha256Fingerprint === "string" &&
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(identity.sha256Fingerprint)
  );
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}
