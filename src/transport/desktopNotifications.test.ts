import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopNotificationService } from "./desktopNotifications";
import type { TauriIpc } from "./tauriIpc";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop notifications", () => {
  it("通过原生 IPC 检查桌面通知服务", async () => {
    const availableIpc = {
      invoke: vi.fn(async () => true),
    };
    const unavailableIpc = {
      invoke: vi.fn(async () => false),
    };

    await expect(createDesktopNotificationService(
      availableIpc as Pick<TauriIpc, "invoke">,
    ).permission()).resolves.toBe("granted");
    await expect(createDesktopNotificationService(
      unavailableIpc as Pick<TauriIpc, "invoke">,
    ).requestPermission()).resolves.toBe("unsupported");
    expect(availableIpc.invoke).toHaveBeenCalledWith("desktop_notification_availability", {});
  });

  it("窗口不活跃时通过原生 IPC 发送有界通知", async () => {
    const ipc = {
      invoke: vi.fn(async () => true),
    };
    const service = createDesktopNotificationService(ipc as Pick<TauriIpc, "invoke">);

    await expect(service.show({
      title: `任务${"完".repeat(120)}`,
      body: "返回窗口查看结果",
      tag: "thread:1",
    })).resolves.toBe(true);
    expect(ipc.invoke).toHaveBeenCalledWith("show_desktop_notification", {
      request: {
        title: `任务${"完".repeat(93)}…`,
        body: "返回窗口查看结果",
        tag: "thread:1",
      },
    });
  });

  it("由原生窗口焦点判断决定是否发送", async () => {
    const ipc = {
      invoke: vi.fn(async () => false),
    };
    const service = createDesktopNotificationService(ipc as Pick<TauriIpc, "invoke">);

    await expect(service.show({
      title: "连接失败",
      body: "请检查设置",
      tag: "connection",
    })).resolves.toBe(false);
    expect(ipc.invoke).toHaveBeenCalledWith("show_desktop_notification", {
      request: {
        title: "连接失败",
        body: "请检查设置",
        tag: "connection",
      },
    });
  });
});
