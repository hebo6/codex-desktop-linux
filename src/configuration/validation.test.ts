import { describe, expect, it } from "vitest";

import type { ProxyId, ServerId } from "./model";

import {
  ConfigurationContractError,
  normalizeClearProxyCredentialRequest,
  normalizeClearServerCredentialRequest,
  normalizeSetProxyCredentialRequest,
  normalizeSetServerCredentialRequest,
  parseConfigurationSnapshot,
  parseCredentialStorageStatus,
  parseProxyProfile,
  parseServerProfile,
} from "./validation";

const SERVER_LOCAL_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const SERVER_REMOTE_ID = "22222222-2222-4222-8222-222222222222" as ServerId;
const PROXY_SSH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProxyId;
const PROXY_HTTP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ProxyId;
const PROXY_SOCKS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as ProxyId;
const SSH_FINGERPRINT = `SHA256:${"A".repeat(43)}`;

function validLocalServer() {
  return {
    serverId: SERVER_LOCAL_ID,
    name: "Local",
    version: 1,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["app-server"],
      defaultWorkingDirectory: "/tmp/project",
      nonSensitiveEnvironment: { Z_MODE: "last", A_MODE: "first" },
    },
    credentialConfigured: false,
    activeWindowCount: 1,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
    lastUsedAtMs: 3_000,
  };
}

function validRemoteServer() {
  return {
    serverId: SERVER_REMOTE_ID,
    name: "Remote",
    version: 2,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app",
      authentication: "bearer",
      nonSensitiveHeaders: { "X-Zeta": "last", "X-Alpha": "first" },
      connectTimeoutMs: 10_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
      proxyId: PROXY_SSH_ID,
    },
    credentialConfigured: true,
    activeWindowCount: 0,
    createdAtMs: 2_000,
    updatedAtMs: 3_000,
  };
}

function validSshProxy() {
  return {
    proxyId: PROXY_SSH_ID,
    name: "SSH",
    version: 3,
    configuration: {
      type: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "alice",
      authentication: {
        type: "privateKey",
        privateKeyPath: "/home/alice/.ssh/id_ed25519",
      },
      connectTimeoutMs: 8_000,
      keepAliveIntervalMs: 15_000,
      keepAliveMaxFailures: 3,
    },
    credentialConfigured: true,
    sshHostKey: {
      host: "ssh.example.test",
      port: 22,
      algorithm: "ssh-ed25519",
      sha256Fingerprint: SSH_FINGERPRINT,
      confirmedAtMs: 2_500,
    },
    lastTest: { status: "succeeded", testedAtMs: 2_800 },
    referencedServerCount: 1,
    createdAtMs: 1_000,
    updatedAtMs: 3_000,
  };
}

function validHttpProxy() {
  return {
    proxyId: PROXY_HTTP_ID,
    name: "HTTP",
    version: 1,
    configuration: {
      type: "httpConnect",
      url: "https://proxy.example.test:8443",
      authentication: "basic",
      username: "alice",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 5_000,
      tlsCertificatePolicy: "strict",
    },
    credentialConfigured: true,
    referencedServerCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function validSocksProxy() {
  return {
    proxyId: PROXY_SOCKS_ID,
    name: "SOCKS",
    version: 1,
    configuration: {
      type: "socks5",
      host: "proxy.example.test",
      port: 1_080,
      authentication: "usernamePassword",
      username: "alice",
      dnsResolution: "proxy",
      connectTimeoutMs: 5_000,
    },
    credentialConfigured: true,
    lastTest: { status: "failed", testedAtMs: 1_500 },
    referencedServerCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  };
}

function validSnapshot() {
  return {
    servers: [validLocalServer(), validRemoteServer()],
    proxies: [validSshProxy(), validHttpProxy(), validSocksProxy()],
  };
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("test fixture must be an object");
  }
  return value as Record<string, unknown>;
}

describe("configuration runtime contract", () => {
  it("严格解析凭据存储后端状态", () => {
    expect(parseCredentialStorageStatus({ backend: "secretService" })).toEqual({
      backend: "secretService",
    });
    expect(parseCredentialStorageStatus({ backend: "plaintextFile" })).toEqual({
      backend: "plaintextFile",
    });
    expect(parseCredentialStorageStatus({ backend: "mixed" })).toEqual({
      backend: "mixed",
    });
    expect(() =>
      parseCredentialStorageStatus({ backend: "plaintextFile", path: "/secret" }),
    ).toThrow(ConfigurationContractError);
    expect(() => parseCredentialStorageStatus({ backend: "unknown" })).toThrow(
      ConfigurationContractError,
    );
  });

  it("严格解析全部非敏感配置形态并规范化键顺序", () => {
    const snapshot = parseConfigurationSnapshot(validSnapshot());

    expect(snapshot.servers).toHaveLength(2);
    expect(snapshot.proxies.map((proxy) => proxy.configuration.type)).toEqual([
      "ssh",
      "httpConnect",
      "socks5",
    ]);
    const local = snapshot.servers[0];
    const remote = snapshot.servers[1];
    expect(local?.configuration.type).toBe("localStdio");
    if (local?.configuration.type === "localStdio") {
      expect(Object.keys(local.configuration.nonSensitiveEnvironment)).toEqual([
        "A_MODE",
        "Z_MODE",
      ]);
    }
    if (remote?.configuration.type === "remoteWebSocket") {
      expect(Object.keys(remote.configuration.nonSensitiveHeaders)).toEqual([
        "X-Alpha",
        "X-Zeta",
      ]);
    }
  });

  it("严格要求 profile 返回布尔型凭据配置状态", () => {
    const { credentialConfigured: _serverStatus, ...serverWithoutStatus } =
      validLocalServer();
    const { credentialConfigured: _proxyStatus, ...proxyWithoutStatus } =
      validHttpProxy();

    expect(() => parseServerProfile(serverWithoutStatus)).toThrow(
      ConfigurationContractError,
    );
    expect(() => parseProxyProfile(proxyWithoutStatus)).toThrow(
      ConfigurationContractError,
    );
    expect(() =>
      parseServerProfile({
        ...validLocalServer(),
        credentialConfigured: "false",
      }),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      parseProxyProfile({
        ...validHttpProxy(),
        credentialConfigured: 1,
      }),
    ).toThrow(ConfigurationContractError);
    expect(parseServerProfile(validRemoteServer()).credentialConfigured).toBe(
      true,
    );
    expect(parseProxyProfile(validSshProxy()).credentialConfigured).toBe(true);
  });

  it("严格要求服务器活动窗口数为非负安全整数", () => {
    const { activeWindowCount: _count, ...missingCount } = validLocalServer();

    expect(() => parseServerProfile(missingCount)).toThrow(
      ConfigurationContractError,
    );
    for (const activeWindowCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseServerProfile({
          ...validLocalServer(),
          activeWindowCount,
        }),
      ).toThrow(ConfigurationContractError);
    }
    expect(parseServerProfile(validLocalServer()).activeWindowCount).toBe(1);
    expect(
      parseServerProfile({
        ...validRemoteServer(),
        activeWindowCount: Number.MAX_SAFE_INTEGER,
      }).activeWindowCount,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("拒绝无凭据认证方式与已配置状态的矛盾组合", () => {
    const remote = validRemoteServer();
    expect(() =>
      parseServerProfile({
        ...remote,
        configuration: { ...remote.configuration, authentication: "none" },
        credentialConfigured: true,
      }),
    ).toThrow(ConfigurationContractError);

    const http = validHttpProxy();
    const { username: _httpUsername, ...httpWithoutUsername } =
      http.configuration;
    expect(() =>
      parseProxyProfile({
        ...http,
        configuration: {
          ...httpWithoutUsername,
          authentication: "none",
        },
        credentialConfigured: true,
      }),
    ).toThrow(ConfigurationContractError);

    const socks = validSocksProxy();
    const { username: _socksUsername, ...socksWithoutUsername } =
      socks.configuration;
    expect(() =>
      parseProxyProfile({
        ...socks,
        configuration: {
          ...socksWithoutUsername,
          authentication: "none",
        },
        credentialConfigured: true,
      }),
    ).toThrow(ConfigurationContractError);

    const ssh = validSshProxy();
    expect(() =>
      parseProxyProfile({
        ...ssh,
        configuration: {
          ...ssh.configuration,
          authentication: { type: "agent" },
        },
        credentialConfigured: true,
      }),
    ).toThrow(ConfigurationContractError);
  });

  it("拒绝响应顶层、profile、配置和认证联合中的未知字段", () => {
    const topLevel = { ...validSnapshot(), unexpected: true };
    expect(() => parseConfigurationSnapshot(topLevel)).toThrow(
      ConfigurationContractError,
    );

    expect(() =>
      parseServerProfile({ ...validLocalServer(), token: "must-not-enter" }),
    ).toThrow(ConfigurationContractError);

    const server = validRemoteServer();
    expect(() =>
      parseServerProfile({
        ...server,
        configuration: { ...server.configuration, password: "hidden" },
      }),
    ).toThrow(ConfigurationContractError);

    const proxy = validSshProxy();
    expect(() =>
      parseProxyProfile({
        ...proxy,
        configuration: {
          ...proxy.configuration,
          authentication: {
            ...proxy.configuration.authentication,
            passphrase: "hidden",
          },
        },
      }),
    ).toThrow(ConfigurationContractError);
  });

  it("校验 UUID、版本、时间、端口、枚举和 tagged union", () => {
    expect(() =>
      parseServerProfile({ ...validLocalServer(), serverId: "not-a-uuid" }),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      parseServerProfile({
        ...validLocalServer(),
        serverId: "11111111-1111-1111-8111-111111111111",
      }),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      parseServerProfile({ ...validLocalServer(), version: 0 }),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      parseServerProfile({ ...validLocalServer(), version: 1.5 }),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      parseServerProfile({ ...validLocalServer(), updatedAtMs: 999 }),
    ).toThrow(ConfigurationContractError);

    const socks = validSocksProxy();
    expect(() =>
      parseProxyProfile({
        ...socks,
        configuration: { ...socks.configuration, port: 65_536 },
      }),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      parseProxyProfile({
        ...socks,
        configuration: { ...socks.configuration, dnsResolution: "browser" },
      }),
    ).toThrow(ConfigurationContractError);

    const ssh = validSshProxy();
    expect(() =>
      parseProxyProfile({
        ...ssh,
        configuration: {
          ...ssh.configuration,
          authentication: { type: "privateKey" },
        },
      }),
    ).toThrow(ConfigurationContractError);
  });

  it("拒绝重复 ID、悬空代理引用和不一致的引用计数", () => {
    const duplicateServer = structuredClone(validSnapshot());
    duplicateServer.servers.push(structuredClone(duplicateServer.servers[0]!));
    expect(() => parseConfigurationSnapshot(duplicateServer)).toThrow(
      /duplicate serverId/u,
    );

    const duplicateProxy = structuredClone(validSnapshot());
    duplicateProxy.proxies.push(structuredClone(duplicateProxy.proxies[0]!));
    expect(() => parseConfigurationSnapshot(duplicateProxy)).toThrow(
      /duplicate proxyId/u,
    );

    const danglingReference = structuredClone(validSnapshot());
    const remoteServer = mutableRecord(danglingReference.servers[1]);
    const remoteConfiguration = mutableRecord(remoteServer.configuration);
    remoteConfiguration.proxyId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(() => parseConfigurationSnapshot(danglingReference)).toThrow(
      /unknown proxyId/u,
    );

    const wrongCount = structuredClone(validSnapshot());
    wrongCount.proxies[0]!.referencedServerCount = 0;
    expect(() => parseConfigurationSnapshot(wrongCount)).toThrow(
      /referencedServerCount/u,
    );

    const duplicateServerName = structuredClone(validSnapshot());
    duplicateServerName.servers[1]!.name = "local";
    expect(() => parseConfigurationSnapshot(duplicateServerName)).toThrow(
      /duplicate server name/u,
    );

    const duplicateProxyName = structuredClone(validSnapshot());
    duplicateProxyName.proxies[1]!.name = "ssh";
    expect(() => parseConfigurationSnapshot(duplicateProxyName)).toThrow(
      /duplicate proxy name/u,
    );
  });

  it("约束 SSH 主机密钥只能匹配 SSH 代理端点", () => {
    const mismatched = validSshProxy();
    expect(() =>
      parseProxyProfile({
        ...mismatched,
        sshHostKey: { ...mismatched.sshHostKey, port: 2_222 },
      }),
    ).toThrow(/does not match/u);

    expect(() =>
      parseProxyProfile({
        ...validHttpProxy(),
        sshHostKey: validSshProxy().sshHostKey,
      }),
    ).toThrow(/only valid for an SSH proxy/u);

    const blankAlgorithm = validSshProxy();
    expect(() =>
      parseProxyProfile({
        ...blankAlgorithm,
        sshHostKey: { ...blankAlgorithm.sshHostKey, algorithm: "   " },
      }),
    ).toThrow(/algorithm/u);

    const nonCanonicalFingerprint = validSshProxy();
    expect(() =>
      parseProxyProfile({
        ...nonCanonicalFingerprint,
        sshHostKey: {
          ...nonCanonicalFingerprint.sshHostKey,
          sha256Fingerprint: `SHA256:${"B".repeat(43)}`,
        },
      }),
    ).toThrow(/fingerprint/u);
  });

  it("拒绝全空白用户名及含冒号的 HTTP Basic 用户名", () => {
    const http = validHttpProxy();
    const socks = validSocksProxy();
    const ssh = validSshProxy();
    const invalidProfiles = [
      {
        ...http,
        configuration: { ...http.configuration, username: "   " },
      },
      {
        ...http,
        configuration: {
          ...http.configuration,
          username: "alice:administrator",
        },
      },
      {
        ...socks,
        configuration: { ...socks.configuration, username: "\t" },
      },
      {
        ...ssh,
        configuration: { ...ssh.configuration, username: "\n" },
      },
    ];

    for (const profile of invalidProfiles) {
      expect(() => parseProxyProfile(profile)).toThrow(
        ConfigurationContractError,
      );
    }
  });

  it("与 Rust 一致地接受括号 IPv6 并拒绝反斜杠主机", () => {
    const socks = validSocksProxy();
    expect(
      parseProxyProfile({
        ...socks,
        configuration: { ...socks.configuration, host: "[::1]" },
      }).configuration,
    ).toMatchObject({ host: "[::1]" });
    expect(() =>
      parseProxyProfile({
        ...socks,
        configuration: {
          ...socks.configuration,
          host: "example.test\\evil",
        },
      }),
    ).toThrow(ConfigurationContractError);
  });

  it("拒绝会在传输层被视为敏感的环境变量、请求头和查询参数", () => {
    const local = validLocalServer();
    for (const environmentName of [
      "ACCESSKEY",
      "DOCKER_AUTH_CONFIG",
      "GITHUB_PAT",
      "SSH_AUTH_SOCK",
      "A".repeat(129),
    ]) {
      expect(() =>
        parseServerProfile({
          ...local,
          configuration: {
            ...local.configuration,
            nonSensitiveEnvironment: { [environmentName]: "value" },
          },
        }),
      ).toThrow(ConfigurationContractError);
    }

    const remote = validRemoteServer();
    for (const headerName of [
      "X-Auth",
      "Sec-WebSocket-Foo",
      "Proxy-Foo",
    ]) {
      expect(() =>
        parseServerProfile({
          ...remote,
          configuration: {
            ...remote.configuration,
            nonSensitiveHeaders: { [headerName]: "value" },
          },
        }),
      ).toThrow(ConfigurationContractError);
    }

    const httpProxy = validHttpProxy();
    for (const headerName of [
      "Proxy-Authenticate",
      "Sec-WebSocket-Foo",
      "TE",
      "Trailer",
    ]) {
      expect(() =>
        parseProxyProfile({
          ...httpProxy,
          configuration: {
            ...httpProxy.configuration,
            nonSensitiveHeaders: { [headerName]: "value" },
          },
        }),
      ).toThrow(ConfigurationContractError);
    }
    expect(() =>
      parseServerProfile({
        ...remote,
        configuration: {
          ...remote.configuration,
          url: "wss://codex.example.test/app?session=value",
        },
      }),
    ).toThrow(ConfigurationContractError);
  });

  it("拒绝非安全整数且错误信息不回显载荷内容", () => {
    const unsafe = {
      ...validLocalServer(),
      updatedAtMs: Number.MAX_SAFE_INTEGER + 1,
      secret: "DO_NOT_ECHO",
    };
    let error: unknown;
    try {
      parseServerProfile(unsafe);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationContractError);
    expect(String(error)).not.toContain("DO_NOT_ECHO");
  });

  it("逐字段规范化服务器凭据请求并剥离未知字段", () => {
    const setEnvironment = normalizeSetServerCredentialRequest({
      serverId: SERVER_LOCAL_ID,
      expectedVersion: 1,
      ignored: "DROP_TOP_LEVEL",
      credential: {
        type: "sensitiveEnvironment",
        values: { Z_SECRET: "last", A_SECRET: "first" },
        ignored: "DROP_CREDENTIAL_FIELD",
      },
      plaintextFallbackConfirmed: true,
    } as never);
    expect(setEnvironment).toEqual({
      serverId: SERVER_LOCAL_ID,
      expectedVersion: 1,
      credential: {
        type: "sensitiveEnvironment",
        values: { A_SECRET: "first", Z_SECRET: "last" },
      },
      plaintextFallbackConfirmed: true,
    });
    expect(() =>
      normalizeSetServerCredentialRequest({
        serverId: SERVER_LOCAL_ID,
        expectedVersion: 1,
        credential: { type: "bearerToken", value: "valid-token" },
        plaintextFallbackConfirmed: "yes",
      } as never),
    ).toThrow(ConfigurationContractError);

    expect(
      normalizeSetServerCredentialRequest({
        serverId: SERVER_REMOTE_ID,
        expectedVersion: 2,
        credential: { type: "bearerToken", value: "abc.def_ghi-~+/==" },
      }),
    ).toMatchObject({ credential: { type: "bearerToken" } });
    expect(
      normalizeClearServerCredentialRequest({
        serverId: SERVER_REMOTE_ID,
        expectedVersion: 2,
        credentialType: "bearerToken",
        ignored: true,
      } as never),
    ).toEqual({
      serverId: SERVER_REMOTE_ID,
      expectedVersion: 2,
      credentialType: "bearerToken",
    });
  });

  it("校验敏感环境变量的数量、名称、值边界且不回显秘密", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`SECRET_${index}`, "value"]),
    );
    expect(
      normalizeSetServerCredentialRequest({
        serverId: SERVER_LOCAL_ID,
        expectedVersion: 1,
        credential: { type: "sensitiveEnvironment", values: entries },
      }),
    ).toMatchObject({ credential: { type: "sensitiveEnvironment" } });

    for (const values of [
      {},
      Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`SECRET_${index}`, "value"]),
      ),
      { "1INVALID": "value" },
      { SECRET: "x".repeat(8_193) },
      { SECRET: "DO_NOT_ECHO\0" },
    ]) {
      let error: unknown;
      try {
        normalizeSetServerCredentialRequest({
          serverId: SERVER_LOCAL_ID,
          expectedVersion: 1,
          credential: { type: "sensitiveEnvironment", values },
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigurationContractError);
      expect(String(error)).not.toContain("DO_NOT_ECHO");
    }
  });

  it("按后端字节边界校验全部文本凭据类型", () => {
    const validProxyCredentials = [
      { type: "httpBasicPassword", value: "x".repeat(5_882) },
      { type: "httpBearerToken", value: "abc.def_ghi-~+/==" },
      { type: "socks5Password", value: "x".repeat(255) },
      { type: "sshPrivateKeyPassphrase", value: "x".repeat(8_192) },
      { type: "sshPassword", value: "x".repeat(8_192) },
    ] as const;
    for (const credential of validProxyCredentials) {
      expect(
        normalizeSetProxyCredentialRequest({
          proxyId: PROXY_HTTP_ID,
          expectedVersion: 1,
          credential,
        }).credential.type,
      ).toBe(credential.type);
    }

    for (const credential of [
      { type: "httpBasicPassword", value: "x".repeat(5_883) },
      { type: "httpBearerToken", value: "abc=def" },
      { type: "httpBearerToken", value: "x".repeat(8_186) },
      { type: "socks5Password", value: "x".repeat(256) },
      { type: "sshPrivateKeyPassphrase", value: "x".repeat(8_193) },
      { type: "sshPassword", value: "" },
      { type: "sshPassword", value: "DO_NOT_ECHO\0" },
    ] as const) {
      let error: unknown;
      try {
        normalizeSetProxyCredentialRequest({
          proxyId: PROXY_HTTP_ID,
          expectedVersion: 1,
          credential,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigurationContractError);
      expect(String(error)).not.toContain("DO_NOT_ECHO");
    }

    for (const value of ["", "abc def", "abc=def", "x".repeat(8_186)]) {
      expect(() =>
        normalizeSetServerCredentialRequest({
          serverId: SERVER_REMOTE_ID,
          expectedVersion: 1,
          credential: { type: "bearerToken", value },
        }),
      ).toThrow(ConfigurationContractError);
    }
  });

  it("使用 UTF-8 字节而不是 JavaScript 字符数校验凭据边界", () => {
    for (const credential of [
      { type: "httpBasicPassword", value: `${"界".repeat(1_960)}ab` },
      { type: "socks5Password", value: "界".repeat(85) },
      { type: "sshPrivateKeyPassphrase", value: `${"界".repeat(2_730)}ab` },
    ] as const) {
      expect(() =>
        normalizeSetProxyCredentialRequest({
          proxyId: PROXY_HTTP_ID,
          expectedVersion: 1,
          credential,
        }),
      ).not.toThrow();
    }

    for (const credential of [
      { type: "httpBasicPassword", value: "界".repeat(1_961) },
      { type: "socks5Password", value: "界".repeat(86) },
      { type: "sshPassword", value: "界".repeat(2_731) },
    ] as const) {
      expect(() =>
        normalizeSetProxyCredentialRequest({
          proxyId: PROXY_HTTP_ID,
          expectedVersion: 1,
          credential,
        }),
      ).toThrow(ConfigurationContractError);
    }

    expect(() =>
      normalizeSetServerCredentialRequest({
        serverId: SERVER_LOCAL_ID,
        expectedVersion: 1,
        credential: {
          type: "sensitiveEnvironment",
          values: { ACCESS_TOKEN: `${"界".repeat(2_730)}ab` },
        },
      }),
    ).not.toThrow();
    expect(() =>
      normalizeSetServerCredentialRequest({
        serverId: SERVER_LOCAL_ID,
        expectedVersion: 1,
        credential: {
          type: "sensitiveEnvironment",
          values: { ACCESS_TOKEN: "界".repeat(2_731) },
        },
      }),
    ).toThrow(ConfigurationContractError);
  });

  it("严格限制清除凭据类型并规范化代理凭据字段", () => {
    expect(
      normalizeSetProxyCredentialRequest({
        proxyId: PROXY_HTTP_ID,
        expectedVersion: 1,
        ignored: "DROP_TOP_LEVEL",
        credential: {
          type: "httpBasicPassword",
          value: "proxy-password",
          ignored: "DROP_CREDENTIAL_FIELD",
        },
      } as never),
    ).toEqual({
      proxyId: PROXY_HTTP_ID,
      expectedVersion: 1,
      credential: {
        type: "httpBasicPassword",
        value: "proxy-password",
      },
    });
    expect(
      normalizeClearProxyCredentialRequest({
        proxyId: PROXY_HTTP_ID,
        expectedVersion: 1,
        credentialType: "sshPassword",
        ignored: true,
      } as never),
    ).toEqual({
      proxyId: PROXY_HTTP_ID,
      expectedVersion: 1,
      credentialType: "sshPassword",
    });
    expect(() =>
      normalizeClearServerCredentialRequest({
        serverId: SERVER_LOCAL_ID,
        expectedVersion: 1,
        credentialType: "password",
      } as never),
    ).toThrow(ConfigurationContractError);
    expect(() =>
      normalizeClearProxyCredentialRequest({
        proxyId: PROXY_HTTP_ID,
        expectedVersion: 1,
        credentialType: "bearerToken",
      } as never),
    ).toThrow(ConfigurationContractError);
  });
});
