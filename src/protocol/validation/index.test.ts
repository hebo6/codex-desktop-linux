import { describe, expect, it } from "vitest";

import type { ClientRequest } from "../generated";
import {
  parseJsonRpcMessage,
  validateConfigReadResponse,
  validateConfigRequirementsReadResponse,
  validateInitializeResponse,
  validateJsonRpcMessage,
  validateServerNotification,
  validateServerRequest,
  validateThreadListResponse,
  validateThreadReadResponse,
  validateThreadResumeResponse,
  validateThreadTurnsListResponse,
} from ".";

describe("协议运行时边界", () => {
  it("接受固定 Schema 中的稳定服务端通知", () => {
    expect(
      validateServerNotification({
        method: "warning",
        params: { message: "连接即将重试" },
      }),
    ).toEqual({
      ok: true,
      value: {
        method: "warning",
        params: { message: "连接即将重试" },
      },
    });
  });

  it("生成的 ClientRequest 联合包含实验方法 thread/turns/list", () => {
    const request: Extract<ClientRequest, { method: "thread/turns/list" }> = {
      id: 1,
      method: "thread/turns/list",
      params: { threadId: "thread-1" },
    };

    expect(request.method).toBe("thread/turns/list");
  });

  it("不把独立负载 rawResponseItem/completed 当作合法服务端通知", () => {
    const result = validateServerNotification({
      method: "rawResponseItem/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: {} },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unknown_method", stage: "method" },
    });
  });

  it("拒绝非法 JSON、非法 envelope 和已知方法的非法 params", () => {
    const parseResult = parseJsonRpcMessage('{"token":"secret"');
    expect(parseResult).toMatchObject({
      ok: false,
      error: { code: "invalid_json", stage: "parse" },
    });
    if (!parseResult.ok) {
      expect(parseResult.error.summary).not.toContain("secret");
    }

    expect(validateJsonRpcMessage({ params: {} })).toMatchObject({
      ok: false,
      error: { code: "invalid_envelope", stage: "envelope" },
    });

    const paramsResult = validateServerNotification({
      method: "warning",
      params: { message: { token: "secret" } },
    });
    expect(paramsResult).toMatchObject({
      ok: false,
      error: { code: "invalid_params", stage: "params" },
    });
    if (!paramsResult.ok) {
      expect(paramsResult.error.summary).not.toContain("secret");
    }
  });

  it("int64 只接受 JS safe integer 并拒绝小数", () => {
    expect(validateJsonRpcMessage({ id: Number.MAX_SAFE_INTEGER, result: null }).ok).toBe(true);
    expect(validateJsonRpcMessage({ id: Number.MAX_SAFE_INTEGER + 1, result: null }).ok).toBe(false);
    expect(validateJsonRpcMessage({ id: 1.5, result: null }).ok).toBe(false);
  });

  it("校验 initialize 响应负载", () => {
    expect(
      validateInitializeResponse({
        codexHome: "/home/user/.codex",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "codex/1.0",
      }).ok,
    ).toBe(true);
    expect(
      validateInitializeResponse({
        codexHome: "/home/user/.codex",
        platformFamily: "unix",
        platformOs: "linux",
      }).ok,
    ).toBe(false);
  });

  it("校验配置和管理要求读取响应", () => {
    expect(
      validateConfigReadResponse({
        config: { default_permissions: ":workspace" },
        origins: {},
      }).ok,
    ).toBe(true);
    expect(
      validateConfigRequirementsReadResponse({
        requirements: {
          allowedPermissionProfiles: { ":workspace": true },
          defaultPermissions: ":workspace",
        },
      }).ok,
    ).toBe(true);
  });

  it("校验会话列表、读取、恢复和 turn 分页响应", () => {
    const turn = {
      id: "turn-1",
      items: [],
      itemsView: "full",
      status: "completed",
    };
    const thread = {
      cliVersion: "1.0.0",
      createdAt: 100,
      cwd: "/workspace",
      ephemeral: false,
      id: "thread-1",
      modelProvider: "openai",
      preview: "实现会话恢复",
      sessionId: "session-1",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: 200,
    };

    expect(validateThreadListResponse({ data: [thread] }).ok).toBe(true);
    expect(validateThreadReadResponse({ thread }).ok).toBe(true);
    expect(
      validateThreadResumeResponse({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        cwd: "/workspace",
        initialTurnsPage: { data: [turn], nextCursor: "older" },
        model: "gpt-5",
        modelProvider: "openai",
        sandbox: { type: "readOnly" },
        thread: { ...thread, turns: [turn] },
      }).ok,
    ).toBe(true);
    expect(
      validateThreadTurnsListResponse({ data: [turn], nextCursor: null }).ok,
    ).toBe(true);

    const invalid = validateThreadListResponse({ data: "secret-value" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.summary).not.toContain("secret-value");
    }
  });

  it("按 int32、uint、uint16、uint32 和 uint64 边界拒绝越界值", () => {
    expect(
      validateServerNotification({
        method: "process/exited",
        params: {
          exitCode: 2_147_483_648,
          processHandle: "process-1",
          stderr: "",
          stderrCapReached: false,
          stdout: "",
          stdoutCapReached: false,
        },
      }).ok,
    ).toBe(false);

    expect(
      validateServerNotification({
        method: "windows/worldWritableWarning",
        params: { extraCount: -1, failedScan: false, samplePaths: [] },
      }).ok,
    ).toBe(false);

    expect(
      validateServerNotification({
        method: "thread/realtime/outputAudio/delta",
        params: {
          audio: {
            data: "",
            numChannels: 65_536,
            sampleRate: 4_294_967_296,
          },
          threadId: "thread-1",
        },
      }).ok,
    ).toBe(false);

    expect(
      validateServerNotification({
        method: "item/completed",
        params: {
          completedAtMs: 0,
          item: {
            durationMs: Number.MAX_SAFE_INTEGER + 1,
            id: "sleep-1",
            type: "sleep",
          },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }).ok,
    ).toBe(false);
  });

  it("double 拒绝非有限数", () => {
    expect(
      validateServerRequest({
        id: 1,
        method: "mcpServer/elicitation/request",
        params: {
          message: "填写数字",
          mode: "form",
          requestedSchema: {
            properties: {
              amount: { maximum: Number.POSITIVE_INFINITY, type: "number" },
            },
            type: "object",
          },
          serverName: "example",
          threadId: "thread-1",
        },
      }).ok,
    ).toBe(false);
  });
});
