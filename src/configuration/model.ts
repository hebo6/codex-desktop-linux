declare const serverIdBrand: unique symbol;
declare const proxyIdBrand: unique symbol;

export type ServerId = string & { readonly [serverIdBrand]: true };
export type ProxyId = string & { readonly [proxyIdBrand]: true };

export type NonSensitiveValues = Readonly<Record<string, string>>;

export type RemoteServerAuthentication = "none" | "bearer";
export type TlsCertificatePolicy =
  | "strict"
  | "allowInvalidCertificate";

export interface LocalStdioServerConfiguration {
  readonly type: "localStdio";
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly defaultWorkingDirectory?: string;
  readonly nonSensitiveEnvironment: NonSensitiveValues;
}

export interface RemoteWebSocketServerConfiguration {
  readonly type: "remoteWebSocket";
  readonly url: string;
  readonly authentication: RemoteServerAuthentication;
  readonly nonSensitiveHeaders: NonSensitiveValues;
  readonly connectTimeoutMs: number;
  readonly tlsCertificatePolicy: TlsCertificatePolicy;
  readonly plaintextConfirmed: boolean;
  readonly proxyId?: ProxyId;
}

export type ServerConfiguration =
  | LocalStdioServerConfiguration
  | RemoteWebSocketServerConfiguration;

export interface ServerProfile {
  readonly serverId: ServerId;
  readonly name: string;
  readonly version: number;
  readonly configuration: ServerConfiguration;
  readonly credentialConfigured: boolean;
  readonly activeWindowCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastUsedAtMs?: number;
}

export type HttpProxyAuthentication = "none" | "basic" | "bearer";
export type Socks5Authentication = "none" | "usernamePassword";
export type Socks5DnsResolution = "proxy" | "local";

export type SshAuthenticationConfiguration =
  | { readonly type: "agent" }
  | {
      readonly type: "privateKey";
      readonly privateKeyPath: string;
    }
  | { readonly type: "password" };

export interface HttpConnectProxyConfiguration {
  readonly type: "httpConnect";
  readonly url: string;
  readonly authentication: HttpProxyAuthentication;
  readonly username?: string;
  readonly nonSensitiveHeaders: NonSensitiveValues;
  readonly connectTimeoutMs: number;
  readonly tlsCertificatePolicy: TlsCertificatePolicy;
}

export interface Socks5ProxyConfiguration {
  readonly type: "socks5";
  readonly host: string;
  readonly port: number;
  readonly authentication: Socks5Authentication;
  readonly username?: string;
  readonly dnsResolution: Socks5DnsResolution;
  readonly connectTimeoutMs: number;
}

export interface SshProxyConfiguration {
  readonly type: "ssh";
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authentication: SshAuthenticationConfiguration;
  readonly connectTimeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly keepAliveMaxFailures: number;
}

export type ProxyConfiguration =
  | HttpConnectProxyConfiguration
  | Socks5ProxyConfiguration
  | SshProxyConfiguration;

export interface SshHostKeyRecord {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
  readonly confirmedAtMs: number;
}

export type ProxyTestStatus = "succeeded" | "failed";

export interface ProxyLastTest {
  readonly status: ProxyTestStatus;
  readonly testedAtMs: number;
}

export interface ProxyProfile {
  readonly proxyId: ProxyId;
  readonly name: string;
  readonly version: number;
  readonly configuration: ProxyConfiguration;
  readonly credentialConfigured: boolean;
  readonly sshHostKey?: SshHostKeyRecord;
  readonly lastTest?: ProxyLastTest;
  readonly referencedServerCount: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ConfigurationSnapshot {
  readonly servers: readonly ServerProfile[];
  readonly proxies: readonly ProxyProfile[];
}

export type CredentialStorageBackend =
  | "secretService"
  | "plaintextFile"
  | "mixed";

export interface CredentialStorageStatus {
  readonly backend: CredentialStorageBackend;
}

export interface LocalStdioServerConfigurationInput {
  readonly type: "localStdio";
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly defaultWorkingDirectory?: string;
  readonly nonSensitiveEnvironment?: NonSensitiveValues;
}

export interface RemoteWebSocketServerConfigurationInput {
  readonly type: "remoteWebSocket";
  readonly url: string;
  readonly authentication: RemoteServerAuthentication;
  readonly nonSensitiveHeaders?: NonSensitiveValues;
  readonly connectTimeoutMs: number;
  readonly tlsCertificatePolicy: TlsCertificatePolicy;
  readonly plaintextConfirmed: boolean;
  readonly proxyId?: ProxyId;
}

export type ServerConfigurationInput =
  | LocalStdioServerConfigurationInput
  | RemoteWebSocketServerConfigurationInput;

export interface CreateServerProfileRequest {
  readonly name: string;
  readonly configuration: ServerConfigurationInput;
}

export interface UpdateServerProfileRequest
  extends CreateServerProfileRequest {
  readonly serverId: ServerId;
  readonly expectedVersion: number;
}

export interface DeleteServerProfileRequest {
  readonly serverId: ServerId;
  readonly expectedVersion: number;
}

export interface HttpConnectProxyConfigurationInput {
  readonly type: "httpConnect";
  readonly url: string;
  readonly authentication: HttpProxyAuthentication;
  readonly username?: string;
  readonly nonSensitiveHeaders?: NonSensitiveValues;
  readonly connectTimeoutMs: number;
  readonly tlsCertificatePolicy: TlsCertificatePolicy;
}

export interface Socks5ProxyConfigurationInput {
  readonly type: "socks5";
  readonly host: string;
  readonly port: number;
  readonly authentication: Socks5Authentication;
  readonly username?: string;
  readonly dnsResolution: Socks5DnsResolution;
  readonly connectTimeoutMs: number;
}

export interface SshProxyConfigurationInput {
  readonly type: "ssh";
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly authentication: SshAuthenticationConfiguration;
  readonly connectTimeoutMs: number;
  readonly keepAliveIntervalMs: number;
  readonly keepAliveMaxFailures: number;
}

export type ProxyConfigurationInput =
  | HttpConnectProxyConfigurationInput
  | Socks5ProxyConfigurationInput
  | SshProxyConfigurationInput;

export interface CreateProxyProfileRequest {
  readonly name: string;
  readonly configuration: ProxyConfigurationInput;
}

export interface UpdateProxyProfileRequest
  extends CreateProxyProfileRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
}

export interface DeleteProxyProfileRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
}

export interface RemoveProxySshHostKeyRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
}

export interface ConfirmProxySshHostKeyRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly sha256Fingerprint: string;
}

export interface RecordProxyTestRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
  readonly status: ProxyTestStatus;
}

export type SensitiveEnvironmentValues = Readonly<Record<string, string>>;

export type ServerCredential =
  | {
      readonly type: "sensitiveEnvironment";
      readonly values: SensitiveEnvironmentValues;
    }
  | {
      readonly type: "bearerToken";
      readonly value: string;
    };

export type ServerCredentialType = ServerCredential["type"];

export interface SetServerCredentialRequest {
  readonly serverId: ServerId;
  readonly expectedVersion: number;
  readonly credential: ServerCredential;
  readonly plaintextFallbackConfirmed?: boolean;
}

export interface ClearServerCredentialRequest {
  readonly serverId: ServerId;
  readonly expectedVersion: number;
  readonly credentialType: ServerCredentialType;
}

export type ProxyCredentialType =
  | "httpBasicPassword"
  | "httpBearerToken"
  | "socks5Password"
  | "sshPrivateKeyPassphrase"
  | "sshPassword";

export interface ProxyCredential {
  readonly type: ProxyCredentialType;
  readonly value: string;
}

export interface SetProxyCredentialRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
  readonly credential: ProxyCredential;
  readonly plaintextFallbackConfirmed?: boolean;
}

export interface ClearProxyCredentialRequest {
  readonly proxyId: ProxyId;
  readonly expectedVersion: number;
  readonly credentialType: ProxyCredentialType;
}
