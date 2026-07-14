import { describe, expect, it } from "vitest";

import type { ServerId, ServerProfile } from "../configuration";
import {
  ServerEditorFormError,
  buildServerEditorSubmission,
  createServerEditorDraft,
  hasServerCredentialBindingChanged,
  isPlaintextWebSocketUrl,
  type ServerEditorDraft,
} from "./serverEditorModel";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

function localProfile(credentialConfigured = false): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "本机 Codex",
    version: 3,
    configuration: {
      type: "localStdio",
      executablePath: "/usr/bin/codex",
      arguments: ["", "line one\nline two", "tail"],
      defaultWorkingDirectory: "/home/user/project",
      nonSensitiveEnvironment: {
        EMPTY: "",
        MULTILINE: "first\nsecond",
      },
    },
    credentialConfigured,
    activeWindowCount: 0,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}

function remoteProfile(credentialConfigured = true): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "远程 Codex",
    version: 3,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.com/app-server",
      authentication: "bearer",
      nonSensitiveHeaders: { "X-Client": "desktop" },
      connectTimeoutMs: 30000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialConfigured,
    activeWindowCount: 0,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}

function build(
  mode: { readonly type: "edit"; readonly profile: ServerProfile },
  draft: ServerEditorDraft,
) {
  return buildServerEditorSubmission({
    mode,
    draft,
    availableProxyIds: new Set(),
  });
}

describe("serverEditorModel", () => {
  it("无损往返空参数、含换行参数和含换行环境变量值", () => {
    const profile = localProfile();
    const mode = { type: "edit", profile } as const;
    const draft = createServerEditorDraft(mode);

    expect(draft.local.arguments).toEqual(["", "line one\nline two", "tail"]);
    expect(draft.local.nonSensitiveEnvironment).toEqual([
      { name: "EMPTY", value: "" },
      { name: "MULTILINE", value: "first\nsecond" },
    ]);

    expect(build(mode, draft)).toEqual({
      name: profile.name,
      configuration: profile.configuration,
      credentialIntent: { type: "keep" },
    });
  });

  it("按后端规则判断本机凭据绑定变化", () => {
    const profile = localProfile(true);
    const base = profile.configuration;
    if (base.type !== "localStdio") {
      throw new Error("Expected a local profile");
    }

    expect(hasServerCredentialBindingChanged(profile, base)).toBe(false);
    expect(
      hasServerCredentialBindingChanged(profile, {
        ...base,
        executablePath: "/opt/codex",
      }),
    ).toBe(true);
    expect(
      hasServerCredentialBindingChanged(profile, {
        ...base,
        nonSensitiveEnvironment: {
          ...base.nonSensitiveEnvironment,
          NEW_NAME: "value",
        },
      }),
    ).toBe(true);
    expect(
      hasServerCredentialBindingChanged(profile, {
        ...base,
        nonSensitiveEnvironment: { EMPTY: "changed" },
      }),
    ).toBe(false);
    expect(
      hasServerCredentialBindingChanged(profile, {
        type: "remoteWebSocket",
        url: "wss://codex.example.com",
        authentication: "none",
        nonSensitiveHeaders: {},
        connectTimeoutMs: 30000,
        tlsCertificatePolicy: "strict",
        plaintextConfirmed: false,
      }),
    ).toBe(true);
  });

  it("按规范化 origin 判断远程凭据绑定变化", () => {
    const profile = remoteProfile();
    const base = profile.configuration;
    if (base.type !== "remoteWebSocket") {
      throw new Error("Expected a remote profile");
    }

    expect(
      hasServerCredentialBindingChanged(profile, {
        ...base,
        url: "wss://CODEX.example.com:443/another-path",
      }),
    ).toBe(false);
    expect(
      hasServerCredentialBindingChanged(profile, {
        ...base,
        url: "wss://other.example.com/app-server",
      }),
    ).toBe(true);
    expect(
      hasServerCredentialBindingChanged(profile, {
        ...base,
        authentication: "none",
      }),
    ).toBe(true);
  });

  it("绑定范围变化时拒绝 keep 并允许显式 set", () => {
    const profile = remoteProfile();
    const mode = { type: "edit", profile } as const;
    const changed = createServerEditorDraft(mode);
    const changedOrigin: ServerEditorDraft = {
      ...changed,
      remote: {
        ...changed.remote,
        url: "wss://other.example.com/app-server",
      },
    };

    expect(() => build(mode, changedOrigin)).toThrowError(
      expect.objectContaining({
        field: "credential",
        message: expect.stringContaining("身份范围"),
      }),
    );

    expect(
      build(mode, {
        ...changedOrigin,
        remote: { ...changedOrigin.remote, bearerToken: "replacement-token" },
      }).credentialIntent,
    ).toEqual({
      type: "set",
      credential: { type: "bearerToken", value: "replacement-token" },
    });
  });

  it("编辑无已保存凭据的配置切换 Bearer 时要求令牌", () => {
    const profile = remoteProfile(false);
    const mode = { type: "edit", profile } as const;
    const draft = createServerEditorDraft(mode);

    expect(() => build(mode, draft)).toThrowError(
      expect.objectContaining({ field: "bearerToken" }),
    );
  });

  it("在提交前拒绝普通与敏感环境变量重名", () => {
    const mode = { type: "edit", profile: localProfile() } as const;
    const draft = createServerEditorDraft(mode);

    expect(() =>
      build(mode, {
        ...draft,
        local: {
          ...draft.local,
          sensitiveEnvironment: [{ name: "EMPTY", value: "secret" }],
        },
      }),
    ).toThrowError(expect.objectContaining({ field: "sensitiveEnvironment" }));
  });

  it("无损保留合法的 __proto__ 环境变量名", () => {
    const mode = { type: "edit", profile: localProfile() } as const;
    const initial = createServerEditorDraft(mode);
    const submission = build(mode, {
      ...initial,
      local: {
        ...initial.local,
        nonSensitiveEnvironment: [
          { name: "__proto__", value: "literal-value" },
        ],
      },
    });

    expect(
      submission.configuration.type === "localStdio"
        ? submission.configuration.nonSensitiveEnvironment?.["__proto__"]
        : undefined,
    ).toBe("literal-value");
    expect(
      Object.prototype.hasOwnProperty.call(
        submission.configuration.type === "localStdio"
          ? submission.configuration.nonSensitiveEnvironment
          : {},
        "__proto__",
      ),
    ).toBe(true);
  });

  it("按大小写不敏感规则拒绝重复请求头", () => {
    const mode = { type: "edit", profile: remoteProfile(false) } as const;
    const initial = createServerEditorDraft(mode);
    const draft: ServerEditorDraft = {
      ...initial,
      remote: {
        ...initial.remote,
        authentication: "none",
        nonSensitiveHeaders: [
          { name: "X-Trace", value: "one" },
          { name: "x-trace", value: "two" },
        ],
      },
    };

    expect(() => build(mode, draft)).toThrowError(
      expect.objectContaining({ field: "nonSensitiveHeaders" }),
    );
  });

  it("使用 URL 解析结果识别带前导空白的 ws 地址", () => {
    expect(isPlaintextWebSocketUrl("  ws://codex.internal/app-server")).toBe(
      true,
    );
    expect(isPlaintextWebSocketUrl("wss://codex.example.com")).toBe(false);
    expect(isPlaintextWebSocketUrl("ws://")).toBe(false);
  });

  it("表单错误保留对应字段", () => {
    const error = new ServerEditorFormError("arguments", "参数错误");
    expect(error.field).toBe("arguments");
  });
});
