import { describe, expect, it } from "vitest";

import type { ProxyId, ProxyProfile } from "../configuration";
import {
  buildProxyEditorSubmission,
  createProxyEditorDraft,
  existingProxyCredentialType,
} from "./proxyEditorModel";

const PROXY_ID = "11111111-1111-4111-8111-111111111111" as ProxyId;

function httpProfile(): ProxyProfile {
  return {
    proxyId: PROXY_ID,
    name: "开发代理",
    version: 2,
    configuration: {
      type: "httpConnect",
      url: "https://proxy.example.test",
      authentication: "basic",
      username: "codex",
      nonSensitiveHeaders: { "X-Client": "desktop" },
      connectTimeoutMs: 30_000,
      tlsCertificatePolicy: "strict",
    },
    credentialConfigured: true,
    referencedServerCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

describe("proxyEditorModel", () => {
  it("编辑时不回填凭据并保留已保存凭据", () => {
    const profile = httpProfile();
    const mode = { type: "edit", profile } as const;
    const draft = createProxyEditorDraft(mode);
    expect(draft.httpConnect.secret).toBe("");
    expect(existingProxyCredentialType(profile)).toBe("httpBasicPassword");
    expect(buildProxyEditorSubmission(mode, draft).credentialIntent).toEqual({ type: "keep" });
  });

  it("构建三种代理配置并默认使用代理 DNS", () => {
    const base = createProxyEditorDraft({ type: "create" });
    const http = buildProxyEditorSubmission({ type: "create" }, {
      ...base,
      name: "HTTP 代理",
      httpConnect: {
        ...base.httpConnect,
        url: "http://127.0.0.1:8080",
        authentication: "bearer",
        secret: "token-value",
      },
    });
    expect(http.credentialIntent).toEqual({ type: "set", credential: { type: "httpBearerToken", value: "token-value" } });

    const socks = buildProxyEditorSubmission({ type: "create" }, {
      ...base,
      proxyType: "socks5",
      name: "SOCKS 代理",
      socks5: { ...base.socks5, host: "127.0.0.1" },
    });
    expect(socks.configuration).toMatchObject({ type: "socks5", dnsResolution: "proxy" });

    const ssh = buildProxyEditorSubmission({ type: "create" }, {
      ...base,
      proxyType: "ssh",
      name: "SSH 代理",
      ssh: { ...base.ssh, host: "ssh.example.test", username: "dev" },
    });
    expect(ssh.configuration).toMatchObject({ type: "ssh", authentication: { type: "agent" } });
  });

  it("认证方式变化必须显式提供新凭据", () => {
    const profile = httpProfile();
    const mode = { type: "edit", profile } as const;
    const draft = createProxyEditorDraft(mode);
    expect(() => buildProxyEditorSubmission(mode, {
      ...draft,
      httpConnect: { ...draft.httpConnect, authentication: "bearer" },
    })).toThrow("更换认证方式时必须填写新的凭据");
  });
});
