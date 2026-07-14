import { configureStore } from "@reduxjs/toolkit";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { Provider } from "react-redux";
import { describe, expect, it, vi } from "vitest";

import type {
  ConfigurationSnapshot,
  ServerCredential,
  ServerId,
  ServerProfile,
} from "../configuration";
import { ConfigurationCommandError } from "../configuration";
import type {
  ServerEditorMode,
  ServerEditorSubmission,
} from "../components/serverEditorModel";
import {
  configurationReducer,
  serverProfileRemoved,
  serverProfileUpserted,
} from "../store/configurationSlice";
import { useConfigurationProfiles } from "./useConfigurationProfiles";
import {
  executeServerProfileDelete,
  executeServerProfileSave,
  useServerProfileMutations,
  type ConfigurationMutationRunner,
  type ServerProfileMutationCommands,
  type ServerProfileMutationDispatch,
} from "./useServerProfileMutations";

const SERVER_ID = "11111111-1111-4111-8111-111111111111" as ServerId;
const SECOND_SERVER_ID = "22222222-2222-4222-8222-222222222222" as ServerId;
const SECRET_SENTINEL = "SECRET_BACKEND_MESSAGE";

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

interface LocalProfileOptions {
  readonly serverId?: ServerId;
  readonly name?: string;
  readonly version?: number;
  readonly executablePath?: string;
  readonly arguments?: readonly string[];
  readonly nonSensitiveEnvironment?: Readonly<Record<string, string>>;
  readonly credentialConfigured?: boolean;
}

function localProfile(options: LocalProfileOptions = {}): ServerProfile {
  return {
    serverId: options.serverId ?? SERVER_ID,
    name: options.name ?? "本机服务器",
    version: options.version ?? 1,
    configuration: {
      type: "localStdio",
      executablePath: options.executablePath ?? "/usr/bin/codex",
      arguments: options.arguments ?? ["app-server"],
      nonSensitiveEnvironment: options.nonSensitiveEnvironment ?? {},
    },
    credentialConfigured: options.credentialConfigured ?? false,
    activeWindowCount: 0,
    createdAtMs: 1_000,
    updatedAtMs: (options.version ?? 1) * 1_000,
  };
}

function localSubmission(
  credentialIntent: ServerEditorSubmission["credentialIntent"] = {
    type: "keep",
  },
  options: Pick<
    LocalProfileOptions,
    "name" | "executablePath" | "arguments" | "nonSensitiveEnvironment"
  > = {},
): ServerEditorSubmission {
  return {
    name: options.name ?? "本机服务器",
    configuration: {
      type: "localStdio",
      executablePath: options.executablePath ?? "/usr/bin/codex",
      arguments: options.arguments ?? ["app-server"],
      nonSensitiveEnvironment: options.nonSensitiveEnvironment ?? {},
    },
    credentialIntent,
  };
}

function createMode(): ServerEditorMode {
  return { type: "create" };
}

function editMode(profile: ServerProfile): ServerEditorMode {
  return { type: "edit", profile };
}

function unexpectedCommand(): Promise<never> {
  return Promise.reject(new Error("unexpected command"));
}

function createCommands(
  overrides: Partial<ServerProfileMutationCommands> = {},
): ServerProfileMutationCommands {
  return {
    createServerProfile: unexpectedCommand,
    updateServerProfile: unexpectedCommand,
    deleteServerProfile: unexpectedCommand,
    setServerCredential: unexpectedCommand,
    clearServerCredential: unexpectedCommand,
    ...overrides,
  };
}

function eventDispatch(events: string[]): ServerProfileMutationDispatch {
  return (action) => {
    if (serverProfileUpserted.match(action)) {
      events.push(`dispatch:${action.payload.version}`);
    } else if (serverProfileRemoved.match(action)) {
      events.push(`remove:${action.payload}`);
    }
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

describe("executeServerProfileSave", () => {
  it("创建配置后按返回版本设置凭据，并逐步分发已确认 profile", async () => {
    const events: string[] = [];
    const created = localProfile({ version: 1 });
    const credentialSaved = localProfile({
      version: 2,
      credentialConfigured: true,
    });
    const credential: ServerCredential = {
      type: "sensitiveEnvironment",
      values: { TOKEN: "new-secret" },
    };
    const create = vi.fn(async () => {
      events.push("create");
      return created;
    });
    const setCredential = vi.fn(async () => {
      events.push("set");
      return credentialSaved;
    });

    const outcome = await executeServerProfileSave({
      mode: createMode(),
      submission: localSubmission({ type: "set", credential }),
      commands: createCommands({
        createServerProfile: create,
        setServerCredential: setCredential,
      }),
      dispatch: eventDispatch(events),
    });

    expect(events).toEqual(["create", "dispatch:1", "set", "dispatch:2"]);
    expect(setCredential).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 1,
      credential,
    });
    expect(outcome).toEqual({ status: "saved", profile: credentialSaved });
    expect(JSON.stringify(outcome)).not.toContain("new-secret");
  });

  it("创建后凭据失败时返回配置已保存的部分结果", async () => {
    const events: string[] = [];
    const created = localProfile({ version: 7 });
    const outcome = await executeServerProfileSave({
      mode: createMode(),
      submission: localSubmission({
        type: "set",
        credential: {
          type: "sensitiveEnvironment",
          values: { TOKEN: "secret" },
        },
      }),
      commands: createCommands({
        createServerProfile: vi.fn(async () => created),
        setServerCredential: vi.fn(async () => {
          events.push("set");
          throw new ConfigurationCommandError("credentialServiceLocked");
        }),
      }),
      dispatch: eventDispatch(events),
    });

    expect(events).toEqual(["dispatch:7", "set"]);
    expect(outcome).toEqual({
      status: "partiallySaved",
      profile: created,
      dataEffect: "configurationSavedCredentialNotSaved",
      error:
        "服务器配置已保存，但新凭据未保存。系统凭据服务已锁定，请解锁后重试",
      errorCode: "credentialServiceLocked",
    });
  });

  it("create + clear 非法输入在创建前失败且没有副作用", async () => {
    const create = vi.fn(async () => localProfile());
    const dispatch = vi.fn();
    const outcome = await executeServerProfileSave({
      mode: createMode(),
      submission: localSubmission({
        type: "clear",
        credentialType: "sensitiveEnvironment",
      }),
      commands: createCommands({ createServerProfile: create }),
      dispatch,
    });

    expect(outcome).toEqual({
      status: "failed",
      error: "新建服务器时不能清除已保存凭据",
      errorCode: null,
    });
    expect(create).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("编辑 keep 只按原版本更新配置", async () => {
    const original = localProfile({ version: 4, credentialConfigured: true });
    const updated = localProfile({
      version: 5,
      credentialConfigured: true,
      arguments: ["app-server", "--listen"],
    });
    const update = vi.fn(async () => updated);
    const clear = vi.fn(unexpectedCommand);
    const setCredential = vi.fn(unexpectedCommand);

    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission(
        { type: "keep" },
        { arguments: ["app-server", "--listen"] },
      ),
      commands: createCommands({
        updateServerProfile: update,
        clearServerCredential: clear,
        setServerCredential: setCredential,
      }),
      dispatch: vi.fn(),
    });

    expect(update).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 4,
      name: "本机服务器",
      configuration: updated.configuration,
    });
    expect(clear).not.toHaveBeenCalled();
    expect(setCredential).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "saved", profile: updated });
  });

  it("clear 先清除凭据，再以返回版本更新配置", async () => {
    const events: string[] = [];
    const original = localProfile({ version: 3, credentialConfigured: true });
    const cleared = localProfile({ version: 4 });
    const updated = localProfile({ version: 5, name: "重命名" });
    const clear = vi.fn(async () => {
      events.push("clear");
      return cleared;
    });
    const update = vi.fn(async () => {
      events.push("update");
      return updated;
    });

    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission(
        { type: "clear", credentialType: "sensitiveEnvironment" },
        { name: "重命名" },
      ),
      commands: createCommands({
        clearServerCredential: clear,
        updateServerProfile: update,
      }),
      dispatch: eventDispatch(events),
    });

    expect(events).toEqual(["clear", "dispatch:4", "update", "dispatch:5"]);
    expect(clear).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 3,
      credentialType: "sensitiveEnvironment",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 4 }),
    );
    expect(outcome).toEqual({ status: "saved", profile: updated });
  });

  it("安全绑定变化时按 clear、update、set 的返回版本串行执行", async () => {
    const events: string[] = [];
    const original = localProfile({ version: 10, credentialConfigured: true });
    const cleared = localProfile({ version: 11 });
    const updated = localProfile({
      version: 12,
      executablePath: "/opt/codex/bin/codex",
    });
    const saved = localProfile({
      version: 13,
      executablePath: "/opt/codex/bin/codex",
      credentialConfigured: true,
    });
    const credential: ServerCredential = {
      type: "sensitiveEnvironment",
      values: { TOKEN: "replacement" },
    };
    const clear = vi.fn(async () => {
      events.push("clear");
      return cleared;
    });
    const update = vi.fn(async () => {
      events.push("update");
      return updated;
    });
    const setCredential = vi.fn(async () => {
      events.push("set");
      return saved;
    });

    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission(
        { type: "set", credential },
        { executablePath: "/opt/codex/bin/codex" },
      ),
      commands: createCommands({
        clearServerCredential: clear,
        updateServerProfile: update,
        setServerCredential: setCredential,
      }),
      dispatch: eventDispatch(events),
    });

    expect(events).toEqual([
      "clear",
      "dispatch:11",
      "update",
      "dispatch:12",
      "set",
      "dispatch:13",
    ]);
    expect(clear).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 10,
      credentialType: "sensitiveEnvironment",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 11 }),
    );
    expect(setCredential).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 12,
      credential,
    });
    expect(outcome).toEqual({ status: "saved", profile: saved });
  });

  it("安全绑定未变化时直接 update、set，不清除已有凭据", async () => {
    const events: string[] = [];
    const original = localProfile({ version: 2, credentialConfigured: true });
    const updated = localProfile({
      version: 3,
      credentialConfigured: true,
      arguments: ["app-server", "--verbose"],
    });
    const saved = localProfile({
      version: 4,
      credentialConfigured: true,
      arguments: ["app-server", "--verbose"],
    });
    const clear = vi.fn(unexpectedCommand);
    const setCredential = vi.fn(async () => {
      events.push("set");
      return saved;
    });

    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission(
        {
          type: "set",
          credential: {
            type: "sensitiveEnvironment",
            values: { TOKEN: "replacement" },
          },
        },
        { arguments: ["app-server", "--verbose"] },
      ),
      commands: createCommands({
        clearServerCredential: clear,
        updateServerProfile: vi.fn(async () => {
          events.push("update");
          return updated;
        }),
        setServerCredential: setCredential,
      }),
      dispatch: eventDispatch(events),
    });

    expect(events).toEqual(["update", "dispatch:3", "set", "dispatch:4"]);
    expect(clear).not.toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 3 }),
    );
    expect(outcome).toEqual({ status: "saved", profile: saved });
  });

  it("清除成功但更新失败时保留清除后的权威 profile", async () => {
    const original = localProfile({ version: 8, credentialConfigured: true });
    const cleared = localProfile({ version: 9 });
    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission({
        type: "clear",
        credentialType: "sensitiveEnvironment",
      }),
      commands: createCommands({
        clearServerCredential: vi.fn(async () => cleared),
        updateServerProfile: vi.fn(async () => {
          throw new ConfigurationCommandError("serverVersionConflict");
        }),
      }),
      dispatch: vi.fn(),
    });

    expect(outcome).toEqual({
      status: "partiallySaved",
      profile: cleared,
      dataEffect: "credentialClearedConfigurationNotSaved",
      error:
        "服务器凭据已清除，但配置修改未保存。服务器配置已被其他操作修改，请重新加载后重试",
      errorCode: "serverVersionConflict",
    });
  });

  it("更新成功但 set 失败时保留最新 profile 和实际凭据标记", async () => {
    const original = localProfile({ version: 5, credentialConfigured: true });
    const updated = localProfile({
      version: 6,
      credentialConfigured: true,
      arguments: ["app-server", "--verbose"],
    });
    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission(
        {
          type: "set",
          credential: {
            type: "sensitiveEnvironment",
            values: { TOKEN: "replacement" },
          },
        },
        { arguments: ["app-server", "--verbose"] },
      ),
      commands: createCommands({
        updateServerProfile: vi.fn(async () => updated),
        setServerCredential: vi.fn(async () => {
          throw new ConfigurationCommandError("credentialStorageFailed");
        }),
      }),
      dispatch: vi.fn(),
    });

    expect(outcome).toEqual({
      status: "partiallySaved",
      profile: updated,
      dataEffect: "configurationSavedCredentialNotSaved",
      error:
        "服务器配置已保存，但新凭据未保存。系统未能完成凭据存储操作，请重试",
      errorCode: "credentialStorageFailed",
    });
    expect(
      outcome.status === "partiallySaved" &&
        outcome.profile.credentialConfigured,
    ).toBe(true);
  });

  it("安全绑定变化后 set 失败时返回已更新且无凭据的 profile", async () => {
    const original = localProfile({ version: 20, credentialConfigured: true });
    const cleared = localProfile({ version: 21 });
    const updated = localProfile({
      version: 22,
      executablePath: "/opt/codex/bin/codex",
    });
    const setCredential = vi.fn(async () => {
      throw new ConfigurationCommandError("credentialServiceTimedOut");
    });
    const outcome = await executeServerProfileSave({
      mode: editMode(original),
      submission: localSubmission(
        {
          type: "set",
          credential: {
            type: "sensitiveEnvironment",
            values: { TOKEN: "replacement" },
          },
        },
        { executablePath: "/opt/codex/bin/codex" },
      ),
      commands: createCommands({
        clearServerCredential: vi.fn(async () => cleared),
        updateServerProfile: vi.fn(async () => updated),
        setServerCredential: setCredential,
      }),
      dispatch: vi.fn(),
    });

    expect(setCredential).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 22 }),
    );
    expect(outcome).toEqual({
      status: "partiallySaved",
      profile: updated,
      dataEffect: "configurationSavedCredentialNotSaved",
      error: "服务器配置已保存，但新凭据未保存。系统凭据服务响应超时，请重试",
      errorCode: "credentialServiceTimedOut",
    });
    expect(
      outcome.status === "partiallySaved" &&
        outcome.profile.credentialConfigured,
    ).toBe(false);
  });

  it.each([
    ["serverNameConflict", "已存在同名服务器，请更换名称"],
    ["serverVersionConflict", "服务器配置已被其他操作修改，请重新加载后重试"],
    ["credentialServiceUnavailable", "系统凭据服务不可用，请检查系统密钥环"],
  ] as const)("将 %s 映射为固定中文摘要", async (code, summary) => {
    const outcome = await executeServerProfileSave({
      mode: createMode(),
      submission: localSubmission(),
      commands: createCommands({
        createServerProfile: vi.fn(async () => {
          throw new ConfigurationCommandError(code);
        }),
      }),
      dispatch: vi.fn(),
    });

    expect(outcome).toEqual({
      status: "failed",
      error: summary,
      errorCode: code,
    });
  });

  it("未知错误不会泄露消息、属性或敏感哨兵", async () => {
    const backendError = Object.assign(new Error(SECRET_SENTINEL), {
      credential: SECRET_SENTINEL,
    });
    const outcome = await executeServerProfileSave({
      mode: createMode(),
      submission: localSubmission(),
      commands: createCommands({
        createServerProfile: vi.fn(async () => {
          throw backendError;
        }),
      }),
      dispatch: vi.fn(),
    });

    expect(outcome).toEqual({
      status: "failed",
      error: "服务器配置操作失败，请重试",
      errorCode: null,
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET_SENTINEL);
  });
});

describe("executeServerProfileDelete", () => {
  it("按 serverId/version 删除，成功后移除 store profile", async () => {
    const events: string[] = [];
    const remove = vi.fn(async () => {
      events.push("delete");
    });
    const outcome = await executeServerProfileDelete({
      serverId: SERVER_ID,
      version: 12,
      commands: createCommands({ deleteServerProfile: remove }),
      dispatch: eventDispatch(events),
    });

    expect(remove).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      expectedVersion: 12,
    });
    expect(events).toEqual(["delete", `remove:${SERVER_ID}`]);
    expect(outcome).toEqual({ status: "deleted", serverId: SERVER_ID });
  });

  it("区分使用中错误，失败时不移除 store profile", async () => {
    const dispatch = vi.fn();
    const outcome = await executeServerProfileDelete({
      serverId: SERVER_ID,
      version: 4,
      commands: createCommands({
        deleteServerProfile: vi.fn(async () => {
          throw new ConfigurationCommandError("serverInUse");
        }),
      }),
      dispatch,
    });

    expect(outcome).toEqual({
      status: "failed",
      error: "服务器正在被窗口使用，请关闭相关窗口或将这些窗口切换到其他服务器",
      errorCode: "serverInUse",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("useServerProfileMutations", () => {
  it("通过 runMutation 协调旧快照，并在 finally 重载权威列表", async () => {
    const staleLoad = createDeferred<ConfigurationSnapshot>();
    const refreshedLoad = createDeferred<ConfigurationSnapshot>();
    const createRequest = createDeferred<ServerProfile>();
    const created = localProfile({
      serverId: SECOND_SERVER_ID,
      name: "新服务器",
    });
    const loader = vi
      .fn<() => Promise<ConfigurationSnapshot>>()
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(refreshedLoad.promise);
    const commands = createCommands({
      createServerProfile: vi.fn(() => createRequest.promise),
    });
    const { testStore, Wrapper } = createTestHarness();
    const { result } = renderHook(
      () => {
        const profiles = useConfigurationProfiles(loader);
        const mutations = useServerProfileMutations(
          profiles.runMutation,
          commands,
        );
        return { profiles, mutations };
      },
      { wrapper: Wrapper },
    );

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = result.current.mutations.saveProfile(
        createMode(),
        localSubmission({ type: "keep" }, { name: "新服务器" }),
      );
    });

    await act(async () => {
      staleLoad.resolve({
        servers: [localProfile({ name: "过期服务器" })],
        proxies: [],
      });
      await staleLoad.promise;
    });
    expect(testStore.getState().configuration.serverIds).toEqual([]);

    await act(async () => {
      createRequest.resolve(created);
      await savePromise;
    });
    expect(testStore.getState().configuration.serverIds).toEqual([
      SECOND_SERVER_ID,
    ]);
    expect(loader).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshedLoad.resolve({ servers: [created], proxies: [] });
      await refreshedLoad.promise;
    });
    expect(result.current.profiles.status).toBe("ready");
    expect(
      testStore.getState().configuration.serversById[SECOND_SERVER_ID],
    ).toEqual(created);
  });

  it("同一实例拒绝保存与删除重入，且不覆盖正在运行的状态", async () => {
    const pending = createDeferred<ServerProfile>();
    const created = localProfile();
    const create = vi.fn(() => pending.promise);
    const remove = vi.fn(async () => undefined);
    const runner: ConfigurationMutationRunner = async (mutation) => mutation();
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(
      () =>
        useServerProfileMutations(
          runner,
          createCommands({
            createServerProfile: create,
            deleteServerProfile: remove,
          }),
        ),
      { wrapper: Wrapper },
    );

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = result.current.saveProfile(createMode(), localSubmission());
    });
    expect(result.current.saveState.saving).toBe(true);

    let busyOutcome!: Awaited<ReturnType<typeof result.current.deleteProfile>>;
    await act(async () => {
      busyOutcome = await result.current.deleteProfile(SERVER_ID, 1);
    });
    expect(busyOutcome).toEqual({
      status: "failed",
      error: "正在处理另一项服务器配置操作，请稍候",
      errorCode: null,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(result.current.saveState.saving).toBe(true);
    expect(result.current.deleteState).toEqual({
      saving: false,
      error: null,
      outcome: null,
    });

    await act(async () => {
      pending.resolve(created);
      await savePromise;
    });
    expect(result.current.saveState).toEqual({
      saving: false,
      error: null,
      outcome: { status: "saved", profile: created },
    });
  });

  it("分别维护保存和删除状态，并支持 reset", async () => {
    const created = localProfile();
    const runner: ConfigurationMutationRunner = async (mutation) => mutation();
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(
      () =>
        useServerProfileMutations(
          runner,
          createCommands({
            createServerProfile: vi.fn(async () => created),
            deleteServerProfile: vi.fn(async () => {
              throw new ConfigurationCommandError("serverInUse");
            }),
          }),
        ),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await result.current.saveProfile(createMode(), localSubmission());
    });
    await act(async () => {
      await result.current.deleteProfile(SERVER_ID, 1);
    });
    expect(result.current.saveState.outcome?.status).toBe("saved");
    expect(result.current.deleteState.error).toBe(
      "服务器正在被窗口使用，请关闭相关窗口或将这些窗口切换到其他服务器",
    );

    act(() => {
      result.current.resetSave();
      result.current.resetDelete();
    });
    expect(result.current.saveState).toEqual({
      saving: false,
      error: null,
      outcome: null,
    });
    expect(result.current.deleteState).toEqual({
      saving: false,
      error: null,
      outcome: null,
    });
  });

  it("卸载后继续完成副作用，但不再更新 Hook 状态", async () => {
    const pending = createDeferred<ServerProfile>();
    const created = localProfile();
    const runner: ConfigurationMutationRunner = async (mutation) => mutation();
    const { testStore, Wrapper } = createTestHarness();
    const { result, unmount } = renderHook(
      () =>
        useServerProfileMutations(
          runner,
          createCommands({ createServerProfile: vi.fn(() => pending.promise) }),
        ),
      { wrapper: Wrapper },
    );

    let savePromise!: Promise<unknown>;
    act(() => {
      savePromise = result.current.saveProfile(createMode(), localSubmission());
    });
    expect(result.current.saveState.saving).toBe(true);
    unmount();

    await act(async () => {
      pending.resolve(created);
      await savePromise;
    });
    expect(result.current.saveState).toEqual({
      saving: true,
      error: null,
      outcome: null,
    });
    expect(testStore.getState().configuration.serversById[SERVER_ID]).toEqual(
      created,
    );
  });

  it("StrictMode 下单次调用只执行一次命令和 mutation runner", async () => {
    const created = localProfile();
    const create = vi.fn(async () => created);
    const runnerCall = vi.fn();
    const runner: ConfigurationMutationRunner = async (mutation) => {
      runnerCall();
      return mutation();
    };
    const commands = createCommands({ createServerProfile: create });
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(
      () => useServerProfileMutations(runner, commands),
      { wrapper: Wrapper, reactStrictMode: true },
    );

    await act(async () => {
      await result.current.saveProfile(createMode(), localSubmission());
    });
    expect(runnerCall).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.current.saveState.outcome).toEqual({
      status: "saved",
      profile: created,
    });
  });

  it("runner 抛出未知错误时只写入脱敏状态", async () => {
    const runner: ConfigurationMutationRunner = async () => {
      throw new Error(SECRET_SENTINEL);
    };
    const { Wrapper } = createTestHarness();
    const { result } = renderHook(
      () => useServerProfileMutations(runner, createCommands()),
      { wrapper: Wrapper },
    );

    await act(async () => {
      await result.current.saveProfile(createMode(), localSubmission());
    });
    expect(result.current.saveState).toEqual({
      saving: false,
      error: "服务器配置操作失败，请重试",
      outcome: {
        status: "failed",
        error: "服务器配置操作失败，请重试",
        errorCode: null,
      },
    });
    expect(JSON.stringify(result.current.saveState)).not.toContain(
      SECRET_SENTINEL,
    );
  });
});
