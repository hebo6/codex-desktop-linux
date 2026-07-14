import { describe, expect, it, vi } from "vitest";

import { subscribeDeepLinkTargets } from "./deepLink";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

describe("deep-link transport", () => {
  it("先监听再原子读取首次启动与单实例激活目标", async () => {
    const targets: unknown[] = [];
    let eventHandler: ((event: { readonly payload: unknown }) => void) | undefined;
    const values: unknown[] = [
      { serverId: SERVER_ID },
      { serverId: SERVER_ID, threadId: "thread-7" },
    ];
    const invoke = vi.fn(async () => values.shift() ?? null);
    const release = await subscribeDeepLinkTargets(
      (target) => targets.push(target),
      vi.fn(),
      { invoke },
      {
        listen: vi.fn(async (_event, handler) => {
          eventHandler = handler;
          return vi.fn();
        }),
      },
    );
    expect(targets).toEqual([{ serverId: SERVER_ID }]);

    eventHandler?.({ payload: null });
    await vi.waitFor(() => expect(targets).toHaveLength(2));
    expect(targets[1]).toEqual({ serverId: SERVER_ID, threadId: "thread-7" });
    release();
  });

  it.each([
    { serverId: SERVER_ID, token: "DO_NOT_ACCEPT" },
    { serverId: "invalid" },
    { serverId: SERVER_ID, threadId: "a/b" },
  ])("拒绝无效或携带额外字段的目标 %#", async (value) => {
    const onTarget = vi.fn();
    const onError = vi.fn();
    await subscribeDeepLinkTargets(
      onTarget,
      onError,
      { invoke: vi.fn(async () => value) },
      { listen: vi.fn(async () => vi.fn()) },
    );
    expect(onTarget).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
