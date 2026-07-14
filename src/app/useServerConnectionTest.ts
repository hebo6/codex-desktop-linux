import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  AppServerSessionError,
  createServerConnectionTestProbe,
  ServerConnectionTestProbeError,
  type ServerConnectionTestProbe,
} from "../appServer";
import type {
  ServerEditorMode,
  ServerEditorSubmission,
  ServerEditorTestState,
  SshHostKeyPrompt,
} from "../components/serverEditorModel";
import {
  ServerConnectionTestBridgeError,
  ServerConnectionTestCommandError,
  type ConnectServerConnectionTestRequest,
  type ProxyConnectionTestInput,
  type ServerConnectionTestCredentialSource,
} from "../transport/serverConnectionTest";

const TESTING_STATE = Object.freeze({
  type: "testing",
}) satisfies ServerEditorTestState;
const CANCELLING_STATE = Object.freeze({
  type: "cancelling",
}) satisfies ServerEditorTestState;
const SUCCEEDED_STATE = Object.freeze({
  type: "succeeded",
  message: "连接和 app-server 初始化成功",
}) satisfies ServerEditorTestState;
const UNKNOWN_FAILURE = "无法完成连接测试，请检查配置和连接路径";
const CANCEL_FAILURE = "无法确认测试连接已关闭，请关闭当前窗口后重试";

export interface ServerConnectionTestProbeFactoryOptions {
  readonly request: ConnectServerConnectionTestRequest;
}

export type ServerConnectionTestProbeFactory = (
  options: ServerConnectionTestProbeFactoryOptions,
) => ServerConnectionTestProbe;

export type ServerConnectionTestIdFactory = () => string;

export interface ServerConnectionTestControllerOptions {
  readonly probeFactory?: ServerConnectionTestProbeFactory;
  readonly connectionIdFactory?: ServerConnectionTestIdFactory;
}

export interface ServerConnectionTestControls {
  readonly state: ServerEditorTestState | undefined;
  readonly test: (
    mode: ServerEditorMode,
    submission: ServerEditorSubmission,
    proxy?: ProxyConnectionTestInput,
  ) => void;
  readonly cancel: () => Promise<void>;
  readonly reset: () => Promise<void>;
}

interface ActiveTestAttempt {
  readonly generation: number;
  readonly probe: ServerConnectionTestProbe;
}

const DEFAULT_OPTIONS: ServerConnectionTestControllerOptions = Object.freeze(
  {},
);

export class ServerConnectionTestController {
  private readonly probeFactory: ServerConnectionTestProbeFactory;
  private readonly connectionIdFactory: ServerConnectionTestIdFactory;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: ServerEditorTestState | undefined;
  private activeAttempt: ActiveTestAttempt | null = null;
  private cancellationPromise: Promise<void> | null = null;
  private generation = 0;
  private retainCount = 0;
  private releaseVersion = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: ServerConnectionTestControllerOptions = {}) {
    this.probeFactory =
      options.probeFactory ??
      (({ request }) => createServerConnectionTestProbe({ request }));
    this.connectionIdFactory =
      options.connectionIdFactory ?? (() => `test-${crypto.randomUUID()}`);
  }

  readonly getSnapshot = (): ServerEditorTestState | undefined =>
    this.snapshotValue;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly test = (
    mode: ServerEditorMode,
    submission: ServerEditorSubmission,
    proxy?: ProxyConnectionTestInput,
  ): void => {
    if (
      this.disposed ||
      this.activeAttempt !== null ||
      this.cancellationPromise !== null
    ) {
      return;
    }
    const generation = ++this.generation;
    this.updateSnapshot(TESTING_STATE);

    let probe: ServerConnectionTestProbe;
    try {
      const request = buildServerConnectionTestRequest(
        mode,
        submission,
        this.connectionIdFactory(),
        proxy,
      );
      probe = this.probeFactory({ request });
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.updateSnapshot(failedState(error));
      }
      return;
    }

    const attempt = { generation, probe };
    this.activeAttempt = attempt;
    let run: Promise<void>;
    try {
      run = probe.run();
    } catch (error) {
      this.finishAttempt(attempt, error);
      return;
    }
    void run.then(
      () => this.finishAttempt(attempt),
      (error: unknown) => this.finishAttempt(attempt, error),
    );
  };

  readonly cancel = (): Promise<void> => {
    if (this.disposed) {
      return this.disposePromise ?? Promise.resolve();
    }
    if (this.cancellationPromise !== null) {
      return this.cancellationPromise;
    }
    const generation = ++this.generation;
    const attempt = this.activeAttempt;
    if (attempt === null) {
      this.updateSnapshot(undefined);
      return Promise.resolve();
    }
    this.updateSnapshot(CANCELLING_STATE);
    const cancellation = cancelProbe(attempt.probe).then(
      () => {
        if (this.activeAttempt === attempt) {
          this.activeAttempt = null;
        }
        if (!this.disposed && generation === this.generation) {
          this.updateSnapshot(undefined);
        }
      },
      () => {
        if (!this.disposed && generation === this.generation) {
          this.updateSnapshot(cancellationFailedState());
        }
        throw new ServerConnectionTestBridgeError(
          "connectionCancellationFailed",
        );
      },
    );
    const trackedCancellation = cancellation.finally(() => {
      if (this.cancellationPromise === trackedCancellation) {
        this.cancellationPromise = null;
      }
    });
    this.cancellationPromise = trackedCancellation;
    return trackedCancellation;
  };

  readonly reset = (): Promise<void> => {
    if (this.disposed) {
      return this.disposePromise ?? Promise.resolve();
    }
    return this.cancel();
  };

  retain(): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.retainCount += 1;
    this.releaseVersion += 1;
    let released = false;
    return () => {
      if (released || this.disposed) {
        return;
      }
      released = true;
      this.retainCount -= 1;
      const releaseVersion = ++this.releaseVersion;
      queueMicrotask(() => {
        if (
          !this.disposed &&
          this.retainCount === 0 &&
          releaseVersion === this.releaseVersion
        ) {
          void this.dispose();
        }
      });
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.generation += 1;
    this.listeners.clear();
    const attempt = this.detachActiveAttempt();
    const cleanup =
      this.cancellationPromise ??
      (attempt === null ? Promise.resolve() : cancelProbe(attempt.probe));
    this.disposePromise = cleanup.catch(() => undefined);
    return this.disposePromise;
  }

  private detachActiveAttempt(): ActiveTestAttempt | null {
    const attempt = this.activeAttempt;
    this.activeAttempt = null;
    return attempt;
  }

  private finishAttempt(attempt: ActiveTestAttempt, error?: unknown): void {
    if (this.activeAttempt !== attempt) {
      return;
    }
    if (this.disposed || attempt.generation !== this.generation) {
      return;
    }
    if (cleanupIsUnconfirmed(error)) {
      this.generation += 1;
      this.updateSnapshot(cancellationFailedState());
      return;
    }
    this.activeAttempt = null;
    this.updateSnapshot(
      error === undefined
        ? SUCCEEDED_STATE
        : failedState(error),
    );
  }

  private updateSnapshot(next: ServerEditorTestState | undefined): void {
    if (sameTestState(this.snapshotValue, next)) {
      return;
    }
    this.snapshotValue = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function useServerConnectionTest(
  options: ServerConnectionTestControllerOptions = DEFAULT_OPTIONS,
): ServerConnectionTestControls {
  const [controller] = useState(
    () => new ServerConnectionTestController(options),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => controller.retain(), [controller]);

  return useMemo(
    () => ({
      state,
      test: controller.test,
      cancel: controller.cancel,
      reset: controller.reset,
    }),
    [controller, state],
  );
}

export function buildServerConnectionTestRequest(
  mode: ServerEditorMode,
  submission: ServerEditorSubmission,
  connectionId: string,
  proxy?: ProxyConnectionTestInput,
): ConnectServerConnectionTestRequest {
  if (mode.type === "create" && submission.credentialIntent.type === "clear") {
    throw new TypeError("a new server cannot clear a stored credential");
  }
  let credentialSource: ServerConnectionTestCredentialSource;
  switch (submission.credentialIntent.type) {
    case "set":
      credentialSource = {
        type: "provided",
        credential: submission.credentialIntent.credential,
      };
      break;
    case "clear":
      credentialSource = { type: "none" };
      break;
    case "keep":
      credentialSource =
        mode.type === "edit" && mode.profile.credentialConfigured
          ? {
              type: "stored",
              serverId: mode.profile.serverId,
              expectedVersion: mode.profile.version,
            }
          : { type: "none" };
      break;
  }
  return {
    connectionId,
    configuration: submission.configuration,
    credentialSource,
    ...(proxy === undefined ? {} : { proxy }),
  };
}

function cancelProbe(probe: ServerConnectionTestProbe): Promise<void> {
  try {
    return Promise.resolve(probe.cancel());
  } catch (error) {
    return Promise.reject(error);
  }
}

function failedState(error: unknown): ServerEditorTestState {
  const prompt = sshHostKeyPrompt(error);
  return Object.freeze({
    type: "failed",
    message: testFailureSummary(error),
    ...(prompt === undefined ? {} : { sshHostKeyPrompt: prompt }),
  });
}

function cancellationFailedState(): ServerEditorTestState {
  return Object.freeze({ type: "cancelFailed", message: CANCEL_FAILURE });
}

function sameTestState(
  left: ServerEditorTestState | undefined,
  right: ServerEditorTestState | undefined,
): boolean {
  return (
    left === right ||
    ((left?.type === "failed" || left?.type === "cancelFailed") &&
      left.type === right?.type &&
      left.message === right.message &&
      JSON.stringify(left.type === "failed" ? left.sshHostKeyPrompt : undefined) ===
        JSON.stringify(right.type === "failed" ? right.sshHostKeyPrompt : undefined))
  );
}

function sshHostKeyPrompt(error: unknown): SshHostKeyPrompt | undefined {
  if (!(error instanceof ServerConnectionTestCommandError) || error.details === undefined) {
    return undefined;
  }
  const details = error.details;
  if (details.kind === "sshHostKeyUnknown") {
    return {
      kind: "unknown",
      host: details.host,
      port: details.port,
      algorithm: details.received.algorithm,
      sha256Fingerprint: details.received.sha256Fingerprint,
    };
  }
  return {
    kind: "changed",
    host: details.host,
    port: details.port,
    algorithm: details.received.algorithm,
    sha256Fingerprint: details.received.sha256Fingerprint,
    expectedAlgorithm: details.expected.algorithm,
    expectedSha256Fingerprint: details.expected.sha256Fingerprint,
  };
}

function testFailureSummary(error: unknown): string {
  if (error instanceof ServerConnectionTestProbeError) {
    return "测试连接已完成，但无法确认连接已关闭";
  }
  if (error instanceof ServerConnectionTestBridgeError) {
    return error.code === "connectionCancellationFailed"
      ? CANCEL_FAILURE
      : UNKNOWN_FAILURE;
  }
  if (error instanceof ServerConnectionTestCommandError) {
    if (error.code === "serverVersionConflict") {
      return "服务器配置已被其他窗口修改，请重新打开编辑器";
    }
    if (error.code === "proxyNotFound") {
      return "所选代理已不存在，请重新选择连接路径";
    }
    if (
      error.code === "credentialNotConfigured" ||
      error.code === "credentialNotFound" ||
      error.code === "credentialConfigurationMismatch" ||
      error.code === "credentialRecordInvalid"
    ) {
      return "测试凭据不可用，请重新填写或保存凭据";
    }
    if (
      error.code === "sshHostKeyUnknown" ||
      error.code === "sshHostKeyChanged"
    ) {
      return "SSH 代理主机密钥需要在代理配置中确认";
    }
    return UNKNOWN_FAILURE;
  }
  if (error instanceof AppServerSessionError) {
    if (
      error.code === "initializationRejected" ||
      error.code === "invalidInitializationResponse" ||
      error.code === "initializationWriteFailed" ||
      error.code === "initializationInterrupted" ||
      error.code === "initializationFailed"
    ) {
      return "已建立连接，但 app-server 初始化失败";
    }
    if (error.code === "transportConnectCancelFailed") {
      return CANCEL_FAILURE;
    }
  }
  return UNKNOWN_FAILURE;
}

function cleanupIsUnconfirmed(error: unknown): boolean {
  return (
    error instanceof ServerConnectionTestProbeError ||
    (error instanceof ServerConnectionTestBridgeError &&
      error.code === "connectionCancellationFailed") ||
    (error instanceof AppServerSessionError &&
      error.code === "transportConnectCancelFailed")
  );
}
