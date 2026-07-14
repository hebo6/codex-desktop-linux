import { describe, expect, it, vi } from "vitest";

import type { JSONRPCMessage } from "../protocol/generated";
import type {
  ProtocolTransport,
  ProtocolTransportEventHandlers,
} from "../transport";
import type {
  ConnectServerConnectionTestRequest,
  ServerConnectionTestTransportConnector,
} from "../transport/serverConnectionTest";
import {
  ServerConnectionTestBridgeError,
  ServerConnectionTestCommandError,
} from "../transport/serverConnectionTest";
import {
  createServerConnectionTestProbe,
  ServerConnectionTestProbeError,
} from "./serverConnectionTestProbe";

const REQUEST = {
  connectionId: "test-connection-1",
  configuration: {
    type: "localStdio",
    executablePath: "/usr/bin/codex",
    arguments: ["app-server"],
    nonSensitiveEnvironment: {},
  },
  credentialSource: { type: "none" },
} as const satisfies ConnectServerConnectionTestRequest;

const INITIALIZE_RESPONSE = {
  codexHome: "/home/user/.codex",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "codex-probe-test",
} as const;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("expected a record");
  }
  return value as Record<string, unknown>;
}

class ProbeTransport implements ProtocolTransport {
  readonly messages: JSONRPCMessage[] = [];
  closeCalls = 0;
  closeError: Error | null = null;
  initializeFailure = false;
  handlers: ProtocolTransportEventHandlers | null = null;

  async write(message: JSONRPCMessage): Promise<void> {
    this.messages.push(message);
    const value = record(message);
    if (value.method === "initialize") {
      this.handlers?.onProtocolMessage(
        JSON.stringify(
          this.initializeFailure
            ? {
                id: value.id,
                error: { code: -32_000, message: "DO_NOT_REPORT" },
              }
            : { id: value.id, result: INITIALIZE_RESPONSE },
        ),
      );
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== null) {
      throw this.closeError;
    }
  }
}

function connectorFor(
  transport: ProbeTransport,
): ServerConnectionTestTransportConnector {
  const connector = async (handlers: ProtocolTransportEventHandlers) => {
    transport.handlers = handlers;
    return transport;
  };
  return Object.assign(connector, {
    cancelPending: vi.fn(async () => undefined),
  });
}

describe("createServerConnectionTestProbe", () => {
  it("只完成初始化握手并在关闭传输后报告成功", async () => {
    const transport = new ProbeTransport();
    const connector = connectorFor(transport);
    const probe = createServerConnectionTestProbe({
      request: REQUEST,
      connectorFactory: () => connector,
    });

    const firstRun = probe.run();
    expect(probe.run()).toBe(firstRun);
    await expect(firstRun).resolves.toBeUndefined();

    expect(transport.messages.map((message) => record(message).method)).toEqual(
      ["initialize", "initialized"],
    );
    expect(JSON.stringify(transport.messages)).not.toContain("thread/");
    expect(transport.closeCalls).toBe(1);
    await expect(probe.cancel()).resolves.toBeUndefined();
    expect(transport.closeCalls).toBe(1);
  });

  it("测试进行中取消会复用同一关闭流程", async () => {
    const transport = new ProbeTransport();
    let releaseConnect: (() => void) | undefined;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const cancelPending = vi.fn(async () => {
      releaseConnect?.();
    });
    const connector = Object.assign(
      async (handlers: ProtocolTransportEventHandlers) => {
        await connectGate;
        transport.handlers = handlers;
        return transport;
      },
      { cancelPending },
    );
    const probe = createServerConnectionTestProbe({
      request: REQUEST,
      connectorFactory: () => connector,
    });
    const runOutcome = probe.run().catch((error: unknown) => error);
    await Promise.resolve();

    const firstCancel = probe.cancel();
    expect(probe.cancel()).toBe(firstCancel);
    await expect(firstCancel).resolves.toBeUndefined();
    await expect(runOutcome).resolves.toMatchObject({ code: "sessionClosed" });
    expect(cancelPending).toHaveBeenCalledTimes(1);
    expect(transport.closeCalls).toBe(1);
  });

  it("取消成功响应竞态的清理失败会穿透会话关闭边界", async () => {
    let releaseConnect: (() => void) | undefined;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const cleanupError = new ServerConnectionTestBridgeError(
      "connectionCancellationFailed",
    );
    const connector = Object.assign(
      async () => {
        await connectGate;
        throw cleanupError;
      },
      {
        cancelPending: vi.fn(async () => {
          releaseConnect?.();
        }),
      },
    );
    const probe = createServerConnectionTestProbe({
      request: REQUEST,
      connectorFactory: () => connector,
    });
    const runOutcome = probe.run().catch((error: unknown) => error);
    await Promise.resolve();

    await expect(probe.cancel()).rejects.toBe(cleanupError);
    await expect(runOutcome).resolves.toBe(cleanupError);
  });

  it("关闭失败时不把原始错误误报为测试成功", async () => {
    const transport = new ProbeTransport();
    transport.closeError = new Error("DO_NOT_REPORT close detail");
    const probe = createServerConnectionTestProbe({
      request: REQUEST,
      connectorFactory: () => connectorFor(transport),
    });

    const error = await probe.run().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ServerConnectionTestProbeError);
    expect(String(error)).not.toContain("DO_NOT_REPORT");
    expect(transport.closeCalls).toBe(1);
  });

  it("连接阶段保留经过脱敏的后端错误码", async () => {
    const commandError = new ServerConnectionTestCommandError(
      "serverVersionConflict",
    );
    const connector = Object.assign(
      async () => {
        throw commandError;
      },
      { cancelPending: vi.fn(async () => undefined) },
    );
    const probe = createServerConnectionTestProbe({
      request: REQUEST,
      connectorFactory: () => connector,
    });

    await expect(probe.run()).rejects.toBe(commandError);
    expect(connector.cancelPending).toHaveBeenCalledTimes(1);
  });

  it("初始化和关闭同时失败时优先报告无法确认关闭", async () => {
    const transport = new ProbeTransport();
    transport.initializeFailure = true;
    transport.closeError = new Error("DO_NOT_REPORT close detail");
    const probe = createServerConnectionTestProbe({
      request: REQUEST,
      connectorFactory: () => connectorFor(transport),
    });

    const error = await probe.run().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(ServerConnectionTestProbeError);
    expect(String(error)).not.toContain("DO_NOT_REPORT");
    expect(transport.closeCalls).toBe(1);
  });
});
