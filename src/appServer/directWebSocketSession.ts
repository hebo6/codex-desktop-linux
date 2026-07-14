import { createDirectWebSocketTransportConnector } from "../transport/directWebSocket";
import type {
  ConnectDirectWebSocketRequest,
  DirectWebSocketIpc,
} from "../transport/directWebSocket";
import { AppServerSession } from "./session";
import type { AppServerSessionOptions } from "./session";

export interface DirectWebSocketAppServerSessionOptions
  extends Omit<AppServerSessionOptions, "connectTransport"> {
  readonly request: ConnectDirectWebSocketRequest;
  readonly ipc?: DirectWebSocketIpc;
}

export function createDirectWebSocketAppServerSession(
  options: DirectWebSocketAppServerSessionOptions,
): AppServerSession {
  const { request, ipc, ...sessionOptions } = options;
  return new AppServerSession({
    ...sessionOptions,
    connectTransport: createDirectWebSocketTransportConnector(request, ipc),
  });
}
