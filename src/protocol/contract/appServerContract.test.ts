import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";

import clientRequestSchema from "../../../protocol/schema/ClientRequest.json";
import {
  APP_SERVER_SCHEMA_COMMIT,
  KNOWN_SERVER_REQUEST_METHODS,
  type InitializeParams,
  type JSONRPCMessage,
} from "../generated";
import {
  RpcRouter,
  schemaProtocolBoundary,
  type RpcWriter,
} from "../rpc";
import {
  validateFuzzyFileSearchResponse,
  validateGetAccountRateLimitsResponse,
  validateInitializeResponse,
  validateServerNotification,
  validateServerRequest,
  validateSkillsListResponse,
  validateThreadListResponse,
  validateThreadTurnsListResponse,
  validateTurnStartResponse,
} from "../validation";
import recordingJson from "./fixtures/reference-sequence.json";

type JsonRecord = Record<string, unknown>;

interface RecordedClientRequest {
  readonly area: string;
  readonly message: unknown;
}

interface RecordedServerResult {
  readonly area: string;
  readonly method: string;
  readonly result: unknown;
}

interface ContractRecording {
  readonly schemaCommit: string;
  readonly recordingSource: string;
  readonly deidentified: boolean;
  readonly clientRequests: readonly RecordedClientRequest[];
  readonly serverResults: readonly RecordedServerResult[];
  readonly serverNotifications: readonly {
    readonly area: string;
    readonly message: unknown;
  }[];
  readonly serverRequests: readonly unknown[];
}

const recording = recordingJson as ContractRecording;
const clientRequestValidator = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false,
}).compile(clientRequestSchema);

const resultValidators = {
  initialize: validateInitializeResponse,
  "thread/list": validateThreadListResponse,
  "thread/turns/list": validateThreadTurnsListResponse,
  "turn/start": validateTurnStartResponse,
  "skills/list": validateSkillsListResponse,
  fuzzyFileSearch: validateFuzzyFileSearchResponse,
  "account/rateLimits/read": validateGetAccountRateLimitsResponse,
} satisfies Record<
  string,
  (value: unknown) => { readonly ok: boolean }
>;

class RecordingWriter implements RpcWriter {
  readonly messages: JSONRPCMessage[] = [];

  async write(message: JSONRPCMessage): Promise<void> {
    this.messages.push(message);
  }
}

function recordOf(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a record");
  }
  return value as JsonRecord;
}

function initializationParams(): InitializeParams {
  const initialize = recording.clientRequests.find(
    ({ message }) => recordOf(message).method === "initialize",
  );
  if (initialize === undefined) throw new TypeError("initialize request missing");
  return recordOf(initialize.message).params as InitializeParams;
}

function initializationResult(): unknown {
  const initialize = recording.serverResults.find(
    ({ method }) => method === "initialize",
  );
  if (initialize === undefined) throw new TypeError("initialize result missing");
  return initialize.result;
}

describe("脱敏 app-server 协议契约", () => {
  it("将完整实验版客户端请求固定到参考提交并声明 experimentalApi", () => {
    expect(recording).toMatchObject({
      schemaCommit: APP_SERVER_SCHEMA_COMMIT,
      recordingSource: "controlled-app-server",
      deidentified: true,
    });
    for (const { message } of recording.clientRequests) {
      expect(clientRequestValidator(message), JSON.stringify(clientRequestValidator.errors)).toBe(
        true,
      );
    }

    const initialize = recordOf(
      recording.clientRequests.find(
        ({ message }) => recordOf(message).method === "initialize",
      )?.message,
    );
    expect(recordOf(recordOf(initialize.params).capabilities).experimentalApi).toBe(
      true,
    );
    expect(
      recording.clientRequests.some(
        ({ message }) => recordOf(message).method === "thread/turns/list",
      ),
    ).toBe(true);
  });

  it("回放初始化、thread、turn、技能、文件搜索和限额结果与通知", () => {
    const coveredAreas = new Set<string>();
    for (const entry of recording.serverResults) {
      const validator = resultValidators[
        entry.method as keyof typeof resultValidators
      ];
      expect(validator, `missing validator for ${entry.method}`).toBeTypeOf(
        "function",
      );
      expect(validator(entry.result).ok, entry.method).toBe(true);
      coveredAreas.add(entry.area);
    }
    for (const entry of recording.serverNotifications) {
      expect(validateServerNotification(entry.message).ok, entry.area).toBe(true);
      coveredAreas.add(entry.area);
    }
    expect(coveredAreas).toEqual(
      new Set([
        "initialization",
        "thread",
        "turn",
        "skills",
        "fileSearch",
        "rateLimits",
      ]),
    );
  });

  it("覆盖全部服务端请求方法且每个请求都得到成功或明确错误响应", async () => {
    const requestMethods = new Set<string>();
    for (const message of recording.serverRequests) {
      const validation = validateServerRequest(message);
      expect(validation.ok, JSON.stringify(validation)).toBe(true);
      requestMethods.add(String(recordOf(message).method));
    }
    expect(requestMethods).toEqual(new Set(KNOWN_SERVER_REQUEST_METHODS));

    const writer = new RecordingWriter();
    const router = new RpcRouter({
      boundary: schemaProtocolBoundary,
      queueCapacity: 1,
    });
    const epoch = router.open(writer);
    const initialization = router.initialize(initializationParams());
    await vi.waitFor(() => expect(writer.messages).toHaveLength(1));
    const initializeId = recordOf(writer.messages[0]).id;
    await router.handleIncoming(epoch, {
      id: initializeId,
      result: initializationResult(),
    });
    await initialization;

    const releases = KNOWN_SERVER_REQUEST_METHODS.map((method) =>
      router.registerServerRequestHandler(method, () => ({ accepted: true })),
    );
    for (const message of recording.serverRequests) {
      await router.handleIncoming(epoch, message);
    }
    await router.handleIncoming(epoch, {
      id: "server-unknown",
      method: "future/request",
      params: {},
    });
    await router.handleIncoming(epoch, {
      id: "server-invalid",
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "patch-redacted",
        threadId: "thread-redacted",
        turnId: "turn-redacted",
      },
    });

    const responses = new Map(
      writer.messages
        .map((message) => recordOf(message))
        .filter((message) =>
          typeof message.id === "string" && message.id.startsWith("server-"),
        )
        .map((message) => [message.id as string, message]),
    );
    for (const message of recording.serverRequests) {
      const id = String(recordOf(message).id);
      expect(responses.get(id)).toMatchObject({ id, result: { accepted: true } });
    }
    expect(responses.get("server-unknown")).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    });
    expect(responses.get("server-invalid")).toMatchObject({
      error: { code: -32602, message: "Invalid params" },
    });
    for (const release of releases) release();
    router.close(epoch);
  });

  it("协议升级出现新增必填字段或新增 ThreadItem 类型时立即失败", () => {
    const initialize = structuredClone(
      recording.clientRequests.find(
        ({ message }) => recordOf(message).method === "initialize",
      )?.message,
    );
    delete recordOf(recordOf(initialize).params).clientInfo;
    expect(clientRequestValidator(initialize)).toBe(false);

    const itemNotification = structuredClone(
      recording.serverNotifications.find(
        ({ message }) => recordOf(message).method === "item/completed",
      )?.message,
    );
    recordOf(recordOf(itemNotification).params).item = {
      id: "future-item",
      type: "futureRequiredItem",
    };
    expect(validateServerNotification(itemNotification)).toMatchObject({
      ok: false,
      error: { code: "invalid_params" },
    });
  });
});
