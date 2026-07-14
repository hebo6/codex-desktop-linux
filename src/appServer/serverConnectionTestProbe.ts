import {
  createServerConnectionTestTransportConnector,
  ServerConnectionTestBridgeError,
  ServerConnectionTestCommandError,
  type ConnectServerConnectionTestRequest,
  type ServerConnectionTestIpc,
  type ServerConnectionTestTransportConnector,
} from "../transport/serverConnectionTest";
import {
  AppServerSession,
  type AppServerSessionDiagnostic,
  type AppServerSessionOptions,
} from "./session";

export type ServerConnectionTestTransportConnectorFactory = (
  request: ConnectServerConnectionTestRequest,
  ipc?: ServerConnectionTestIpc,
) => ServerConnectionTestTransportConnector;

export interface ServerConnectionTestProbeOptions extends Omit<
  AppServerSessionOptions,
  "connectTransport" | "cancelTransportConnect" | "onDiagnostic"
> {
  readonly request: ConnectServerConnectionTestRequest;
  readonly ipc?: ServerConnectionTestIpc;
  readonly onDiagnostic?: (diagnostic: AppServerSessionDiagnostic) => void;
  readonly connectorFactory?: ServerConnectionTestTransportConnectorFactory;
}

export interface ServerConnectionTestProbe {
  readonly run: () => Promise<void>;
  readonly cancel: () => Promise<void>;
}

export class ServerConnectionTestProbeError extends Error {
  readonly code = "transportCloseFailed";

  constructor() {
    super("Server connection test transport could not be closed");
    this.name = "ServerConnectionTestProbeError";
  }
}

export function createServerConnectionTestProbe(
  options: ServerConnectionTestProbeOptions,
): ServerConnectionTestProbe {
  const {
    request,
    ipc,
    connectorFactory = createServerConnectionTestTransportConnector,
    onDiagnostic,
    ...sessionOptions
  } = options;
  const connector = connectorFactory(request, ipc);
  let transportConnectError: ServerConnectionTestCommandError | undefined;
  let transportCleanupError: ServerConnectionTestBridgeError | undefined;
  let transportCloseFailed = false;
  const session = new AppServerSession({
    ...sessionOptions,
    connectTransport: async (handlers) => {
      try {
        return await connector(handlers);
      } catch (error) {
        if (error instanceof ServerConnectionTestCommandError) {
          transportConnectError = error;
        }
        if (
          error instanceof ServerConnectionTestBridgeError &&
          error.code === "connectionCancellationFailed"
        ) {
          transportCleanupError = error;
        }
        throw error;
      }
    },
    cancelTransportConnect: connector.cancelPending,
    onDiagnostic: (diagnostic) => {
      if (
        diagnostic.source === "session" &&
        diagnostic.code === "transportCloseFailed"
      ) {
        transportCloseFailed = true;
      }
      onDiagnostic?.(diagnostic);
    },
  });
  let runPromise: Promise<void> | null = null;
  let cancelPromise: Promise<void> | null = null;

  const cancel = (): Promise<void> => {
    if (cancelPromise !== null) {
      return cancelPromise;
    }
    cancelPromise = session.close().then(() => {
      if (transportCleanupError !== undefined) {
        throw transportCleanupError;
      }
      if (transportCloseFailed) {
        throw new ServerConnectionTestProbeError();
      }
    });
    return cancelPromise;
  };

  const run = (): Promise<void> => {
    if (runPromise !== null) {
      return runPromise;
    }
    runPromise = (async () => {
      let startFailed = false;
      let startError: unknown;
      try {
        await session.start();
      } catch (error) {
        startFailed = true;
        startError = transportConnectError ?? error;
      }

      let closeError: unknown;
      try {
        await cancel();
      } catch (error) {
        closeError = error;
      }
      if (closeError !== undefined) {
        throw closeError;
      }
      if (startFailed) {
        throw startError;
      }
    })();
    return runPromise;
  };

  return Object.freeze({ run, cancel });
}
