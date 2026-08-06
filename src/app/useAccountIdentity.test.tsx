import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AppServerAccountClient } from "../appServer";
import type { ServerNotification } from "../protocol/generated";
import { useAccountIdentity } from "./useAccountIdentity";

describe("useAccountIdentity", () => {
  it("读取完整邮箱并在账户更新后刷新", async () => {
    let handler: ((notification: Extract<ServerNotification, { method: "account/updated" }>) => void) | null = null;
    const readAccount = vi.fn()
      .mockReturnValueOnce({ result: Promise.resolve({ account: { email: "alice@example.com", planType: "plus", type: "chatgpt" }, requiresOpenaiAuth: true }) })
      .mockReturnValueOnce({ result: Promise.resolve({ account: { email: "bob@example.com", planType: "pro", type: "chatgpt" }, requiresOpenaiAuth: true }) });
    const client = {
      readAccount,
      subscribeAccountUpdates: (next: typeof handler) => {
        handler = next;
        return () => undefined;
      },
    } as unknown as AppServerAccountClient;

    const { result } = renderHook(() => useAccountIdentity(client));
    await waitFor(() => expect(result.current.email).toBe("alice@example.com"));

    act(() => handler?.({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } }));
    await waitFor(() => expect(result.current.email).toBe("bob@example.com"));
    expect(readAccount).toHaveBeenCalledTimes(2);
  });

  it("非 ChatGPT 账户不生成用户名", async () => {
    const client = {
      readAccount: () => ({ result: Promise.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true }) }),
      subscribeAccountUpdates: () => () => undefined,
    } as unknown as AppServerAccountClient;

    const { result } = renderHook(() => useAccountIdentity(client));
    await waitFor(() => expect(result.current.email).toBeNull());
  });
});
