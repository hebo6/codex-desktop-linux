import type { ProtocolTransportConnector } from "./protocolTransport";
import { RemoteWebSocketConnection } from "./remoteWebSocket";
import type {
  RemoteWebSocketEventHandlers,
  RemoteWebSocketIpc,
} from "./remoteWebSocket";
import { tauriIpc } from "./tauriIpc";

const CONNECT_COMMAND = "connect_socks5_proxy_websocket";

export type Socks5DnsResolution = "proxy" | "local";

export interface Socks5ProxyWebSocketTargetRequest {
  readonly url: string;
  readonly insecureTransportConfirmed: boolean;
  readonly connectTimeoutMs: number;
  readonly nonSensitiveHeaders?: Readonly<Record<string, string>>;
}

export interface Socks5ProxyRequest {
  readonly host: string;
  readonly port: number;
  readonly dnsResolution?: Socks5DnsResolution;
  readonly connectTimeoutMs: number;
}

export interface ConnectSocks5ProxyWebSocketRequest {
  readonly connectionId: string;
  readonly target: Socks5ProxyWebSocketTargetRequest;
  readonly proxy: Socks5ProxyRequest;
}

export type Socks5ProxyWebSocketIpc = RemoteWebSocketIpc;

export const Socks5ProxyWebSocketConnection = Object.freeze({
  connect(
    request: ConnectSocks5ProxyWebSocketRequest,
    handlers: RemoteWebSocketEventHandlers,
    ipc: Socks5ProxyWebSocketIpc = tauriIpc,
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

export function createSocks5ProxyWebSocketTransportConnector(
  request: ConnectSocks5ProxyWebSocketRequest,
  ipc: Socks5ProxyWebSocketIpc = tauriIpc,
): ProtocolTransportConnector {
  return (handlers) =>
    Socks5ProxyWebSocketConnection.connect(
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

function normalizedRequest(
  request: ConnectSocks5ProxyWebSocketRequest,
): Record<string, unknown> {
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
    proxy: {
      host: request.proxy.host,
      port: request.proxy.port,
      dnsResolution: request.proxy.dnsResolution ?? "proxy",
      connectTimeoutMs: request.proxy.connectTimeoutMs,
    },
  };
}
