import {
  normalizeCreateProxyProfileRequest,
  normalizeServerConfigurationInput,
  normalizeSetProxyCredentialRequest,
  normalizeSetServerCredentialRequest,
} from "../configuration";
import type {
  ProxyConfigurationInput,
  ProxyCredential,
  ProxyId,
  ServerConfigurationInput,
  ServerCredential,
  ServerId,
} from "../configuration";
import type { JSONRPCMessage } from "../protocol/generated";
import { parseLocalStdioConnectionEvent } from "./localStdio";
import type { LocalStdioConnectionEvent } from "./localStdio";
import type {
  ProtocolTransport,
  ProtocolTransportConnector,
  ProtocolTransportEventHandlers,
} from "./protocolTransport";
import { parseRemoteWebSocketConnectionEvent } from "./remoteWebSocket";
import type { RemoteWebSocketConnectionEvent } from "./remoteWebSocket";
import { tauriIpc } from "./tauriIpc";
import type { TauriIpc } from "./tauriIpc";

const CONNECT_COMMAND = "connect_server_connection_test";
const CANCEL_CONNECT_COMMAND = "cancel_server_connection_test";
const LOCAL_SEND_COMMAND = "send_local_stdio_message";
const LOCAL_DISCONNECT_COMMAND = "disconnect_local_stdio";
const REMOTE_SEND_COMMAND = "send_remote_websocket_message";
const REMOTE_DISCONNECT_COMMAND = "disconnect_remote_websocket";
const MAX_PENDING_CONNECTION_EVENTS = 64;

const CONNECTION_ID_PATTERN = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SSH_SHA256_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{42}[AQgw]$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const CREDENTIAL_VALIDATION_SERVER_ID =
  "00000000-0000-4000-8000-000000000000" as ServerId;
const CREDENTIAL_VALIDATION_PROXY_ID =
  "00000000-0000-4000-8000-000000000000" as ProxyId;

const COMMAND_ERROR_CODES = [
  "configurationCorrupt",
  "configurationDatabaseFailed",
  "connectionAlreadyExists",
  "connectionCancelled",
  "connectionManagerShuttingDown",
  "connectionNotFound",
  "connectionNotOwned",
  "connectionTimedOut",
  "credentialAccessDenied",
  "credentialConfigurationMismatch",
  "credentialNotConfigured",
  "credentialNotFound",
  "credentialPromptDismissed",
  "credentialRecordInvalid",
  "credentialServiceLocked",
  "credentialServiceTimedOut",
  "credentialServiceUnavailable",
  "credentialStorageFailed",
  "eventDeliveryFailed",
  "httpProxyAuthenticationFailed",
  "httpProxyConnectRejected",
  "httpProxyConnectTimedOut",
  "httpProxyNetworkConnectFailed",
  "httpProxyProtocolFailed",
  "httpProxyTlsFailed",
  "insecureTransportNotConfirmed",
  "invalidArguments",
  "invalidConfigurationVersion",
  "invalidConnectTimeout",
  "invalidConnectionId",
  "invalidCredentialValue",
  "invalidEnvironment",
  "invalidExecutablePath",
  "invalidHttpConnectRequest",
  "invalidHttpProxyAuthentication",
  "invalidHttpProxyConnectTimeout",
  "invalidHttpProxyHeaders",
  "invalidHttpProxyTlsCertificatePolicy",
  "invalidHttpProxyUrl",
  "invalidNonSensitiveEnvironment",
  "invalidNonSensitiveHeaders",
  "invalidPlaintextConfirmation",
  "invalidProtocolMessage",
  "invalidProxyHost",
  "invalidProxyPort",
  "invalidRemoteAuthentication",
  "invalidServerArguments",
  "invalidSensitiveEnvironment",
  "invalidSocks5ProxyAuthentication",
  "invalidSocks5ProxyConnectTimeout",
  "invalidSocks5ProxyHost",
  "invalidSocks5ProxyPort",
  "invalidSocks5TargetAddress",
  "invalidSshConnectTimeout",
  "invalidSshHost",
  "invalidSshHostKeyRecord",
  "invalidSshKeepAliveFailures",
  "invalidSshKeepAliveInterval",
  "invalidSshPort",
  "invalidSshPrivateKeyPath",
  "invalidSshUsername",
  "invalidTlsCertificatePolicy",
  "invalidWebSocketUrl",
  "invalidWorkingDirectory",
  "networkConnectFailed",
  "processStartFailed",
  "protocolWriteFailed",
  "proxyNotFound",
  "proxyVersionConflict",
  "serverConfigurationMismatch",
  "serverNotFound",
  "serverVersionConflict",
  "socks5AddressTypeNotSupported",
  "socks5CommandNotSupported",
  "socks5ConnectFailed",
  "socks5ConnectionNotAllowed",
  "socks5ConnectionRefused",
  "socks5HostUnreachable",
  "socks5LocalDnsResolutionFailed",
  "socks5NetworkUnreachable",
  "socks5ProxyAuthenticationFailed",
  "socks5ProxyConnectTimedOut",
  "socks5ProxyNetworkConnectFailed",
  "socks5ProxyProtocolFailed",
  "socks5TargetConnectTimedOut",
  "socks5TtlExpired",
  "sshAdditionalAuthenticationRequired",
  "sshAgentCommunicationFailed",
  "sshAgentNoMatchingKey",
  "sshAgentSigningFailed",
  "sshAgentUnavailable",
  "sshAlgorithmNegotiationFailed",
  "sshAuthenticationProtocolFailed",
  "sshAuthenticationRejected",
  "sshConnectTimedOut",
  "sshHandshakeFailed",
  "sshHostKeyChanged",
  "sshHostKeyUnknown",
  "sshNetworkConnectFailed",
  "sshPrivateKeyInvalid",
  "sshPrivateKeyNotFound",
  "sshPrivateKeyPassphraseRequired",
  "sshPrivateKeyUnreadable",
  "sshRsaSha2Unsupported",
  "sshTargetConnectFailed",
  "sshTunnelProhibited",
  "sshTunnelRejected",
  "sshTunnelResourceShortage",
  "sshTunnelUnsupported",
  "targetTlsFailed",
  "tlsConfigurationFailed",
  "webSocketConnectFailed",
  "webSocketHandshakeRejected",
  "workingDirectoryRequired",
] as const;

const COMMAND_ERROR_CODE_SET = new Set<string>(COMMAND_ERROR_CODES);

export type ServerConnectionTestTransportKind =
  "localStdio" | "remoteWebSocket";

export type ServerConnectionTestPath =
  "localStdio" | "direct" | "httpConnect" | "socks5" | "sshDirectTcpip";

export type ServerConnectionTestCredentialSource =
  | { readonly type: "none" }
  | {
      readonly type: "provided";
      readonly credential: ServerCredential;
    }
  | {
      readonly type: "stored";
      readonly serverId: ServerId;
      readonly expectedVersion: number;
    };

export type ProxyConnectionTestCredentialSource =
  | { readonly type: "none" }
  | { readonly type: "provided"; readonly credential: ProxyCredential }
  | {
      readonly type: "stored";
      readonly proxyId: ProxyId;
      readonly expectedVersion: number;
    };

export interface ProxyConnectionTestHostKey {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
}

export interface ProxyConnectionTestInput {
  readonly configuration: ProxyConfigurationInput;
  readonly credentialSource: ProxyConnectionTestCredentialSource;
  readonly sshHostKey?: ProxyConnectionTestHostKey;
}

export interface ConnectServerConnectionTestRequest {
  readonly connectionId: string;
  readonly configuration: ServerConfigurationInput;
  readonly credentialSource: ServerConnectionTestCredentialSource;
  readonly proxy?: ProxyConnectionTestInput;
}

interface BaseConnectionInfo {
  readonly connectionId: string;
}

export type ServerConnectionTestInfo =
  | (BaseConnectionInfo & {
      readonly transport: "localStdio";
      readonly connectionPath: "localStdio";
    })
  | (BaseConnectionInfo & {
      readonly transport: "remoteWebSocket";
      readonly connectionPath: "direct";
    })
  | (BaseConnectionInfo & {
      readonly transport: "remoteWebSocket";
      readonly connectionPath: "httpConnect" | "socks5" | "sshDirectTcpip";
      readonly proxyId?: ProxyId;
      readonly proxyVersion?: number;
    });

export type ServerConnectionTestBridgeErrorCode =
  | "connectionCancelled"
  | "connectionCancellationFailed"
  | "invalidConnectRequest"
  | "invalidConnectResponse"
  | "invalidConnectionEvent"
  | "eventHandlerFailed"
  | "invalidOutboundMessage";

export class ServerConnectionTestBridgeError extends Error {
  readonly code: ServerConnectionTestBridgeErrorCode;

  constructor(code: ServerConnectionTestBridgeErrorCode) {
    super(`Server connection test bridge failed: ${code}`);
    this.name = "ServerConnectionTestBridgeError";
    this.code = code;
  }
}

export type ServerConnectionTestCommandErrorCode =
  (typeof COMMAND_ERROR_CODES)[number] | "connectionTestFailed";

export interface SshHostKeyIdentity {
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
}

export type ServerConnectionTestCommandErrorDetails =
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

export class ServerConnectionTestCommandError extends Error {
  readonly code: ServerConnectionTestCommandErrorCode;
  readonly statusCode: number | undefined;
  readonly details: ServerConnectionTestCommandErrorDetails | undefined;

  constructor(
    code: ServerConnectionTestCommandErrorCode,
    options: {
      readonly statusCode?: number;
      readonly details?: ServerConnectionTestCommandErrorDetails;
    } = {},
  ) {
    super(`Server connection test failed: ${code}`);
    this.name = "ServerConnectionTestCommandError";
    this.code = code;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}

export type ServerConnectionTestIpc = TauriIpc;

type ConnectionState = "connecting" | "active" | "disconnecting" | "closed";

type ParsedConnectionEvent =
  | {
      readonly transport: "localStdio";
      readonly event: LocalStdioConnectionEvent;
    }
  | {
      readonly transport: "remoteWebSocket";
      readonly event: RemoteWebSocketConnectionEvent;
    };

export interface ServerConnectionTestTransport extends ProtocolTransport {
  readonly connectionId: string;
  readonly connectionInfo: ServerConnectionTestInfo;
}

export type ServerConnectionTestTransportConnector =
  ProtocolTransportConnector & {
    readonly cancelPending: () => Promise<void>;
  };

export class ServerConnectionTestConnection implements ServerConnectionTestTransport {
  readonly connectionId: string;

  private state: ConnectionState = "connecting";
  private info: ServerConnectionTestInfo | undefined;
  private observedTransport: ServerConnectionTestTransportKind | undefined;
  private readonly pendingEvents: ParsedConnectionEvent[] = [];
  private bridgeFailure: ServerConnectionTestBridgeError | undefined;
  private disconnectPromise: Promise<void> | undefined;
  private connectResponseReceived = false;
  private readonly expectedTransport: ServerConnectionTestTransportKind;

  private constructor(
    request: ConnectServerConnectionTestRequest,
    private readonly handlers: ProtocolTransportEventHandlers,
    private readonly ipc: ServerConnectionTestIpc,
  ) {
    this.connectionId = request.connectionId;
    this.expectedTransport =
      request.configuration.type === "localStdio"
        ? "localStdio"
        : "remoteWebSocket";
  }

  get connectionInfo(): ServerConnectionTestInfo {
    if (this.info === undefined) {
      throw new ServerConnectionTestBridgeError("invalidConnectResponse");
    }
    return this.info;
  }

  static async connect(
    request: ConnectServerConnectionTestRequest,
    handlers: ProtocolTransportEventHandlers,
    ipc: ServerConnectionTestIpc = tauriIpc,
  ): Promise<ServerConnectionTestConnection> {
    const normalizedRequest = normalizeConnectRequest(request);
    const connection = new ServerConnectionTestConnection(
      normalizedRequest,
      handlers,
      ipc,
    );
    const eventChannel = ipc.createEventChannel((event) => {
      connection.handleEvent(event);
    });

    let rawResponse: unknown;
    try {
      rawResponse = await ipc.invoke<unknown>(CONNECT_COMMAND, {
        request: normalizedRequest,
        events: eventChannel.channel,
      });
    } catch (error) {
      if (connection.bridgeFailure !== undefined) {
        await connection.finishFailedConnection();
        throw connection.bridgeFailure;
      }
      connection.state = "closed";
      throw parseServerConnectionTestCommandError(error);
    }
    connection.connectResponseReceived = true;

    const info = parseConnectResponse(
      rawResponse,
      normalizedRequest.connectionId,
    );
    if (
      info === undefined ||
      info.transport !== connection.expectedTransport ||
      (connection.observedTransport !== undefined &&
        connection.observedTransport !== info.transport)
    ) {
      connection.fail("invalidConnectResponse");
    } else {
      connection.info = info;
      connection.flushPendingEvents();
      if (
        connection.bridgeFailure === undefined &&
        connection.state === "connecting"
      ) {
        connection.state = "active";
      }
    }

    if (connection.bridgeFailure !== undefined) {
      await connection.finishFailedConnection();
      throw connection.bridgeFailure;
    }
    return connection;
  }

  async write(message: JSONRPCMessage): Promise<void> {
    if (this.state !== "active") {
      throw new Error("Server connection test is not active");
    }

    let json: string;
    try {
      json = JSON.stringify(message);
    } catch {
      throw new ServerConnectionTestBridgeError("invalidOutboundMessage");
    }
    if (json === undefined) {
      throw new ServerConnectionTestBridgeError("invalidOutboundMessage");
    }

    try {
      await this.ipc.invoke<void>(sendCommand(this.connectionInfo.transport), {
        request: { connectionId: this.connectionId, json },
      });
    } catch (error) {
      throw parseServerConnectionTestCommandError(error);
    }
  }

  close(): Promise<void> {
    if (this.state === "closed") {
      return Promise.resolve();
    }
    return this.disconnectWithTransport(this.connectionInfo.transport);
  }

  private handleEvent(value: unknown): void {
    if (this.state === "closed" || this.bridgeFailure !== undefined) {
      return;
    }

    const parsed = parseConnectionEvent(value, this.connectionId);
    if (parsed === undefined) {
      this.fail("invalidConnectionEvent");
      return;
    }
    if (
      parsed.transport !== this.expectedTransport ||
      (this.observedTransport !== undefined &&
        this.observedTransport !== parsed.transport) ||
      (this.info !== undefined && this.info.transport !== parsed.transport)
    ) {
      this.fail("invalidConnectionEvent");
      return;
    }
    this.observedTransport = parsed.transport;

    if (this.info === undefined) {
      if (this.pendingEvents.length >= MAX_PENDING_CONNECTION_EVENTS) {
        this.fail("invalidConnectionEvent");
        return;
      }
      this.pendingEvents.push(parsed);
      return;
    }
    this.deliverEvent(parsed);
  }

  private flushPendingEvents(): void {
    const pending = this.pendingEvents.splice(0);
    for (const event of pending) {
      if (this.bridgeFailure !== undefined) {
        break;
      }
      this.deliverEvent(event);
    }
  }

  private deliverEvent(parsed: ParsedConnectionEvent): void {
    try {
      if (parsed.event.kind === "progress") {
        if (this.state === "connecting") {
          this.handlers.onConnectionProgress?.(parsed.event.stage);
        }
        return;
      }
      if (parsed.event.kind === "protocolMessage") {
        if (this.state === "connecting" || this.state === "active") {
          this.handlers.onProtocolMessage(parsed.event.json);
        }
        return;
      }

      if (parsed.event.status === "connected" && this.state === "connecting") {
        this.state = "active";
      }
      if (parsed.event.status !== "connected") {
        this.state = "closed";
        this.handlers.onTransportClosed();
      }
    } catch {
      this.fail("eventHandlerFailed");
    }
  }

  private fail(code: ServerConnectionTestBridgeErrorCode): void {
    if (this.bridgeFailure !== undefined) {
      return;
    }
    this.bridgeFailure = new ServerConnectionTestBridgeError(code);
    this.pendingEvents.splice(0);
    try {
      this.handlers.onTransportFailure();
    } catch {
      // 诊断旁路不能改变连接清理路径
    }
    if (this.connectResponseReceived) {
      void this.disconnectWithTransport(this.expectedTransport).catch(() => {
        this.state = "closed";
      });
    }
  }

  private async finishFailedConnection(): Promise<void> {
    if (this.disconnectPromise !== undefined) {
      try {
        await this.disconnectPromise;
      } catch {
        this.state = "closed";
        throw new ServerConnectionTestBridgeError(
          "connectionCancellationFailed",
        );
      }
      return;
    }
    if (
      this.info === undefined &&
      this.observedTransport === undefined &&
      !this.connectResponseReceived
    ) {
      this.state = "closed";
      return;
    }
    try {
      await this.disconnectWithTransport(this.expectedTransport);
    } catch {
      this.state = "closed";
      throw new ServerConnectionTestBridgeError("connectionCancellationFailed");
    }
  }

  private disconnectWithTransport(
    transport: ServerConnectionTestTransportKind,
  ): Promise<void> {
    if (this.state === "closed") {
      return Promise.resolve();
    }
    if (this.disconnectPromise !== undefined) {
      return this.disconnectPromise;
    }

    this.state = "disconnecting";
    this.disconnectPromise = this.ipc
      .invoke<void>(disconnectCommand(transport), {
        request: { connectionId: this.connectionId },
      })
      .catch((error: unknown) => {
        throw parseServerConnectionTestCommandError(error);
      })
      .finally(() => {
        this.state = "closed";
      });
    return this.disconnectPromise;
  }
}

export function createServerConnectionTestTransportConnector(
  request: ConnectServerConnectionTestRequest,
  ipc: ServerConnectionTestIpc = tauriIpc,
): ServerConnectionTestTransportConnector {
  const stableRequest = normalizeConnectRequest(request);
  let state: "idle" | "connecting" | "cancelling" | "cancelled" | "settled" =
    "idle";
  let cancellationPromise: Promise<void> | undefined;
  const currentState = () => state;

  const connect: ProtocolTransportConnector = async (handlers) => {
    if (state === "cancelled") {
      throw new ServerConnectionTestBridgeError("connectionCancelled");
    }
    if (state !== "idle") {
      throw new ServerConnectionTestBridgeError("invalidConnectRequest");
    }
    state = "connecting";
    try {
      const connection = await ServerConnectionTestConnection.connect(
        stableRequest,
        handlers,
        ipc,
      );
      if (currentState() === "cancelling") {
        try {
          await connection.close();
        } catch {
          throw new ServerConnectionTestBridgeError(
            "connectionCancellationFailed",
          );
        }
        throw new ServerConnectionTestBridgeError("connectionCancelled");
      }
      return connection;
    } catch (error) {
      if (currentState() === "cancelling") {
        if (
          error instanceof ServerConnectionTestBridgeError &&
          error.code === "connectionCancellationFailed"
        ) {
          throw error;
        }
        throw new ServerConnectionTestBridgeError("connectionCancelled");
      }
      throw error;
    } finally {
      state = "settled";
    }
  };

  const cancelPending = (): Promise<void> => {
    if (state === "idle") {
      state = "cancelled";
      return Promise.resolve();
    }
    if (state === "cancelled" || state === "settled") {
      return Promise.resolve();
    }
    if (cancellationPromise !== undefined) {
      return cancellationPromise;
    }

    state = "cancelling";
    cancellationPromise = ipc
      .invoke<void>(CANCEL_CONNECT_COMMAND, {
        request: { connectionId: stableRequest.connectionId },
      })
      .catch(() => {
        throw new ServerConnectionTestBridgeError(
          "connectionCancellationFailed",
        );
      });
    return cancellationPromise;
  };

  return Object.assign(connect, { cancelPending });
}

export function parseServerConnectionTestCommandError(
  value: unknown,
): ServerConnectionTestCommandError {
  try {
    const record = asRecord(value);
    if (
      record === undefined ||
      typeof record.code !== "string" ||
      typeof record.message !== "string" ||
      !COMMAND_ERROR_CODE_SET.has(record.code) ||
      !hasOnlyKeys(record, ["code", "message", "statusCode", "details"])
    ) {
      return new ServerConnectionTestCommandError("connectionTestFailed");
    }

    const code = record.code as (typeof COMMAND_ERROR_CODES)[number];
    const statusCode = parseStatusCode(code, record.statusCode);
    if (statusCode === null) {
      return new ServerConnectionTestCommandError("connectionTestFailed");
    }
    const details = parseCommandErrorDetails(code, record.details);
    if (details === null) {
      return new ServerConnectionTestCommandError("connectionTestFailed");
    }
    return new ServerConnectionTestCommandError(code, {
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(details === undefined ? {} : { details }),
    });
  } catch {
    return new ServerConnectionTestCommandError("connectionTestFailed");
  }
}

function normalizeConnectRequest(
  request: ConnectServerConnectionTestRequest,
): ConnectServerConnectionTestRequest {
  try {
    const record = asRecord(request);
    if (
      record === undefined ||
      typeof record.connectionId !== "string" ||
      !CONNECTION_ID_PATTERN.test(record.connectionId)
    ) {
      throw new Error("invalid request");
    }

    const configuration = snapshotConfiguration(
      normalizeServerConfigurationInput(
        record.configuration as ServerConfigurationInput,
        "request.configuration",
      ),
    );
    const credentialSource = normalizeCredentialSource(
      record.credentialSource,
      configuration,
    );
    const proxy = record.proxy === undefined
      ? undefined
      : normalizeProxyConnectionTestInput(record.proxy);
    if (
      proxy !== undefined &&
      (configuration.type !== "remoteWebSocket" || configuration.proxyId !== undefined)
    ) {
      throw new Error("draft proxy requires an unproxied remote server draft");
    }
    return Object.freeze({
      connectionId: record.connectionId,
      configuration,
      credentialSource,
      ...(proxy === undefined ? {} : { proxy }),
    });
  } catch (error) {
    if (error instanceof ServerConnectionTestBridgeError) {
      throw error;
    }
    throw new ServerConnectionTestBridgeError("invalidConnectRequest");
  }
}

function normalizeProxyConnectionTestInput(
  value: unknown,
): ProxyConnectionTestInput {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasOnlyKeys(record, ["configuration", "credentialSource", "sshHostKey"])
  ) {
    throw new Error("invalid proxy test input");
  }
  const configuration = snapshotProxyConfiguration(
    normalizeCreateProxyProfileRequest({
      name: "Connection test proxy",
      configuration: record.configuration as ProxyConfigurationInput,
    }).configuration,
  );
  const credentialSource = normalizeProxyCredentialSource(
    record.credentialSource,
    configuration,
  );
  const sshHostKey = record.sshHostKey === undefined
    ? undefined
    : normalizeProxyTestHostKey(record.sshHostKey, configuration);
  return Object.freeze({
    configuration,
    credentialSource,
    ...(sshHostKey === undefined ? {} : { sshHostKey }),
  });
}

function normalizeProxyCredentialSource(
  value: unknown,
  configuration: ProxyConfigurationInput,
): ProxyConnectionTestCredentialSource {
  const record = asRecord(value);
  if (record?.type === "none" && hasOnlyKeys(record, ["type"])) {
    return Object.freeze({ type: "none" });
  }
  if (
    record?.type === "provided" &&
    hasOnlyKeys(record, ["type", "credential"])
  ) {
    const credential = normalizeSetProxyCredentialRequest({
      proxyId: CREDENTIAL_VALIDATION_PROXY_ID,
      expectedVersion: 1,
      credential: record.credential as ProxyCredential,
    }).credential;
    if (credential.type !== proxyCredentialType(configuration)) {
      throw new Error("proxy credential does not match configuration");
    }
    return Object.freeze({
      type: "provided",
      credential: Object.freeze({ ...credential }),
    });
  }
  if (
    record?.type === "stored" &&
    hasOnlyKeys(record, ["type", "proxyId", "expectedVersion"]) &&
    typeof record.proxyId === "string" &&
    UUID_V4_PATTERN.test(record.proxyId) &&
    isVersion(record.expectedVersion) &&
    proxyCredentialType(configuration) !== undefined
  ) {
    return Object.freeze({
      type: "stored",
      proxyId: record.proxyId as ProxyId,
      expectedVersion: record.expectedVersion,
    });
  }
  throw new Error("invalid proxy credential source");
}

function proxyCredentialType(
  configuration: ProxyConfigurationInput,
): ProxyCredential["type"] | undefined {
  switch (configuration.type) {
    case "httpConnect":
      return configuration.authentication === "basic"
        ? "httpBasicPassword"
        : configuration.authentication === "bearer"
          ? "httpBearerToken"
          : undefined;
    case "socks5":
      return configuration.authentication === "usernamePassword"
        ? "socks5Password"
        : undefined;
    case "ssh":
      return configuration.authentication.type === "privateKey"
        ? "sshPrivateKeyPassphrase"
        : configuration.authentication.type === "password"
          ? "sshPassword"
          : undefined;
  }
}

function normalizeProxyTestHostKey(
  value: unknown,
  configuration: ProxyConfigurationInput,
): ProxyConnectionTestHostKey {
  const record = asRecord(value);
  if (
    configuration.type !== "ssh" ||
    record === undefined ||
    !hasOnlyKeys(record, ["host", "port", "algorithm", "sha256Fingerprint"]) ||
    record.host !== configuration.host ||
    record.port !== (configuration.port ?? 22) ||
    typeof record.algorithm !== "string" ||
    record.algorithm.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(record.algorithm) ||
    typeof record.sha256Fingerprint !== "string" ||
    !SSH_SHA256_FINGERPRINT_PATTERN.test(record.sha256Fingerprint)
  ) {
    throw new Error("invalid proxy SSH host key");
  }
  return Object.freeze({
    host: configuration.host,
    port: configuration.port ?? 22,
    algorithm: record.algorithm,
    sha256Fingerprint: record.sha256Fingerprint,
  });
}

function snapshotProxyConfiguration(
  configuration: ProxyConfigurationInput,
): ProxyConfigurationInput {
  switch (configuration.type) {
    case "httpConnect":
      return Object.freeze({
        ...configuration,
        nonSensitiveHeaders: Object.freeze({
          ...(configuration.nonSensitiveHeaders ?? {}),
        }),
      });
    case "socks5":
      return Object.freeze({ ...configuration });
    case "ssh":
      return Object.freeze({
        ...configuration,
        authentication: Object.freeze({ ...configuration.authentication }),
      });
  }
}

function normalizeCredentialSource(
  value: unknown,
  configuration: ServerConfigurationInput,
): ServerConnectionTestCredentialSource {
  const record = asRecord(value);
  if (record?.type === "none") {
    return Object.freeze({ type: "none" });
  }
  if (record?.type === "provided") {
    const credential = normalizeSetServerCredentialRequest({
      serverId: CREDENTIAL_VALIDATION_SERVER_ID,
      expectedVersion: 1,
      credential: record.credential as ServerCredential,
    }).credential;
    if (
      (configuration.type === "localStdio" &&
        credential.type !== "sensitiveEnvironment") ||
      (configuration.type === "remoteWebSocket" &&
        (configuration.authentication !== "bearer" ||
          credential.type !== "bearerToken"))
    ) {
      throw new Error("credential does not match configuration");
    }
    return Object.freeze({
      type: "provided",
      credential: snapshotCredential(credential),
    });
  }
  if (
    record?.type === "stored" &&
    typeof record.serverId === "string" &&
    UUID_V4_PATTERN.test(record.serverId) &&
    isVersion(record.expectedVersion)
  ) {
    return Object.freeze({
      type: "stored",
      serverId: record.serverId as ServerId,
      expectedVersion: record.expectedVersion,
    });
  }
  throw new Error("invalid credential source");
}

function snapshotConfiguration(
  configuration: ServerConfigurationInput,
): ServerConfigurationInput {
  if (configuration.type === "localStdio") {
    return Object.freeze({
      type: "localStdio",
      executablePath: configuration.executablePath,
      arguments: Object.freeze([...configuration.arguments]),
      ...(configuration.defaultWorkingDirectory === undefined
        ? {}
        : { defaultWorkingDirectory: configuration.defaultWorkingDirectory }),
      nonSensitiveEnvironment: Object.freeze({
        ...(configuration.nonSensitiveEnvironment ?? {}),
      }),
    });
  }
  return Object.freeze({
    type: "remoteWebSocket",
    url: configuration.url,
    authentication: configuration.authentication,
    nonSensitiveHeaders: Object.freeze({
      ...(configuration.nonSensitiveHeaders ?? {}),
    }),
    connectTimeoutMs: configuration.connectTimeoutMs,
    tlsCertificatePolicy: configuration.tlsCertificatePolicy,
    plaintextConfirmed: configuration.plaintextConfirmed,
    ...(configuration.proxyId === undefined
      ? {}
      : { proxyId: configuration.proxyId }),
  });
}

function snapshotCredential(credential: ServerCredential): ServerCredential {
  if (credential.type === "bearerToken") {
    return Object.freeze({ type: "bearerToken", value: credential.value });
  }
  return Object.freeze({
    type: "sensitiveEnvironment",
    values: Object.freeze({ ...credential.values }),
  });
}

function parseConnectResponse(
  value: unknown,
  connectionId: string,
): ServerConnectionTestInfo | undefined {
  const response = asRecord(value);
  if (
    response === undefined ||
    response.connectionId !== connectionId ||
    !isTransport(response.transport) ||
    !isConnectionPath(response.connectionPath)
  ) {
    return undefined;
  }

  if (response.transport === "localStdio") {
    return response.connectionPath === "localStdio" &&
      hasOnlyKeys(response, ["connectionId", "transport", "connectionPath"])
      ? Object.freeze({
          connectionId,
          transport: "localStdio",
          connectionPath: "localStdio",
        })
      : undefined;
  }
  if (response.connectionPath === "direct") {
    return hasOnlyKeys(response, [
      "connectionId",
      "transport",
      "connectionPath",
    ])
      ? Object.freeze({
          connectionId,
          transport: "remoteWebSocket",
          connectionPath: "direct",
        })
      : undefined;
  }
  if (response.connectionPath === "localStdio") {
    return undefined;
  }
  const hasProxyIdentity = response.proxyId !== undefined || response.proxyVersion !== undefined;
  if (hasProxyIdentity) {
    if (
      typeof response.proxyId !== "string" ||
      !UUID_V4_PATTERN.test(response.proxyId) ||
      !isVersion(response.proxyVersion) ||
      !hasOnlyKeys(response, [
        "connectionId",
        "transport",
        "connectionPath",
        "proxyId",
        "proxyVersion",
      ])
    ) {
      return undefined;
    }
  } else if (!hasOnlyKeys(response, ["connectionId", "transport", "connectionPath"])) {
    return undefined;
  }
  return Object.freeze({
    connectionId,
    transport: "remoteWebSocket",
    connectionPath: response.connectionPath,
    ...(hasProxyIdentity
      ? {
          proxyId: response.proxyId as ProxyId,
          proxyVersion: response.proxyVersion as number,
        }
      : {}),
  });
}

function parseConnectionEvent(
  value: unknown,
  connectionId: string,
): ParsedConnectionEvent | undefined {
  const envelope = asRecord(value);
  if (
    envelope === undefined ||
    !isTransport(envelope.transport) ||
    !hasOnlyKeys(envelope, ["transport", "event"])
  ) {
    return undefined;
  }

  if (envelope.transport === "localStdio") {
    const event = parseLocalStdioConnectionEvent(envelope.event);
    return event?.connectionId === connectionId
      ? { transport: "localStdio", event }
      : undefined;
  }
  const event = parseRemoteWebSocketConnectionEvent(envelope.event);
  return event?.connectionId === connectionId
    ? { transport: "remoteWebSocket", event }
    : undefined;
}

function parseStatusCode(
  code: (typeof COMMAND_ERROR_CODES)[number],
  value: unknown,
): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return code === "httpProxyConnectRejected" &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

function parseCommandErrorDetails(
  code: (typeof COMMAND_ERROR_CODES)[number],
  value: unknown,
): ServerConnectionTestCommandErrorDetails | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (code !== "sshHostKeyUnknown" && code !== "sshHostKeyChanged") {
    return null;
  }
  const record = asRecord(value);
  if (
    record === undefined ||
    record.kind !== code ||
    typeof record.host !== "string" ||
    record.host.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(record.host) ||
    new TextEncoder().encode(record.host).byteLength > 253 ||
    !isPort(record.port)
  ) {
    return null;
  }
  const received = parseSshHostKeyIdentity(record.received);
  if (received === undefined) {
    return null;
  }
  if (code === "sshHostKeyUnknown") {
    return hasOnlyKeys(record, ["kind", "host", "port", "received"])
      ? Object.freeze({
          kind: "sshHostKeyUnknown",
          host: record.host,
          port: record.port,
          received,
        })
      : null;
  }
  const expected = parseSshHostKeyIdentity(record.expected);
  return expected !== undefined &&
    hasOnlyKeys(record, ["kind", "host", "port", "expected", "received"])
    ? Object.freeze({
        kind: "sshHostKeyChanged",
        host: record.host,
        port: record.port,
        expected,
        received,
      })
    : null;
}

function parseSshHostKeyIdentity(
  value: unknown,
): SshHostKeyIdentity | undefined {
  const record = asRecord(value);
  if (
    record === undefined ||
    typeof record.algorithm !== "string" ||
    record.algorithm.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(record.algorithm) ||
    new TextEncoder().encode(record.algorithm).byteLength > 128 ||
    typeof record.sha256Fingerprint !== "string" ||
    !SSH_SHA256_FINGERPRINT_PATTERN.test(record.sha256Fingerprint) ||
    !hasOnlyKeys(record, ["algorithm", "sha256Fingerprint"])
  ) {
    return undefined;
  }
  return Object.freeze({
    algorithm: record.algorithm,
    sha256Fingerprint: record.sha256Fingerprint,
  });
}

function sendCommand(transport: ServerConnectionTestTransportKind): string {
  return transport === "localStdio" ? LOCAL_SEND_COMMAND : REMOTE_SEND_COMMAND;
}

function disconnectCommand(
  transport: ServerConnectionTestTransportKind,
): string {
  return transport === "localStdio"
    ? LOCAL_DISCONNECT_COMMAND
    : REMOTE_DISCONNECT_COMMAND;
}

function isTransport(
  value: unknown,
): value is ServerConnectionTestTransportKind {
  return value === "localStdio" || value === "remoteWebSocket";
}

function isConnectionPath(value: unknown): value is ServerConnectionTestPath {
  return (
    value === "localStdio" ||
    value === "direct" ||
    value === "httpConnect" ||
    value === "socks5" ||
    value === "sshDirectTcpip"
  );
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Reflect.ownKeys(record).every(
    (key) => typeof key === "string" && allowed.has(key),
  );
}
