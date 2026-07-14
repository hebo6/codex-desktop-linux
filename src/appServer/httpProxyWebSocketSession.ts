import { createHttpProxyWebSocketTransportConnector } from "../transport/httpProxyWebSocket";
import type {
  ConnectHttpProxyWebSocketRequest,
  HttpProxyWebSocketIpc,
} from "../transport/httpProxyWebSocket";
import { AppServerSession } from "./session";
import type { AppServerSessionOptions } from "./session";

export interface HttpProxyWebSocketAppServerSessionOptions
  extends Omit<AppServerSessionOptions, "connectTransport"> {
  readonly request: ConnectHttpProxyWebSocketRequest;
  readonly ipc?: HttpProxyWebSocketIpc;
}

export function createHttpProxyWebSocketAppServerSession(
  options: HttpProxyWebSocketAppServerSessionOptions,
): AppServerSession {
  const { request, ipc, ...sessionOptions } = options;
  return new AppServerSession({
    ...sessionOptions,
    connectTransport: createHttpProxyWebSocketTransportConnector(request, ipc),
  });
}
