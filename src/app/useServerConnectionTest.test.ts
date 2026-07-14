import { describe, expect, it, vi } from "vitest";

import type {
  ServerEditorMode,
  ServerEditorSubmission,
} from "../components/serverEditorModel";
import type { ServerId, ServerProfile } from "../configuration";
import {
  ServerConnectionTestProbeError,
  type ServerConnectionTestProbe,
} from "../appServer";
import {
  ServerConnectionTestBridgeError,
  ServerConnectionTestCommandError,
} from "../transport/serverConnectionTest";
import {
  buildServerConnectionTestRequest,
  ServerConnectionTestController,
} from "./useServerConnectionTest";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;

const LOCAL_SUBMISSION = {
  name: "本机测试",
  configuration: {
    type: "localStdio",
    executablePath: "/usr/bin/codex",
    arguments: ["app-server"],
    nonSensitiveEnvironment: {},
  },
  credentialIntent: { type: "keep" },
} as const satisfies ServerEditorSubmission;

function storedProfile(): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "远程测试",
    version: 7,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app-server",
      authentication: "bearer",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 30_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialConfigured: true,
    activeWindowCount: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

interface DeferredProbe extends ServerConnectionTestProbe {
  readonly resolveRun: () => void;
  readonly rejectRun: (error: unknown) => void;
  readonly cancelMock: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function deferredProbe(
  cancel: () => Promise<void> = async () => undefined,
): DeferredProbe {
  let resolveRun: (() => void) | undefined;
  let rejectRun: ((error: unknown) => void) | undefined;
  const runPromise = new Promise<void>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  const cancelMock = vi.fn(cancel);
  return {
    run: vi.fn(() => runPromise),
    cancel: cancelMock,
    resolveRun: () => resolveRun?.(),
    rejectRun: (error) => rejectRun?.(error),
    cancelMock,
  };
}

describe("buildServerConnectionTestRequest", () => {
  it("将新建留空凭据映射为 none", () => {
    expect(
      buildServerConnectionTestRequest(
        { type: "create" },
        LOCAL_SUBMISSION,
        "test-1",
      ),
    ).toEqual({
      connectionId: "test-1",
      configuration: LOCAL_SUBMISSION.configuration,
      credentialSource: { type: "none" },
    });
  });

  it("将本次凭据映射为 provided 并将已保存凭据绑定版本", () => {
    const provided: ServerEditorSubmission = {
      ...LOCAL_SUBMISSION,
      credentialIntent: {
        type: "set",
        credential: {
          type: "sensitiveEnvironment",
          values: { API_TOKEN: "secret" },
        },
      },
    };
    expect(
      buildServerConnectionTestRequest({ type: "create" }, provided, "test-2")
        .credentialSource,
    ).toEqual({
      type: "provided",
      credential: {
        type: "sensitiveEnvironment",
        values: { API_TOKEN: "secret" },
      },
    });

    const mode: ServerEditorMode = { type: "edit", profile: storedProfile() };
    expect(
      buildServerConnectionTestRequest(
        mode,
        {
          name: mode.profile.name,
          configuration: mode.profile.configuration,
          credentialIntent: { type: "keep" },
        },
        "test-3",
      ).credentialSource,
    ).toEqual({
      type: "stored",
      serverId: SERVER_ID,
      expectedVersion: 7,
    });
  });

  it("将清除凭据映射为 none 并拒绝新建时清除", () => {
    const clearSubmission: ServerEditorSubmission = {
      ...LOCAL_SUBMISSION,
      credentialIntent: {
        type: "clear",
        credentialType: "sensitiveEnvironment",
      },
    };
    expect(
      buildServerConnectionTestRequest(
        { type: "edit", profile: storedProfile() },
        clearSubmission,
        "test-4",
      ).credentialSource,
    ).toEqual({ type: "none" });
    expect(() =>
      buildServerConnectionTestRequest(
        { type: "create" },
        clearSubmission,
        "test-5",
      ),
    ).toThrow(TypeError);
  });
});

describe("ServerConnectionTestController", () => {
  it("完成测试后只发布安全成功状态", async () => {
    const probe = deferredProbe();
    const requests: unknown[] = [];
    const controller = new ServerConnectionTestController({
      connectionIdFactory: () => "connection-1",
      probeFactory: (options) => {
        requests.push(options.request);
        return probe;
      },
    });

    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    expect(controller.getSnapshot()).toEqual({ type: "testing" });
    probe.resolveRun();
    await Promise.resolve();

    expect(controller.getSnapshot()).toEqual({
      type: "succeeded",
      message: "连接和 app-server 初始化成功",
    });
    expect(requests).toHaveLength(1);
  });

  it("取消测试时发布 cancelling 并在回收后清空状态", async () => {
    let finishCancel: (() => void) | undefined;
    const probe = deferredProbe(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const controller = new ServerConnectionTestController({
      probeFactory: () => probe,
      connectionIdFactory: () => "connection-2",
    });
    controller.test({ type: "create" }, LOCAL_SUBMISSION);

    const cancellation = controller.cancel();
    expect(controller.cancel()).toBe(cancellation);
    expect(controller.getSnapshot()).toEqual({ type: "cancelling" });
    finishCancel?.();
    await cancellation;

    expect(controller.getSnapshot()).toBeUndefined();
    expect(probe.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("隔离前一次迟到结果且不会泄露未知错误正文", async () => {
    const first = deferredProbe();
    const second = deferredProbe();
    const probes = [first, second];
    const controller = new ServerConnectionTestController({
      probeFactory: () => probes.shift()!,
      connectionIdFactory: () => "connection-next",
    });

    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    const cancellation = controller.cancel();
    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    expect(probes).toHaveLength(1);
    await cancellation;
    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    first.resolveRun();
    await Promise.resolve();
    expect(controller.getSnapshot()).toEqual({ type: "testing" });

    second.rejectRun(new Error("DO_NOT_REPORT backend secret"));
    await Promise.resolve();
    expect(controller.getSnapshot()).toEqual({
      type: "failed",
      message: "无法完成连接测试，请检查配置和连接路径",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "DO_NOT_REPORT",
    );
    expect(first.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("取消失败显示稳定错误且 StrictMode 式重新保留不会提前回收", async () => {
    const probe = deferredProbe(async () => {
      throw new Error("DO_NOT_REPORT cancel detail");
    });
    const controller = new ServerConnectionTestController({
      probeFactory: () => probe,
      connectionIdFactory: () => "connection-4",
    });
    const firstRelease = controller.retain();
    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    firstRelease();
    const finalRelease = controller.retain();
    await Promise.resolve();
    expect(probe.cancelMock).not.toHaveBeenCalled();

    await expect(controller.cancel()).rejects.toEqual(
      new ServerConnectionTestBridgeError("connectionCancellationFailed"),
    );
    expect(controller.getSnapshot()).toEqual({
      type: "cancelFailed",
      message: "无法确认测试连接已关闭，请关闭当前窗口后重试",
    });
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(
      "DO_NOT_REPORT",
    );

    probe.rejectRun(new Error("late run failure"));
    await Promise.resolve();
    expect(controller.getSnapshot()).toEqual({
      type: "cancelFailed",
      message: "无法确认测试连接已关闭，请关闭当前窗口后重试",
    });
    await expect(controller.cancel()).rejects.toEqual(
      new ServerConnectionTestBridgeError("connectionCancellationFailed"),
    );

    finalRelease();
    await Promise.resolve();
    expect(probe.cancelMock).toHaveBeenCalledTimes(3);
  });

  it("reset 与 dispose 复用清理屏障且清理期间不启动下一测试", async () => {
    let finishCancel: (() => void) | undefined;
    const first = deferredProbe(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        }),
    );
    const second = deferredProbe();
    const probes = [first, second];
    const controller = new ServerConnectionTestController({
      probeFactory: () => probes.shift()!,
      connectionIdFactory: () => "connection-barrier",
    });
    controller.test({ type: "create" }, LOCAL_SUBMISSION);

    const cancellation = controller.cancel();
    expect(controller.reset()).toBe(cancellation);
    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    expect(probes).toHaveLength(1);

    let disposed = false;
    const disposal = controller.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    finishCancel?.();
    await Promise.all([cancellation, disposal]);
    expect(disposed).toBe(true);
    expect(first.cancelMock).toHaveBeenCalledTimes(1);
  });

  it("保留经过脱敏的连接命令错误以提供可操作提示", async () => {
    const probe = deferredProbe();
    const controller = new ServerConnectionTestController({
      probeFactory: () => probe,
      connectionIdFactory: () => "connection-actionable",
    });
    controller.test({ type: "create" }, LOCAL_SUBMISSION);

    probe.rejectRun(new ServerConnectionTestCommandError("proxyNotFound"));
    await Promise.resolve();

    expect(controller.getSnapshot()).toEqual({
      type: "failed",
      message: "所选代理已不存在，请重新选择连接路径",
    });
  });

  it("将未知 SSH 主机密钥保留为可确认的结构化提示", async () => {
    const probe = deferredProbe();
    const controller = new ServerConnectionTestController({
      probeFactory: () => probe,
      connectionIdFactory: () => "connection-host-key",
    });
    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    const fingerprint = `SHA256:${"A".repeat(43)}`;
    probe.rejectRun(new ServerConnectionTestCommandError("sshHostKeyUnknown", {
      details: {
        kind: "sshHostKeyUnknown",
        host: "ssh.example.test",
        port: 22,
        received: { algorithm: "ssh-ed25519", sha256Fingerprint: fingerprint },
      },
    }));
    await Promise.resolve();

    expect(controller.getSnapshot()).toEqual({
      type: "failed",
      message: "SSH 代理主机密钥需要在代理配置中确认",
      sshHostKeyPrompt: {
        kind: "unknown",
        host: "ssh.example.test",
        port: 22,
        algorithm: "ssh-ed25519",
        sha256Fingerprint: fingerprint,
      },
    });
  });

  it("自动测试无法确认关闭时保持终止锁定且禁止下一次测试", async () => {
    const first = deferredProbe();
    const second = deferredProbe();
    const probes = [first, second];
    const controller = new ServerConnectionTestController({
      probeFactory: () => probes.shift()!,
      connectionIdFactory: () => "connection-cleanup-failed",
    });
    controller.test({ type: "create" }, LOCAL_SUBMISSION);

    first.rejectRun(new ServerConnectionTestProbeError());
    await Promise.resolve();

    expect(controller.getSnapshot()).toEqual({
      type: "cancelFailed",
      message: "无法确认测试连接已关闭，请关闭当前窗口后重试",
    });
    controller.test({ type: "create" }, LOCAL_SUBMISSION);
    expect(probes).toHaveLength(1);
  });
});
