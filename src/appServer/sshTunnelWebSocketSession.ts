import { createSshTunnelWebSocketTransportConnector } from "../transport/sshTunnelWebSocket";
import type {
  ConnectSshTunnelWebSocketRequest,
  SshTunnelWebSocketIpc,
} from "../transport/sshTunnelWebSocket";
import { AppServerSession } from "./session";
import type { AppServerSessionOptions } from "./session";

export interface SshTunnelWebSocketAppServerSessionOptions
  extends Omit<AppServerSessionOptions, "connectTransport"> {
  readonly request: ConnectSshTunnelWebSocketRequest;
  readonly ipc?: SshTunnelWebSocketIpc;
}

export function createSshTunnelWebSocketAppServerSession(
  options: SshTunnelWebSocketAppServerSessionOptions,
): AppServerSession {
  const { request, ipc, ...sessionOptions } = options;
  return new AppServerSession({
    ...sessionOptions,
    connectTransport: createSshTunnelWebSocketTransportConnector(request, ipc),
  });
}
