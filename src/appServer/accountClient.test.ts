import { describe, expect, it, vi } from "vitest";

import type { ServerNotification } from "../protocol/generated";
import { AppServerAccountClient } from "./accountClient";
import type { AppServerSession } from "./session";

describe("AppServerAccountClient", () => {
  it("读取限额并只转发限额更新通知", () => {
    const notificationHandlers: Array<(notification: ServerNotification) => void> = [];
    const sendRequest = vi.fn(() => ({ id: 1, epoch: 1, stage: "pending", result: Promise.resolve({ rateLimits: {} }) }));
    const client = new AppServerAccountClient({
      sendRequest: sendRequest as unknown as AppServerSession["sendRequest"],
      subscribeNotifications: (handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      },
    });
    const listener = vi.fn();
    client.subscribeRateLimitUpdates(listener);
    client.readRateLimits();

    expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "account/rateLimits/read" }));
    notificationHandlers[0]?.({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 60 } } } } as ServerNotification);
    expect(listener).toHaveBeenCalledOnce();
  });
});
