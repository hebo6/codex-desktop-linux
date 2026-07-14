import { describe, expect, it } from "vitest";

import { schemaProtocolBoundary } from "./protocolBoundary";

describe("schemaProtocolBoundary", () => {
  it("使用真实 Schema 区分已知、未知和参数非法的服务端请求", () => {
    const known = {
      id: 1,
      method: "currentTime/read",
      params: { threadId: "thread-1" },
    };
    const unknown = {
      id: 2,
      method: "future/request",
      params: {},
    };
    const invalid = {
      id: 3,
      method: "currentTime/read",
      params: { threadId: 42 },
    };

    expect(schemaProtocolBoundary.validateMessage(known).ok).toBe(true);
    expect(schemaProtocolBoundary.validateServerRequest(known).kind).toBe("valid");
    expect(schemaProtocolBoundary.validateServerRequest(unknown)).toMatchObject({
      kind: "unknown_method",
      validation: {
        code: "unknown_method",
        stage: "method",
      },
    });
    expect(schemaProtocolBoundary.validateServerRequest(invalid)).toMatchObject({
      kind: "invalid_params",
      validation: {
        code: "invalid_params",
        stage: "params",
      },
    });
    expect(
      JSON.stringify(schemaProtocolBoundary.validateServerRequest(unknown)),
    ).not.toContain("future/request");
  });

  it("使用真实 Schema 区分已知、未知和参数非法的服务端通知", () => {
    const known = {
      method: "serverRequest/resolved",
      params: { requestId: 1, threadId: "thread-1" },
    };
    const unknown = {
      method: "future/notification",
      params: {},
    };
    const invalid = {
      method: "serverRequest/resolved",
      params: { requestId: 1, threadId: 42 },
    };

    expect(schemaProtocolBoundary.validateServerNotification(known).kind).toBe(
      "valid",
    );
    expect(schemaProtocolBoundary.validateServerNotification(unknown)).toMatchObject(
      {
        kind: "unknown_method",
        validation: {
          code: "unknown_method",
          stage: "method",
        },
      },
    );
    expect(schemaProtocolBoundary.validateServerNotification(invalid)).toMatchObject(
      {
        kind: "invalid_params",
        validation: {
          code: "invalid_params",
          stage: "params",
        },
      },
    );
    expect(schemaProtocolBoundary.validateMessage({ result: {} })).toMatchObject({
      ok: false,
      error: {
        code: "invalid_envelope",
        stage: "envelope",
      },
    });
  });

  it("使用真实 Schema 固定校验 initialize 响应并隐藏原始字段值", () => {
    const valid = {
      codexHome: "/home/user/.codex",
      platformFamily: "unix",
      platformOs: "linux",
      userAgent: "codex-test",
    };
    const invalid = {
      codexHome: "DO_NOT_LOG_CODEX_HOME",
      platformFamily: "unix",
      platformOs: 42,
      userAgent: "codex-test",
    };

    expect(schemaProtocolBoundary.validateInitializeResponse(valid)).toEqual({
      ok: true,
      value: valid,
    });
    const result = schemaProtocolBoundary.validateInitializeResponse(invalid);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_params",
        stage: "params",
      },
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_LOG_CODEX_HOME");
  });
});
