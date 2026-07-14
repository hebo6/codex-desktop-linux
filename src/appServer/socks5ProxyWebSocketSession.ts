import { createSocks5ProxyWebSocketTransportConnector } from "../transport/socks5ProxyWebSocket";
import type {
  ConnectSocks5ProxyWebSocketRequest,
  Socks5ProxyWebSocketIpc,
} from "../transport/socks5ProxyWebSocket";
import { AppServerSession } from "./session";
import type { AppServerSessionOptions } from "./session";

export interface Socks5ProxyWebSocketAppServerSessionOptions
  extends Omit<AppServerSessionOptions, "connectTransport"> {
  readonly request: ConnectSocks5ProxyWebSocketRequest;
  readonly ipc?: Socks5ProxyWebSocketIpc;
}

export function createSocks5ProxyWebSocketAppServerSession(
  options: Socks5ProxyWebSocketAppServerSessionOptions,
): AppServerSession {
  const { request, ipc, ...sessionOptions } = options;
  return new AppServerSession({
    ...sessionOptions,
    connectTransport: createSocks5ProxyWebSocketTransportConnector(request, ipc),
  });
}
