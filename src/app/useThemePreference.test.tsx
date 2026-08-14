import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThemePreference } from "../transport/preferences";
import type { ThemePreferenceSource } from "../transport/themePreference";
import { applyThemePreference } from "./theme";
import { useThemePreference } from "./useThemePreference";

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("useThemePreference", () => {
  it("应用加载的主题并在卸载时停止监听", async () => {
    const release = vi.fn();
    const source: ThemePreferenceSource = {
      load: vi.fn(async () => "dark"),
      subscribe: vi.fn(async () => release),
    };

    const { unmount } = renderHook(() => useThemePreference(source));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("主题事件不会被较旧的加载结果覆盖", async () => {
    let notify!: (theme: ThemePreference) => void;
    let resolveLoad!: (theme: ThemePreference) => void;
    const source: ThemePreferenceSource = {
      load: vi.fn(() => new Promise((resolve) => {
        resolveLoad = resolve;
      })),
      subscribe: vi.fn(async (onChange) => {
        notify = onChange;
        return vi.fn();
      }),
    };

    renderHook(() => useThemePreference(source));
    await waitFor(() => expect(source.load).toHaveBeenCalledTimes(1));
    act(() => notify("dark"));
    await act(async () => resolveLoad("light"));

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("跟随系统时移除固定主题", () => {
    document.documentElement.dataset.theme = "light";
    applyThemePreference("system");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
