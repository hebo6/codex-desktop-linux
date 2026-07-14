import { describe, expect, it } from "vitest";

import type {
  ClearProxyCredentialRequest,
  ConfirmProxySshHostKeyRequest,
  ClearServerCredentialRequest,
  CreateProxyProfileRequest,
  CreateServerProfileRequest,
  DeleteProxyProfileRequest,
  DeleteServerProfileRequest,
  ProxyId,
  RemoveProxySshHostKeyRequest,
  RecordProxyTestRequest,
  ServerId,
  SetProxyCredentialRequest,
  SetServerCredentialRequest,
  UpdateProxyProfileRequest,
  UpdateServerProfileRequest,
} from "../configuration";
import {
  ConfigurationCommandError,
  ConfigurationContractError,
} from "../configuration";
import {
  clearProxyCredential,
  confirmProxySshHostKey,
  clearServerCredential,
  createProxyProfile,
  createServerProfile,
  deleteProxyProfile,
  deleteServerProfile,
  listConfigurationProfiles,
  removeProxySshHostKey,
  recordProxyTest,
  setProxyCredential,
  setServerCredential,
  updateProxyProfile,
  updateServerProfile,
} from "./configuration";
import type { ConfigurationIpc } from "./configuration";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const OTHER_SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;
const PROXY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ProxyId;

interface InvokeCall {
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

class FakeIpc implements ConfigurationIpc {
  readonly calls: InvokeCall[] = [];
  readonly responses = new Map<string, unknown>();
  failure: unknown;

  async invoke<Result>(
    command: string,
    arguments_: Record<string, unknown>,
  ): Promise<Result> {
    this.calls.push({ command, arguments: arguments_ });
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.responses.get(command) as Result;
  }
}

function localServerProfile(name = "Local") {
  return {
    serverId: SERVER_ID,
    name,
    version: 1,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["app-server"],
      nonSensitiveEnvironment: {},
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function httpProxyProfile(name = "HTTP") {
  return {
    proxyId: PROXY_ID,
    name,
    version: 1,
    configuration: {
      type: "httpConnect",
      url: "https://proxy.example.test:8443",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 5_000,
      tlsCertificatePolicy: "strict",
    },
    credentialConfigured: false,
    referencedServerCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function httpBasicProxyProfile(name = "HTTP Basic") {
  const profile = httpProxyProfile(name);
  return {
    ...profile,
    configuration: {
      ...profile.configuration,
      authentication: "basic",
      username: "alice",
    },
  };
}

function sshProxyProfileWithHostKey() {
  return {
    proxyId: PROXY_ID,
    name: "SSH",
    version: 1,
    configuration: {
      type: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "alice",
      authentication: { type: "agent" },
      connectTimeoutMs: 5_000,
      keepAliveIntervalMs: 15_000,
      keepAliveMaxFailures: 3,
    },
    credentialConfigured: false,
    sshHostKey: {
      host: "ssh.example.test",
      port: 22,
      algorithm: "ssh-ed25519",
      sha256Fingerprint: `SHA256:${"A".repeat(43)}`,
      confirmedAtMs: 1_500,
    },
    referencedServerCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  };
}

describe("configuration IPC", () => {
  it("读取快照时不带参数并严格校验响应", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("list_configuration_profiles", {
      servers: [localServerProfile()],
      proxies: [httpProxyProfile()],
    });

    const snapshot = await listConfigurationProfiles(ipc);

    expect(snapshot.servers[0]?.serverId).toBe(SERVER_ID);
    expect(ipc.calls).toEqual([
      { command: "list_configuration_profiles", arguments: {} },
    ]);

    ipc.responses.set("list_configuration_profiles", {
      servers: [],
      proxies: [],
      unknown: true,
    });
    await expect(listConfigurationProfiles(ipc)).rejects.toBeInstanceOf(
      ConfigurationContractError,
    );

    const { activeWindowCount: _count, ...serverWithoutCount } =
      localServerProfile();
    ipc.responses.set("list_configuration_profiles", {
      servers: [serverWithoutCount],
      proxies: [],
    });
    await expect(listConfigurationProfiles(ipc)).rejects.toBeInstanceOf(
      ConfigurationContractError,
    );
  });

  it("创建服务器时逐字段构造、补齐非敏感默认值并剥离未知字段", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("create_server_profile", localServerProfile("Remote"));
    const request = {
      name: "  Remote  ",
      token: "SERVER_SECRET",
      configuration: {
        type: "remoteWebSocket",
        url: "wss://codex.example.test/app",
        authentication: "bearer",
        connectTimeoutMs: 10_000,
        tlsCertificatePolicy: "strict",
        plaintextConfirmed: false,
        password: "CONFIG_SECRET",
      },
    } as unknown as CreateServerProfileRequest;

    await createServerProfile(request, ipc);

    expect(ipc.calls).toEqual([
      {
        command: "create_server_profile",
        arguments: {
          request: {
            name: "Remote",
            configuration: {
              type: "remoteWebSocket",
              url: "wss://codex.example.test/app",
              authentication: "bearer",
              nonSensitiveHeaders: {},
              connectTimeoutMs: 10_000,
              tlsCertificatePolicy: "strict",
              plaintextConfirmed: false,
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(ipc.calls)).not.toMatch(
      /SERVER_SECRET|CONFIG_SECRET/u,
    );
  });

  it("创建 SSH 代理时默认端口为 22 且认证对象只保留类型", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("create_proxy_profile", httpProxyProfile("SSH"));
    const request = {
      name: "SSH",
      credential: "TOP_LEVEL_SECRET",
      configuration: {
        type: "ssh",
        host: "ssh.example.test",
        username: "alice",
        authentication: { type: "password", password: "SSH_SECRET" },
        connectTimeoutMs: 5_000,
        keepAliveIntervalMs: 15_000,
        keepAliveMaxFailures: 3,
        passphrase: "PASSPHRASE_SECRET",
      },
    } as unknown as CreateProxyProfileRequest;

    await createProxyProfile(request, ipc);

    expect(ipc.calls[0]).toEqual({
      command: "create_proxy_profile",
      arguments: {
        request: {
          name: "SSH",
          configuration: {
            type: "ssh",
            host: "ssh.example.test",
            port: 22,
            username: "alice",
            authentication: { type: "password" },
            connectTimeoutMs: 5_000,
            keepAliveIntervalMs: 15_000,
            keepAliveMaxFailures: 3,
          },
        },
      },
    });
    expect(JSON.stringify(ipc.calls)).not.toMatch(
      /TOP_LEVEL_SECRET|SSH_SECRET|PASSPHRASE_SECRET/u,
    );
  });

  it("更新和删除命令使用版本化标识且不吞掉调用结果", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("update_server_profile", {
      ...localServerProfile("Updated"),
      version: 2,
    });
    ipc.responses.set("update_proxy_profile", {
      ...httpProxyProfile("Updated"),
      version: 2,
    });
    ipc.responses.set("delete_server_profile", null);
    ipc.responses.set("delete_proxy_profile", null);

    const serverUpdate: UpdateServerProfileRequest = {
      serverId: SERVER_ID,
      expectedVersion: 1,
      name: "Updated",
      configuration: {
        type: "localStdio",
        executablePath: "/usr/bin/codex",
        arguments: ["app-server"],
      },
    };
    const proxyUpdate: UpdateProxyProfileRequest = {
      proxyId: PROXY_ID,
      expectedVersion: 1,
      name: "Updated",
      configuration: {
        type: "httpConnect",
        url: "https://proxy.example.test:8443",
        authentication: "none",
        connectTimeoutMs: 5_000,
        tlsCertificatePolicy: "strict",
      },
    };
    const serverDelete: DeleteServerProfileRequest = {
      serverId: SERVER_ID,
      expectedVersion: 2,
    };
    const proxyDelete: DeleteProxyProfileRequest = {
      proxyId: PROXY_ID,
      expectedVersion: 2,
    };

    await updateServerProfile(serverUpdate, ipc);
    await updateProxyProfile(proxyUpdate, ipc);
    await deleteServerProfile(serverDelete, ipc);
    await deleteProxyProfile(proxyDelete, ipc);

    expect(ipc.calls.map((call) => call.command)).toEqual([
      "update_server_profile",
      "update_proxy_profile",
      "delete_server_profile",
      "delete_proxy_profile",
    ]);
    expect(ipc.calls[2]?.arguments).toEqual({ request: serverDelete });
    expect(ipc.calls[3]?.arguments).toEqual({ request: proxyDelete });
  });

  it("拒绝更新响应中的错误标识和版本", async () => {
    const wrongServerIpc = new FakeIpc();
    wrongServerIpc.responses.set("update_server_profile", {
      ...localServerProfile("Updated"),
      serverId: OTHER_SERVER_ID,
      version: 2,
    });
    await expect(
      updateServerProfile(
        {
          serverId: SERVER_ID,
          expectedVersion: 1,
          name: "Updated",
          configuration: {
            type: "localStdio",
            executablePath: "/usr/bin/codex",
            arguments: [],
          },
        },
        wrongServerIpc,
      ),
    ).rejects.toThrow(
      "Invalid configuration contract at server.serverId: does not match the update request",
    );

    const wrongProxyVersionIpc = new FakeIpc();
    wrongProxyVersionIpc.responses.set("update_proxy_profile", {
      ...httpProxyProfile("Updated"),
      version: 1,
    });
    await expect(
      updateProxyProfile(
        {
          proxyId: PROXY_ID,
          expectedVersion: 1,
          name: "Updated",
          configuration: {
            type: "httpConnect",
            url: "https://proxy.example.test:8443",
            authentication: "none",
            connectTimeoutMs: 5_000,
            tlsCertificatePolicy: "strict",
          },
        },
        wrongProxyVersionIpc,
      ),
    ).rejects.toThrow(
      "Invalid configuration contract at proxy.version: does not follow the update request version",
    );
  });

  it("设置和清除凭据时只向对应单次 IPC 传递规范化秘密", async () => {
    const ipc = new FakeIpc();
    const serverSecret = "SERVER_CREDENTIAL_SENTINEL";
    const proxySecret = "PROXY_CREDENTIAL_SENTINEL";
    ipc.responses.set("set_server_credential", {
      ...localServerProfile(),
      version: 2,
      credentialConfigured: true,
      updatedAtMs: 2_000,
    });
    ipc.responses.set("clear_server_credential", {
      ...localServerProfile(),
      version: 3,
      credentialConfigured: false,
      updatedAtMs: 3_000,
    });
    ipc.responses.set("set_proxy_credential", {
      ...httpBasicProxyProfile(),
      version: 2,
      credentialConfigured: true,
      updatedAtMs: 2_000,
    });
    ipc.responses.set("clear_proxy_credential", {
      ...httpBasicProxyProfile(),
      version: 3,
      credentialConfigured: false,
      updatedAtMs: 3_000,
    });

    const setServerRequest = {
      serverId: SERVER_ID,
      expectedVersion: 1,
      ignored: "DROP_SERVER_TOP_LEVEL",
      credential: {
        type: "sensitiveEnvironment",
        values: { OPENAI_API_KEY: serverSecret },
        ignored: "DROP_SERVER_CREDENTIAL_FIELD",
      },
    } as unknown as SetServerCredentialRequest;
    const clearServerRequest = {
      serverId: SERVER_ID,
      expectedVersion: 2,
      credentialType: "sensitiveEnvironment",
      ignored: "DROP_SERVER_CLEAR_FIELD",
    } as unknown as ClearServerCredentialRequest;
    const setProxyRequest = {
      proxyId: PROXY_ID,
      expectedVersion: 1,
      ignored: "DROP_PROXY_TOP_LEVEL",
      credential: {
        type: "httpBasicPassword",
        value: proxySecret,
        ignored: "DROP_PROXY_CREDENTIAL_FIELD",
      },
    } as unknown as SetProxyCredentialRequest;
    const clearProxyRequest = {
      proxyId: PROXY_ID,
      expectedVersion: 2,
      credentialType: "httpBasicPassword",
      ignored: "DROP_PROXY_CLEAR_FIELD",
    } as unknown as ClearProxyCredentialRequest;

    const setServerResult = await setServerCredential(setServerRequest, ipc);
    const clearServerResult = await clearServerCredential(
      clearServerRequest,
      ipc,
    );
    const setProxyResult = await setProxyCredential(setProxyRequest, ipc);
    const clearProxyResult = await clearProxyCredential(clearProxyRequest, ipc);

    expect(ipc.calls).toEqual([
      {
        command: "set_server_credential",
        arguments: {
          request: {
            serverId: SERVER_ID,
            expectedVersion: 1,
            credential: {
              type: "sensitiveEnvironment",
              values: { OPENAI_API_KEY: serverSecret },
            },
          },
        },
      },
      {
        command: "clear_server_credential",
        arguments: {
          request: {
            serverId: SERVER_ID,
            expectedVersion: 2,
            credentialType: "sensitiveEnvironment",
          },
        },
      },
      {
        command: "set_proxy_credential",
        arguments: {
          request: {
            proxyId: PROXY_ID,
            expectedVersion: 1,
            credential: {
              type: "httpBasicPassword",
              value: proxySecret,
            },
          },
        },
      },
      {
        command: "clear_proxy_credential",
        arguments: {
          request: {
            proxyId: PROXY_ID,
            expectedVersion: 2,
            credentialType: "httpBasicPassword",
          },
        },
      },
    ]);
    const serializedCalls = JSON.stringify(ipc.calls);
    expect(serializedCalls.split(serverSecret)).toHaveLength(2);
    expect(serializedCalls.split(proxySecret)).toHaveLength(2);
    expect(serializedCalls).not.toMatch(/DROP_SERVER|DROP_PROXY/u);
    expect(
      JSON.stringify([
        setServerResult,
        clearServerResult,
        setProxyResult,
        clearProxyResult,
      ]),
    ).not.toMatch(/SERVER_CREDENTIAL_SENTINEL|PROXY_CREDENTIAL_SENTINEL/u);
    expect(setServerResult.credentialConfigured).toBe(true);
    expect(clearServerResult.credentialConfigured).toBe(false);
    expect(setProxyResult.credentialConfigured).toBe(true);
    expect(clearProxyResult.credentialConfigured).toBe(false);
  });

  it("拒绝凭据命令返回与操作相反的配置状态", async () => {
    const setServerIpc = new FakeIpc();
    setServerIpc.responses.set("set_server_credential", localServerProfile());
    await expect(
      setServerCredential(
        {
          serverId: SERVER_ID,
          expectedVersion: 1,
          credential: {
            type: "sensitiveEnvironment",
            values: { ACCESS_TOKEN: "server-secret" },
          },
        },
        setServerIpc,
      ),
    ).rejects.toBeInstanceOf(ConfigurationContractError);

    const clearServerIpc = new FakeIpc();
    clearServerIpc.responses.set("clear_server_credential", {
      ...localServerProfile(),
      credentialConfigured: true,
    });
    await expect(
      clearServerCredential(
        {
          serverId: SERVER_ID,
          expectedVersion: 1,
          credentialType: "sensitiveEnvironment",
        },
        clearServerIpc,
      ),
    ).rejects.toBeInstanceOf(ConfigurationContractError);

    const setProxyIpc = new FakeIpc();
    setProxyIpc.responses.set("set_proxy_credential", httpBasicProxyProfile());
    await expect(
      setProxyCredential(
        {
          proxyId: PROXY_ID,
          expectedVersion: 1,
          credential: { type: "httpBasicPassword", value: "proxy-secret" },
        },
        setProxyIpc,
      ),
    ).rejects.toBeInstanceOf(ConfigurationContractError);

    const clearProxyIpc = new FakeIpc();
    clearProxyIpc.responses.set("clear_proxy_credential", {
      ...httpBasicProxyProfile(),
      credentialConfigured: true,
    });
    await expect(
      clearProxyCredential(
        {
          proxyId: PROXY_ID,
          expectedVersion: 1,
          credentialType: "httpBasicPassword",
        },
        clearProxyIpc,
      ),
    ).rejects.toBeInstanceOf(ConfigurationContractError);
  });

  it("拒绝凭据响应的错误标识、类型和 set 版本", async () => {
    const wrongIdIpc = new FakeIpc();
    wrongIdIpc.responses.set("set_server_credential", {
      ...localServerProfile(),
      serverId: OTHER_SERVER_ID,
      version: 2,
      credentialConfigured: true,
    });
    await expect(
      setServerCredential(
        {
          serverId: SERVER_ID,
          expectedVersion: 1,
          credential: {
            type: "sensitiveEnvironment",
            values: { ACCESS_TOKEN: "server-secret" },
          },
        },
        wrongIdIpc,
      ),
    ).rejects.toThrow(
      "Invalid configuration contract at server.serverId: does not match the credential request",
    );

    const wrongTypeIpc = new FakeIpc();
    wrongTypeIpc.responses.set("set_server_credential", {
      ...localServerProfile(),
      version: 2,
      credentialConfigured: true,
    });
    await expect(
      setServerCredential(
        {
          serverId: SERVER_ID,
          expectedVersion: 1,
          credential: { type: "bearerToken", value: "server-secret" },
        },
        wrongTypeIpc,
      ),
    ).rejects.toThrow(
      "Invalid configuration contract at server.configuration: does not match the requested credential type",
    );

    const unchangedVersionIpc = new FakeIpc();
    unchangedVersionIpc.responses.set("set_proxy_credential", {
      ...httpBasicProxyProfile(),
      credentialConfigured: true,
    });
    await expect(
      setProxyCredential(
        {
          proxyId: PROXY_ID,
          expectedVersion: 1,
          credential: { type: "httpBasicPassword", value: "proxy-secret" },
        },
        unchangedVersionIpc,
      ),
    ).rejects.toThrow(
      "Invalid configuration contract at proxy.version: does not satisfy the set credential version contract",
    );
  });

  it("接受 clear 凭据的同版本幂等响应", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("clear_server_credential", localServerProfile());

    const profile = await clearServerCredential(
      {
        serverId: SERVER_ID,
        expectedVersion: 1,
        credentialType: "sensitiveEnvironment",
      },
      ipc,
    );

    expect(profile.version).toBe(1);
    expect(profile.credentialConfigured).toBe(false);
  });

  it("凭据命令错误只返回固定公开文案且不回显请求秘密", async () => {
    const ipc = new FakeIpc();
    const secret = "ERROR_SECRET_SENTINEL";
    ipc.failure = {
      code: "credentialStorageFailed",
      message: "The system credential operation failed",
    };

    const error = await setServerCredential(
      {
        serverId: SERVER_ID,
        expectedVersion: 1,
        credential: { type: "bearerToken", value: secret },
      },
      ipc,
    ).catch((failure: unknown) => failure);

    expect(ipc.calls).toHaveLength(1);
    expect(JSON.stringify(ipc.calls[0])).toContain(secret);
    expect(error).toMatchObject({
      code: "credentialStorageFailed",
      message: "The system credential operation failed",
    });
    expect(String(error)).not.toContain(secret);
  });

  it("请求校验失败时不调用后端", async () => {
    const ipc = new FakeIpc();
    const request = {
      name: "Invalid",
      configuration: {
        type: "socks5",
        host: "proxy.example.test",
        port: 0,
        authentication: "none",
        dnsResolution: "proxy",
        connectTimeoutMs: 5_000,
      },
    } as const;

    await expect(createProxyProfile(request, ipc)).rejects.toBeInstanceOf(
      ConfigurationContractError,
    );
    expect(ipc.calls).toHaveLength(0);
  });

  it("显式移除 SSH 主机密钥并严格解析更新后的代理", async () => {
    const ipc = new FakeIpc();
    const updated = sshProxyProfileWithHostKey();
    const { sshHostKey: _removedHostKey, ...withoutHostKey } = updated;
    ipc.responses.set("remove_proxy_ssh_host_key", {
      ...withoutHostKey,
      version: 2,
      updatedAtMs: 3_000,
    });
    const request = {
      proxyId: PROXY_ID,
      expectedVersion: 1,
      ignored: "DO_NOT_FORWARD",
    } as unknown as RemoveProxySshHostKeyRequest;

    const profile = await removeProxySshHostKey(request, ipc);

    expect(profile.version).toBe(2);
    expect(profile.sshHostKey).toBeUndefined();
    expect(ipc.calls).toEqual([
      {
        command: "remove_proxy_ssh_host_key",
        arguments: {
          request: { proxyId: PROXY_ID, expectedVersion: 1 },
        },
      },
    ]);
    expect(JSON.stringify(ipc.calls)).not.toContain("DO_NOT_FORWARD");
  });

  it("只提交结构化 SSH 主机密钥确认并核对响应", async () => {
    const ipc = new FakeIpc();
    const confirmed = { ...sshProxyProfileWithHostKey(), version: 2 };
    ipc.responses.set("confirm_proxy_ssh_host_key", confirmed);
    const request = {
      proxyId: PROXY_ID,
      expectedVersion: 1,
      host: "ssh.example.test",
      port: 22,
      algorithm: "ssh-ed25519",
      sha256Fingerprint: `SHA256:${"A".repeat(43)}`,
      ignored: "DO_NOT_FORWARD",
    } as unknown as ConfirmProxySshHostKeyRequest;

    const profile = await confirmProxySshHostKey(request, ipc);

    expect(profile.sshHostKey?.sha256Fingerprint).toBe(request.sha256Fingerprint);
    expect(ipc.calls[0]).toEqual({
      command: "confirm_proxy_ssh_host_key",
      arguments: { request: {
        proxyId: PROXY_ID,
        expectedVersion: 1,
        host: "ssh.example.test",
        port: 22,
        algorithm: "ssh-ed25519",
        sha256Fingerprint: request.sha256Fingerprint,
      } },
    });
    expect(JSON.stringify(ipc.calls)).not.toContain("DO_NOT_FORWARD");
  });

  it("记录代理测试结果时保持配置版本不变", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("record_proxy_test", {
      ...httpProxyProfile(),
      lastTest: { status: "failed", testedAtMs: 2_000 },
    });
    const request: RecordProxyTestRequest = {
      proxyId: PROXY_ID,
      expectedVersion: 1,
      status: "failed",
    };

    const profile = await recordProxyTest(request, ipc);

    expect(profile.version).toBe(1);
    expect(profile.lastTest?.status).toBe("failed");
    expect(ipc.calls[0]).toEqual({
      command: "record_proxy_test",
      arguments: { request },
    });
  });

  it("拒绝服务器删除命令的非 null 响应", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("delete_server_profile", {});

    await expect(
      deleteServerProfile({ serverId: SERVER_ID, expectedVersion: 1 }, ipc),
    ).rejects.toBeInstanceOf(ConfigurationContractError);
  });

  it("拒绝代理删除命令的非 null 响应", async () => {
    const ipc = new FakeIpc();
    ipc.responses.set("delete_proxy_profile", "deleted");

    await expect(
      deleteProxyProfile({ proxyId: PROXY_ID, expectedVersion: 1 }, ipc),
    ).rejects.toBeInstanceOf(ConfigurationContractError);
  });

  it("保留严格匹配的公开命令错误", async () => {
    const ipc = new FakeIpc();
    ipc.failure = {
      code: "serverNotFound",
      message: "The server does not exist",
    };

    const error = await listConfigurationProfiles(ipc).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ConfigurationCommandError);
    expect(error).toMatchObject({
      code: "serverNotFound",
      message: "The server does not exist",
    });
  });

  it("识别后端的必需凭据未配置错误", async () => {
    const ipc = new FakeIpc();
    ipc.failure = {
      code: "credentialNotConfigured",
      message: "The required credential is not configured",
    };

    await expect(listConfigurationProfiles(ipc)).rejects.toMatchObject({
      code: "credentialNotConfigured",
      message: "The required credential is not configured",
    });
  });

  it("将未知 IPC 错误替换为不含原始上下文的公开错误", async () => {
    const ipc = new FakeIpc();
    const failure = new Error(
      "configuration database unavailable at /home/alice/private.sqlite3",
    );
    ipc.failure = failure;

    const error = await listConfigurationProfiles(ipc).catch(
      (rejection: unknown) => rejection,
    );

    expect(error).toBeInstanceOf(ConfigurationCommandError);
    expect(error).not.toBe(failure);
    expect(error).toMatchObject({
      code: "configurationCommandFailed",
      message: "The configuration operation failed",
    });
    expect(String(error)).not.toContain("private.sqlite3");
  });

  it.each([
    {
      code: "unknownCode",
      message: "The server does not exist",
    },
    {
      code: "serverNotFound",
      message: "server secret leaked",
    },
    {
      code: "serverNotFound",
      message: "The server does not exist",
      detail: "sensitive detail",
    },
  ])("拒绝畸形命令错误 %#", async (failure) => {
    const ipc = new FakeIpc();
    ipc.failure = failure;

    await expect(listConfigurationProfiles(ipc)).rejects.toMatchObject({
      code: "configurationCommandFailed",
      message: "The configuration operation failed",
    });
  });
});
