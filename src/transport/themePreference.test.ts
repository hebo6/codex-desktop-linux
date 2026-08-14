import { describe, expect, it, vi } from "vitest";

import {
  createThemePreferenceSource,
  type ThemePreferenceEventApi,
} from "./themePreference";
import type { TauriIpc } from "./tauriIpc";

describe("themePreference transport", () => {
  it("通过只读命令加载主题并订阅主题变化", async () => {
    const invoke = vi.fn(async () => "dark");
    let eventName: string | null = null;
    let handler!: (event: { readonly payload: unknown }) => void;
    const unlisten = vi.fn();
    const events: ThemePreferenceEventApi = {
      async listen(event, nextHandler) {
        eventName = event;
        handler = nextHandler;
        return unlisten;
      },
    };
    const source = createThemePreferenceSource(
      { invoke } as Pick<TauriIpc, "invoke">,
      events,
    );

    await expect(source.load()).resolves.toBe("dark");
    expect(invoke).toHaveBeenCalledWith("load_theme_preference", {});

    const onChange = vi.fn();
    const release = await source.subscribe(onChange);
    expect(eventName).toBe("theme-preference-changed");
    handler({ payload: "light" });
    expect(onChange).toHaveBeenCalledWith("light");
    release();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("非法主题回退为跟随系统", async () => {
    const source = createThemePreferenceSource({
      invoke: vi.fn(async () => "contrast"),
    } as Pick<TauriIpc, "invoke">, {
      listen: vi.fn(async () => vi.fn()),
    });

    await expect(source.load()).resolves.toBe("system");
  });
});
