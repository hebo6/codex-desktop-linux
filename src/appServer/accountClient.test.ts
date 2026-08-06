import { describe, expect, it, vi } from "vitest";

import type { ServerNotification } from "../protocol/generated";
import { AppServerAccountClient } from "./accountClient";
import type { AppServerSession } from "./session";

describe("AppServerAccountClient", () => {
  it("读取账户和限额并分别转发对应更新通知", () => {
    const notificationHandlers: Array<(notification: ServerNotification) => void> = [];
    const sendRequest = vi.fn(() => ({ id: 1, epoch: 1, stage: "pending", result: Promise.resolve({ rateLimits: {} }) }));
    const client = new AppServerAccountClient({
      sendRequest: sendRequest as unknown as AppServerSession["sendRequest"],
      subscribeNotifications: (handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      },
    });
    const accountListener = vi.fn();
    const rateLimitsListener = vi.fn();
    client.subscribeAccountUpdates(accountListener);
    client.subscribeRateLimitUpdates(rateLimitsListener);
    client.readAccount();
    client.readRateLimits();

    expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "account/read", params: {} }));
    expect(sendRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "account/rateLimits/read" }));
    notificationHandlers[0]?.({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } } as ServerNotification);
    notificationHandlers[0]?.({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 60 } } } } as ServerNotification);
    notificationHandlers[1]?.({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } } as ServerNotification);
    notificationHandlers[1]?.({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 60 } } } } as ServerNotification);
    expect(accountListener).toHaveBeenCalledOnce();
    expect(rateLimitsListener).toHaveBeenCalledOnce();
  });
});
