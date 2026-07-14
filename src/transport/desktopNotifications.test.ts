import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopNotificationService } from "./desktopNotifications";

const OriginalNotification = globalThis.Notification;

afterEach(() => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: OriginalNotification });
  vi.restoreAllMocks();
});

describe("desktop notifications", () => {
  it("窗口不活跃且已授权时发送，点击后聚焦当前窗口", async () => {
    const instances: Array<{ close: ReturnType<typeof vi.fn>; onclick: (() => void) | null }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
      close = vi.fn();
      onclick: (() => void) | null = null;
      constructor(readonly title: string, readonly options?: NotificationOptions) {
        instances.push(this);
      }
    }
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const focus = vi.fn(async () => undefined);
    const service = createDesktopNotificationService(focus);

    expect(service.show({ title: "任务完成", body: "返回窗口查看结果", tag: "thread:1" })).toBe(true);
    instances[0]?.onclick?.();
    await Promise.resolve();
    expect(instances[0]?.close).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("窗口活跃或未授权时不发送", () => {
    class FakeNotification {
      static permission: NotificationPermission = "denied";
      static requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    }
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
    const service = createDesktopNotificationService();
    expect(service.show({ title: "连接失败", body: "请检查设置", tag: "connection" })).toBe(false);
  });
});
