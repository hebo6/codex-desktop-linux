import { describe, expect, expectTypeOf, it } from "vitest";

import type { ClientRequest, ThreadItemsListResponse, UserInput } from "../generated";
import {
  parseJsonRpcMessage,
  validateConfigReadResponse,
  validateConfigRequirementsReadResponse,
  validateGetAccountResponse,
  validateInitializeResponse,
  validateJsonRpcMessage,
  validateModelListResponse,
  validateServerNotification,
  validateServerRequest,
  validateThreadListResponse,
  validateThreadReadResponse,
  validateThreadResumeResponse,
  validateThreadItemsListResponse,
  validateThreadTurnsListResponse,
  validateUserInput,
} from ".";

describe("协议运行时边界", () => {
  it("校验并保留用户输入中的文本元素、附件、引用与扩展字段", () => {
    const inputs: UserInput[] = [
      {
        type: "text",
        text: "查看 @file",
        text_elements: [{ byteRange: { start: 7, end: 12 }, placeholder: "@file" }],
        extra: { preserved: true },
      },
      { type: "image", url: "https://example.com/image.png", detail: "original" },
      { type: "image", fileId: "file-1" },
      { type: "localImage", path: "/workspace/image.png", detail: "high" },
      { type: "audio", url: "https://example.com/audio.wav" },
      { type: "localAudio", path: "/workspace/audio.wav" },
      { type: "skill", name: "review", path: "/workspace/SKILL.md" },
      { type: "mention", name: "file", path: "/workspace/file.ts" },
    ];
    const original = structuredClone(inputs);

    for (const input of inputs) {
      const result = validateUserInput(input);
      expect(result).toEqual({ ok: true, value: input });
      if (result.ok) expect(result.value).toBe(input);
    }
    expect(inputs).toEqual(original);
  });

  it("拒绝缺失关键字段或包含损坏文本元素的用户输入", () => {
    for (const input of [
      null,
      {},
      { type: "text", text: 1 },
      { type: "image" },
      { type: "localImage" },
      { type: "audio" },
      { type: "mention", name: "file" },
      { type: "text", text: "file", text_elements: [{ byteRange: { start: -1, end: 4 } }] },
    ]) {
      expect(validateUserInput(input).ok).toBe(false);
    }
  });

  it("图片输入保留共同判别字段，同时接受 URL 和文件 ID", () => {
    type UserInput = Extract<
      ThreadItemsListResponse["data"][number]["item"],
      { type: "userMessage" }
    >["content"][number];
    const images: Extract<UserInput, { type: "image" }>[] = [
      { type: "image", url: "https://example.com/image.png" },
      { type: "image", fileId: "file-example" },
    ];
    expectTypeOf(images[0]!.type).toEqualTypeOf<"image">();
    const page = {
      data: [{
        turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content: images },
      }],
      nextCursor: null,
    };
    expect(validateThreadItemsListResponse(page).ok).toBe(true);
    expect(validateThreadItemsListResponse({
      ...page,
      data: [{
        ...page.data[0],
        item: { ...page.data[0]!.item, content: [{ url: "https://example.com/image.png" }] },
      }],
    }).ok).toBe(false);
  });

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

  it("生成的 ClientRequest 联合包含两级历史分页方法", () => {
    const turnsRequest: Extract<ClientRequest, { method: "thread/turns/list" }> = {
      id: 1,
      method: "thread/turns/list",
      params: { threadId: "thread-1" },
    };
    const itemsRequest: Extract<ClientRequest, { method: "thread/items/list" }> = {
      id: 2,
      method: "thread/items/list",
      params: { threadId: "thread-1", turnId: "turn-1" },
    };

    expect(turnsRequest.method).toBe("thread/turns/list");
    expect(itemsRequest.method).toBe("thread/items/list");
  });

  it("不把 raw response 独立负载当作合法服务端通知", () => {
    for (const method of ["rawResponseItem/completed", "rawResponse/completed"]) {
      expect(
        validateServerNotification({
          method,
          params: { threadId: "thread-1", turnId: "turn-1" },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "unknown_method", stage: "method" },
      });
    }
  });

  it("接受当前通知 envelope、账户计划和模型输入模态", () => {
    expect(
      validateServerNotification({
        emittedAtMs: 1,
        method: "thread/environment/connected",
        params: { environmentId: "environment-1", threadId: "thread-1" },
      }).ok,
    ).toBe(true);
    expect(
      validateServerNotification({
        emittedAtMs: 2,
        method: "account/updated",
        params: { authMode: null, planType: "ent26" },
      }).ok,
    ).toBe(true);
    expect(
      validateModelListResponse({
        data: [{
          defaultReasoningEffort: "medium",
          description: "支持音频输入",
          displayName: "Codex",
          hidden: false,
          id: "codex",
          inputModalities: ["text", "audio"],
          isDefault: true,
          model: "codex",
          supportedReasoningEfforts: [],
        }],
        nextCursor: null,
      }).ok,
    ).toBe(true);
  });

  it("校验账户读取响应中的 ChatGPT 邮箱", () => {
    expect(validateGetAccountResponse({
      account: { email: "alice@example.com", planType: "plus", type: "chatgpt" },
      requiresOpenaiAuth: true,
    }).ok).toBe(true);
    expect(validateGetAccountResponse({
      account: { planType: "plus", type: "chatgpt" },
      requiresOpenaiAuth: true,
    }).ok).toBe(false);
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

  it("校验会话列表、读取、恢复及 turn 和 item 分页响应", () => {
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
      projectId: null,
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
    expect(
      validateThreadItemsListResponse({
        data: [{
          item: {
            aggregatedOutput: "完成",
            command: "git status --short",
            commandActions: [],
            cwd: "/workspace",
            id: "command-1",
            status: "completed",
            type: "commandExecution",
          },
          turnId: "turn-1",
        }],
        nextCursor: null,
      }).ok,
    ).toBe(true);

    const invalid = validateThreadListResponse({ data: "secret-value" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.summary).not.toContain("secret-value");
    }
  });

  describe("子 agent 完成记录", () => {
    const completedActivity = {
      agentPath: "/root/review",
      agentThreadId: "agent-thread-1",
      id: "activity-1",
      kind: "completed",
      type: "subAgentActivity",
    };

    it("接受包含普通记录和 completed 子 agent 记录的历史分页响应", () => {
      expect(validateThreadItemsListResponse({
        data: [
          {
            item: { id: "message-1", text: "检查完成", type: "agentMessage" },
            turnId: "turn-1",
          },
          { item: completedActivity, turnId: "turn-1" },
        ],
        nextCursor: "older-items",
      }).ok).toBe(true);
    });

    it.each([
      ["item/started", { startedAtMs: 100 }],
      ["item/completed", { completedAtMs: 100 }],
    ] as const)("接受 %s 通知中的 completed 子 agent 记录", (method, timestamp) => {
      expect(validateServerNotification({
        method,
        params: {
          ...timestamp,
          item: completedActivity,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }).ok).toBe(true);
    });

    it("仍拒绝非法的子 agent 活动类型", () => {
      const item = { ...completedActivity, kind: "invalid-kind" };
      expect(validateThreadItemsListResponse({
        data: [{ item, turnId: "turn-1" }],
        nextCursor: null,
      }).ok).toBe(false);
      expect(validateServerNotification({
        method: "item/completed",
        params: { completedAtMs: 100, item, threadId: "thread-1", turnId: "turn-1" },
      }).ok).toBe(false);
    });
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
