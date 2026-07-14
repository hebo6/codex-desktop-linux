import type { ProtocolTransportConnector } from "./protocolTransport";
import { RemoteWebSocketConnection } from "./remoteWebSocket";
import type {
  RemoteWebSocketEventHandlers,
  RemoteWebSocketIpc,
} from "./remoteWebSocket";
import { tauriIpc } from "./tauriIpc";

const CONNECT_COMMAND = "connect_http_proxy_websocket";

export interface HttpProxyWebSocketTargetRequest {
  readonly url: string;
  readonly insecureTransportConfirmed: boolean;
  readonly connectTimeoutMs: number;
  readonly nonSensitiveHeaders?: Readonly<Record<string, string>>;
}

export interface HttpConnectProxyRequest {
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly nonSensitiveHeaders?: Readonly<Record<string, string>>;
}

export interface ConnectHttpProxyWebSocketRequest {
  readonly connectionId: string;
  readonly target: HttpProxyWebSocketTargetRequest;
  readonly proxy: HttpConnectProxyRequest;
}

export type HttpProxyWebSocketIpc = RemoteWebSocketIpc;

export const HttpProxyWebSocketConnection = Object.freeze({
  connect(
    request: ConnectHttpProxyWebSocketRequest,
    handlers: RemoteWebSocketEventHandlers,
    ipc: HttpProxyWebSocketIpc = tauriIpc,
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

export function createHttpProxyWebSocketTransportConnector(
  request: ConnectHttpProxyWebSocketRequest,
  ipc: HttpProxyWebSocketIpc = tauriIpc,
): ProtocolTransportConnector {
  return (handlers) =>
    HttpProxyWebSocketConnection.connect(
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
  request: ConnectHttpProxyWebSocketRequest,
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
      url: request.proxy.url,
      connectTimeoutMs: request.proxy.connectTimeoutMs,
      nonSensitiveHeaders:
        request.proxy.nonSensitiveHeaders === undefined
          ? {}
          : { ...request.proxy.nonSensitiveHeaders },
    },
  };
}
