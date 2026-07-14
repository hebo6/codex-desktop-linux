import { createLocalStdioTransportConnector } from "../transport/localStdio";
import type {
  ConnectLocalStdioRequest,
  LocalStdioIpc,
} from "../transport/localStdio";
import { AppServerSession } from "./session";
import type { AppServerSessionOptions } from "./session";

export interface LocalStdioAppServerSessionOptions
  extends Omit<AppServerSessionOptions, "connectTransport"> {
  readonly request: ConnectLocalStdioRequest;
  readonly ipc?: LocalStdioIpc;
}

export function createLocalStdioAppServerSession(
  options: LocalStdioAppServerSessionOptions,
): AppServerSession {
  const { request, ipc, ...sessionOptions } = options;
  return new AppServerSession({
    ...sessionOptions,
    connectTransport: createLocalStdioTransportConnector(request, ipc),
  });
}
