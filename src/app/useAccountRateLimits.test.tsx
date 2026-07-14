import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AppServerAccountClient } from "../appServer";
import type { ServerNotification } from "../protocol/generated";
import { useAccountRateLimits } from "./useAccountRateLimits";

describe("useAccountRateLimits", () => {
  it("合并通知并在刷新失败后保留最后成功数据", async () => {
    let handler: ((notification: Extract<ServerNotification, { method: "account/rateLimits/updated" }>) => void) | null = null;
    const readRateLimits = vi.fn()
      .mockReturnValueOnce({ result: Promise.resolve({ rateLimits: { limitId: "codex", primary: { usedPercent: 20 } } }) })
      .mockImplementationOnce(() => ({ result: Promise.reject(new Error("offline")) }));
    const client = {
      readRateLimits,
      subscribeRateLimitUpdates: (next: typeof handler) => {
        handler = next;
        return () => { handler = null; };
      },
    } as unknown as AppServerAccountClient;
    const { result } = renderHook(() => useAccountRateLimits(client));

    await waitFor(() => expect(result.current.data?.rateLimits.primary?.usedPercent).toBe(20));
    act(() => handler?.({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: { usedPercent: 55 } } } } as Extract<ServerNotification, { method: "account/rateLimits/updated" }>));
    expect(result.current.data?.rateLimits.primary?.usedPercent).toBe(55);
    await act(() => result.current.refresh());

    expect(result.current.error).toBe("无法读取账户限额");
    expect(result.current.data?.rateLimits.primary?.usedPercent).toBe(55);
  });
});
