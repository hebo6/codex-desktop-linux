import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServerEditorSubmission } from "../components/serverEditorModel";
import type { CredentialStorageStatus } from "../configuration";
import {
  usePlaintextCredentialConfirmation,
  type PendingPlaintextCredentialConfirmation,
} from "./usePlaintextCredentialConfirmation";

function submission(
  credentialIntent: ServerEditorSubmission["credentialIntent"],
): ServerEditorSubmission {
  return {
    name: "远程开发",
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app-server",
      authentication: "bearer",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 30_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialIntent,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("usePlaintextCredentialConfirmation", () => {
  it("明文存储要求确认并在确认后返回原提交", async () => {
    const storageStatus = deferred<CredentialStorageStatus>();
    const loadStorageStatus = vi.fn(() => storageStatus.promise);
    const pending = {
      kind: "server",
      submission: submission({
        type: "set",
        credential: { type: "bearerToken", value: "plain-secret" },
      }),
    } as const;
    const { result } = renderHook(() =>
      usePlaintextCredentialConfirmation(loadStorageStatus)
    );

    let preparation!: Promise<boolean>;
    act(() => {
      preparation = result.current.prepare(pending);
    });
    expect(result.current.checking).toBe(true);
    expect(result.current.pending).toBeNull();

    let shouldContinue!: boolean;
    await act(async () => {
      storageStatus.resolve({ backend: "plaintextFile" });
      shouldContinue = await preparation;
    });
    expect(shouldContinue).toBe(false);
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.pending).toBe(pending);

    let confirmed: PendingPlaintextCredentialConfirmation | null = null;
    act(() => {
      confirmed = result.current.confirm();
    });
    expect(confirmed).toBe(pending);
    expect(result.current.pending).toBeNull();
  });

  it("安全存储或无需设置凭据时直接继续保存", async () => {
    const loadStorageStatus = vi.fn(async () => ({
      backend: "secretService" as const,
    }));
    const { result } = renderHook(() =>
      usePlaintextCredentialConfirmation(loadStorageStatus)
    );
    const withCredential = {
      kind: "server",
      submission: submission({
        type: "set",
        credential: { type: "bearerToken", value: "secret" },
      }),
    } as const;
    const withoutCredential = {
      kind: "server",
      submission: submission({ type: "keep" }),
    } as const;

    let withCredentialContinues!: boolean;
    let withoutCredentialContinues!: boolean;
    await act(async () => {
      withCredentialContinues = await result.current.prepare(withCredential);
      withoutCredentialContinues = await result.current.prepare(withoutCredential);
    });
    expect(withCredentialContinues).toBe(true);
    expect(withoutCredentialContinues).toBe(true);
    expect(loadStorageStatus).toHaveBeenCalledOnce();
    expect(result.current.pending).toBeNull();
  });

  it("支持写入边界补充请求确认并按编辑器类型清除", () => {
    const serverPending = {
      kind: "server",
      submission: submission({ type: "keep" }),
    } as const;
    const { result } = renderHook(() =>
      usePlaintextCredentialConfirmation(async () => ({
        backend: "secretService",
      }))
    );

    act(() => result.current.request(serverPending));
    act(() => result.current.clear("proxy"));
    expect(result.current.pending).toBe(serverPending);

    act(() => result.current.clear("server"));
    expect(result.current.pending).toBeNull();
  });
});
