import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_PREFERENCES, type PreferencesStore } from "../transport/preferences";
import { usePreferences } from "./usePreferences";

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("usePreferences", () => {
  it("加载偏好、立即应用主题并串行保存更新", async () => {
    const save = vi.fn(async (preferences) => preferences);
    const store: PreferencesStore = {
      load: vi.fn(async () => ({ ...DEFAULT_APP_PREFERENCES, theme: "dark" as const })),
      save,
      clearThreadCache: vi.fn(async () => undefined),
      clearApplicationLogs: vi.fn(async () => undefined),
      clearTemporaryFiles: vi.fn(async () => undefined),
      clearAllLocalData: vi.fn(async () => undefined),
      readDiagnostics: vi.fn(async () => ({
        clientVersion: "0.1.0",
        protocolBaseline: "abc",
        operatingSystem: "linux",
        architecture: "x86_64",
        webviewVersion: "2.48.1",
        sessionType: null,
        desktop: null,
      })),
    };
    const { result } = renderHook(() => usePreferences(store));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => result.current.update({ codeWrap: true }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      codeWrap: true,
      theme: "dark",
    })));
  });

  it("保存失败保留当前选择并展示错误", async () => {
    const store: PreferencesStore = {
      load: vi.fn(async () => DEFAULT_APP_PREFERENCES),
      save: vi.fn(async () => { throw new Error("unavailable"); }),
      clearThreadCache: vi.fn(async () => undefined),
      clearApplicationLogs: vi.fn(async () => undefined),
      clearTemporaryFiles: vi.fn(async () => undefined),
      clearAllLocalData: vi.fn(async () => undefined),
      readDiagnostics: vi.fn(async () => { throw new Error("unused"); }),
    };
    const { result } = renderHook(() => usePreferences(store));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.update({ theme: "light" }));
    await waitFor(() => expect(result.current.error).toBe("无法保存偏好设置"));
    expect(result.current.preferences.theme).toBe("light");
  });
});
