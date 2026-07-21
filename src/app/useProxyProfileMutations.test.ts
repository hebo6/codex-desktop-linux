import { describe, expect, it, vi } from "vitest";

import type { ProxyId, ProxyProfile } from "../configuration";
import type { ProxyEditorSubmission } from "../components/proxyEditorModel";
import { executeProxyProfileSave, type ProxyProfileMutationCommands } from "./useProxyProfileMutations";

const PROXY_ID = "11111111-1111-4111-8111-111111111111" as ProxyId;

function profile(version: number, authentication: "none" | "basic" | "bearer" = "none", credentialConfigured = false): ProxyProfile {
  return {
    proxyId: PROXY_ID,
    name: "开发代理",
    version,
    configuration: {
      type: "httpConnect",
      url: "http://127.0.0.1:8080",
      authentication,
      ...(authentication === "basic" ? { username: "dev" } : {}),
      nonSensitiveHeaders: {},
      connectTimeoutMs: 30_000,
      tlsCertificatePolicy: "strict",
    },
    credentialConfigured,
    referencedServerCount: 0,
    createdAtMs: 1,
    updatedAtMs: version,
  };
}

function sshProfile(version: number): ProxyProfile {
  return {
    ...profile(version),
    configuration: {
      type: "ssh",
      host: "ssh.example.test",
      port: 22,
      username: "dev",
      authentication: { type: "agent" },
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 15_000,
      keepAliveMaxFailures: 3,
    },
  };
}

function commands(): ProxyProfileMutationCommands {
  return {
    createProxyProfile: vi.fn(async () => profile(1)),
    updateProxyProfile: vi.fn(async (request) => profile(request.expectedVersion + 1, request.configuration.type === "httpConnect" ? request.configuration.authentication : "none", false)),
    deleteProxyProfile: vi.fn(async () => undefined),
    setProxyCredential: vi.fn(async (request) => profile(request.expectedVersion + 1, request.credential.type === "httpBearerToken" ? "bearer" : "basic", true)),
    clearProxyCredential: vi.fn(async (request) => profile(request.expectedVersion + 1, "basic", false)),
    removeProxySshHostKey: vi.fn(async () => profile(2)),
    confirmProxySshHostKey: vi.fn(async () => profile(2)),
    recordProxyTest: vi.fn(async (request) => ({ ...profile(request.expectedVersion), lastTest: { status: request.status, testedAtMs: 2 } })),
  };
}

const submission: ProxyEditorSubmission = {
  name: "开发代理",
  configuration: {
    type: "httpConnect",
    url: "http://127.0.0.1:8080",
    authentication: "bearer",
    nonSensitiveHeaders: {},
    connectTimeoutMs: 30_000,
    tlsCertificatePolicy: "strict",
  },
  credentialIntent: { type: "set", credential: { type: "httpBearerToken", value: "secret" } },
};

describe("proxy profile mutations", () => {
  it("创建配置后按服务端返回版本保存凭据", async () => {
    const api = commands();
    const confirmed: ProxyProfile[] = [];
    const outcome = await executeProxyProfileSave({ type: "create" }, submission, api, (value) => { confirmed.push(value); return value; }, true);
    expect(outcome.status).toBe("saved");
    expect(api.setProxyCredential).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, plaintextFallbackConfirmed: true }));
    expect(confirmed.map(({ version }) => version)).toEqual([1, 2]);
  });

  it("更换凭据类型时先清除旧凭据再更新配置", async () => {
    const api = commands();
    const outcome = await executeProxyProfileSave({ type: "edit", profile: profile(4, "basic", true) }, submission, api, (value) => value);
    expect(outcome.status).toBe("saved");
    expect(api.clearProxyCredential).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 4, credentialType: "httpBasicPassword" }));
    expect(api.updateProxyProfile).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 5 }));
    expect(api.setProxyCredential).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 6 }));
  });

  it("配置已保存但凭据失败时返回可恢复的部分成功", async () => {
    const api = commands();
    vi.mocked(api.setProxyCredential).mockRejectedValue(new Error("secret service unavailable"));
    const outcome = await executeProxyProfileSave({ type: "create" }, submission, api, (value) => value);
    expect(outcome).toMatchObject({ status: "partiallySaved", dataEffect: "configurationSavedCredentialNotSaved", profile: { version: 1 } });
  });

  it("只在保存草稿后持久化测试确认的 SSH 主机密钥", async () => {
    const api = commands();
    vi.mocked(api.createProxyProfile).mockResolvedValue(sshProfile(1));
    vi.mocked(api.confirmProxySshHostKey).mockImplementation(async (request) => ({
      ...sshProfile(request.expectedVersion + 1),
      sshHostKey: {
        host: request.host,
        port: request.port,
        algorithm: request.algorithm,
        sha256Fingerprint: request.sha256Fingerprint,
        confirmedAtMs: 2,
      },
    }));
    const outcome = await executeProxyProfileSave(
      { type: "create" },
      {
        name: "SSH 代理",
        configuration: sshProfile(1).configuration,
        credentialIntent: { type: "keep" },
        sshHostKey: {
          host: "ssh.example.test",
          port: 22,
          algorithm: "ssh-ed25519",
          sha256Fingerprint: `SHA256:${"A".repeat(43)}`,
        },
      },
      api,
      (value) => value,
    );

    expect(outcome).toMatchObject({ status: "saved", profile: { version: 2 } });
    expect(api.confirmProxySshHostKey).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 1,
      host: "ssh.example.test",
    }));
  });
});
