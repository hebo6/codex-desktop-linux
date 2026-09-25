import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppServerAccountClient } from "../appServer";
import type { GetAccountTokenUsageResponse } from "../protocol/generated";
import { useAccountTokenUsage } from "./useAccountTokenUsage";

describe("useAccountTokenUsage", () => {
  it("账户变化立即移除旧用量，较早查询不能覆盖新账户结果", async () => {
    const replies: ((value: GetAccountTokenUsageResponse) => void)[] = [];
    let updated!: () => void;
    const release = vi.fn();
    const client = {
      readTokenUsage: () => ({ result: new Promise<GetAccountTokenUsageResponse>((resolve) => { replies.push(resolve); }) }),
      subscribeAccountUpdates: (listener: () => void) => { updated = listener; return release; },
    } as unknown as AppServerAccountClient;
    const { result, unmount } = renderHook(() => useAccountTokenUsage(client));
    expect(replies).toHaveLength(1);
    act(() => updated());
    expect(replies).toHaveLength(2);
    const fresh: GetAccountTokenUsageResponse = { summary: { lifetimeTokens: 20 } };
    await act(async () => { replies[1]!(fresh); });
    await waitFor(() => expect(result.current.data).toBe(fresh));
    await act(async () => { replies[0]!({ summary: { lifetimeTokens: 10 } }); });
    expect(result.current.data).toBe(fresh);
    act(() => updated());
    expect(result.current.data).toBeNull();
    unmount();
    expect(release).toHaveBeenCalledOnce();
  });
});
