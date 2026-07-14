import { createConfiguredServerTransportConnector } from "../transport/configuredServer";
import type {
  ConfiguredServerIpc,
  ConnectConfiguredServerRequest,
} from "../transport/configuredServer";
import { AppServerSession } from "./session";
import type { AppServerSessionOptions } from "./session";

export interface ConfiguredServerAppServerSessionOptions extends Omit<
  AppServerSessionOptions,
  "connectTransport" | "cancelTransportConnect"
> {
  readonly request: ConnectConfiguredServerRequest;
  readonly ipc?: ConfiguredServerIpc;
}

export function createConfiguredServerAppServerSession(
  options: ConfiguredServerAppServerSessionOptions,
): AppServerSession {
  const { request, ipc, ...sessionOptions } = options;
  const connectTransport = createConfiguredServerTransportConnector(
    request,
    ipc,
  );
  return new AppServerSession({
    ...sessionOptions,
    connectTransport,
    cancelTransportConnect: connectTransport.cancelPending,
  });
}
