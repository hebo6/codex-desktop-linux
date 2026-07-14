import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import type { ConfigurationSnapshot, ServerId } from "../configuration";
import {
  configurationReducer,
  serverProfileUpserted,
} from "../store/configurationSlice";
import {
  CONFIGURATION_PROFILES_LOAD_ERROR_SUMMARY,
  useConfigurationProfiles,
} from "./useConfigurationProfiles";

const FIRST_SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const SECOND_SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function configurationSnapshot(
  serverId: ServerId,
  name: string,
): ConfigurationSnapshot {
  return {
    servers: [
      {
        serverId,
        name,
        version: 1,
        configuration: {
          type: "localStdio",
          executablePath: "/usr/bin/codex",
          arguments: ["app-server"],
          nonSensitiveEnvironment: {},
        },
        credentialConfigured: false,
        activeWindowCount: 0,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ],
    proxies: [],
  };
}

function createTestHarness() {
  const testStore = configureStore({
    reducer: { configuration: configurationReducer },
  });
  const Wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={testStore}>{children}</Provider>
  );
  return { testStore, Wrapper };
}

describe("useConfigurationProfiles", () => {
  it("收到其他窗口配置变更事件后重新读取权威快照", async () => {
    let notifyChange: (() => void) | undefined;
    const subscribe = vi.fn(async (handler: () => void) => {
      notifyChange = handler;
      return () => { notifyChange = undefined; };
    });
    const loader = vi.fn()
      .mockResolvedValueOnce(configurationSnapshot(FIRST_SERVER_ID, "本机"))
      .mockResolvedValueOnce(configurationSnapshot(SECOND_SERVER_ID, "远程"));
    const { Wrapper, testStore } = createTestHarness();
    renderHook(() => useConfigurationProfiles(loader, true, subscribe), { wrapper: Wrapper });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));

    act(() => notifyChange?.());
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(testStore.getState().configuration.serverIds).toEqual([SECOND_SERVER_ID]));
  });

  it("禁用时不读取配置，启用后才开始首载", async () => {
    const loader = vi.fn(async () =>
      configurationSnapshot(FIRST_SERVER_ID, "本机"),
    );
    const { Wrapper } = createTestHarness();
    const { result, rerender } = renderHook(
      ({ enabled }) => useConfigurationProfiles(loader, enabled),
      { initialProps: { enabled: false }, wrapper: Wrapper },
    );

    expect(result.current.status).toBe("idle");
    expect(loader).not.toHaveBeenCalled();
    act(() => result.current.reload());
    expect(loader).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("修改期间禁用后不重新加载且回到空闲状态", async () => {
    const mutation = createDeferred<string>();
    const loader = vi.fn(async () =>
      configurationSnapshot(FIRST_SERVER_ID, "本机"),
    );
    const { Wrapper } = createTestHarness();
    const { result, rerender } = renderHook(
      ({ enabled }) => useConfigurationProfiles(loader, enabled),
      { initialProps: { enabled: true }, wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let mutationResult!: Promise<string>;
    act(() => {
      mutationResult = result.current.runMutation(() => mutation.promise);
    });
    expect(result.current.status).toBe("loading");
    rerender({ enabled: false });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      mutation.resolve("done");
      await expect(mutationResult).resolves.toBe("done");
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("idle");
  });

  it("禁用状态执行修改时不进入无法结束的加载状态", async () => {
    const loader = vi.fn(async () =>
      configurationSnapshot(FIRST_SERVER_ID, "本机"),
    );
    const mutation = vi.fn(async () => "done");
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(
      () => useConfigurationProfiles(loader, false),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await expect(result.current.runMutation(mutation)).resolves.toBe("done");
    });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("自动加载配置快照并写入 store", async () => {
    const pending = createDeferred<ConfigurationSnapshot>();
    const loader = vi.fn(() => pending.promise);
    const { testStore, Wrapper } = createTestHarness();
    const { result } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
    });

    expect(result.current).toMatchObject({
      status: "loading",
      error: null,
    });
    expect(loader).toHaveBeenCalledTimes(1);

    const snapshot = configurationSnapshot(FIRST_SERVER_ID, "本机");
    await act(async () => {
      pending.resolve(snapshot);
      await pending.promise;
    });

    expect(result.current).toMatchObject({ status: "ready", error: null });
    expect(
      testStore.getState().configuration.serversById[FIRST_SERVER_ID],
    ).toEqual(snapshot.servers[0]);
  });

  it("重载后只接受最新请求的结果", async () => {
    const firstRequest = createDeferred<ConfigurationSnapshot>();
    const secondRequest = createDeferred<ConfigurationSnapshot>();
    const loader = vi
      .fn<() => Promise<ConfigurationSnapshot>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { testStore, Wrapper } = createTestHarness();
    const { result } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.reload();
    });
    expect(loader).toHaveBeenCalledTimes(2);

    const latestSnapshot = configurationSnapshot(SECOND_SERVER_ID, "最新配置");
    await act(async () => {
      secondRequest.resolve(latestSnapshot);
      await secondRequest.promise;
    });
    expect(result.current.status).toBe("ready");
    expect(testStore.getState().configuration.serverIds).toEqual([
      SECOND_SERVER_ID,
    ]);

    await act(async () => {
      firstRequest.resolve(configurationSnapshot(FIRST_SERVER_ID, "过期配置"));
      await firstRequest.promise;
    });
    expect(result.current.status).toBe("ready");
    expect(testStore.getState().configuration.serverIds).toEqual([
      SECOND_SERVER_ID,
    ]);
  });

  it("修改开始后拒绝旧列表，并在修改结束后读取权威快照", async () => {
    const staleRequest = createDeferred<ConfigurationSnapshot>();
    const refreshedRequest = createDeferred<ConfigurationSnapshot>();
    const mutation = createDeferred<void>();
    const loader = vi
      .fn<() => Promise<ConfigurationSnapshot>>()
      .mockReturnValueOnce(staleRequest.promise)
      .mockReturnValueOnce(refreshedRequest.promise);
    const { testStore, Wrapper } = createTestHarness();
    const { result } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
    });
    const created = configurationSnapshot(SECOND_SERVER_ID, "新建配置")
      .servers[0]!;

    let mutationResult!: Promise<void>;
    act(() => {
      mutationResult = result.current.runMutation(async () => {
        await mutation.promise;
        testStore.dispatch(serverProfileUpserted(created));
      });
    });

    await act(async () => {
      staleRequest.resolve(configurationSnapshot(FIRST_SERVER_ID, "过期配置"));
      await staleRequest.promise;
    });
    expect(testStore.getState().configuration.serverIds).toEqual([]);

    await act(async () => {
      mutation.resolve();
      await mutationResult;
    });
    expect(testStore.getState().configuration.serverIds).toEqual([
      SECOND_SERVER_ID,
    ]);
    expect(loader).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshedRequest.resolve({ servers: [created], proxies: [] });
      await refreshedRequest.promise;
    });
    expect(result.current.status).toBe("ready");
    expect(testStore.getState().configuration.serverIds).toEqual([
      SECOND_SERVER_ID,
    ]);
  });

  it("卸载后忽略仍在进行的请求", async () => {
    const pending = createDeferred<ConfigurationSnapshot>();
    const loader = vi.fn(() => pending.promise);
    const { testStore, Wrapper } = createTestHarness();
    const dispatchSpy = vi.spyOn(testStore, "dispatch");
    const { unmount } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
    });

    unmount();
    await act(async () => {
      pending.resolve(configurationSnapshot(FIRST_SERVER_ID, "已卸载"));
      await pending.promise;
    });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(testStore.getState().configuration.serverIds).toEqual([]);
  });

  it("StrictMode 重复 effect 时忽略首次请求", async () => {
    const firstRequest = createDeferred<ConfigurationSnapshot>();
    const secondRequest = createDeferred<ConfigurationSnapshot>();
    const loader = vi
      .fn<() => Promise<ConfigurationSnapshot>>()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const { testStore, Wrapper } = createTestHarness();
    const { result } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
      reactStrictMode: true,
    });

    expect(loader).toHaveBeenCalledTimes(2);
    await act(async () => {
      firstRequest.resolve(configurationSnapshot(FIRST_SERVER_ID, "首次请求"));
      await firstRequest.promise;
    });
    expect(result.current.status).toBe("loading");
    expect(testStore.getState().configuration.serverIds).toEqual([]);

    await act(async () => {
      secondRequest.resolve(
        configurationSnapshot(SECOND_SERVER_ID, "有效请求"),
      );
      await secondRequest.promise;
    });
    expect(result.current.status).toBe("ready");
    expect(testStore.getState().configuration.serverIds).toEqual([
      SECOND_SERVER_ID,
    ]);
  });

  it("失败时只暴露固定中文摘要", async () => {
    const pending = createDeferred<ConfigurationSnapshot>();
    const loader = vi.fn(() => pending.promise);
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
    });

    await act(async () => {
      pending.reject(new Error("SECRET_BACKEND_MESSAGE"));
      await pending.promise.catch(() => undefined);
    });

    expect(result.current).toMatchObject({
      status: "error",
      error: CONFIGURATION_PROFILES_LOAD_ERROR_SUMMARY,
    });
    expect(JSON.stringify(result.current)).not.toContain(
      "SECRET_BACKEND_MESSAGE",
    );
  });

  it("加载器同步失败时同样只暴露固定摘要", () => {
    const loader = vi.fn(() => {
      throw new Error("SECRET_SYNCHRONOUS_MESSAGE");
    });
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(() => useConfigurationProfiles(loader), {
      wrapper: Wrapper,
    });

    expect(result.current).toMatchObject({
      status: "error",
      error: CONFIGURATION_PROFILES_LOAD_ERROR_SUMMARY,
    });
    expect(JSON.stringify(result.current)).not.toContain(
      "SECRET_SYNCHRONOUS_MESSAGE",
    );
  });
});
