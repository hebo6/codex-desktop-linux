import { describe, expect, it, vi } from "vitest";

import type { TauriIpc } from "./tauriIpc";
import {
  parseConfiguredServerStatuses,
  subscribeConfiguredServerStatuses,
} from "./configuredServerStatuses";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

describe("configured server statuses", () => {
  it("严格解析去重后的全量连接摘要", () => {
    expect(parseConfiguredServerStatuses({
      statuses: [
        { serverId: SERVER_ID, phase: "connecting", stage: "targetTls" },
      ],
    })).toEqual([
      { serverId: SERVER_ID, phase: "connecting", stage: "targetTls" },
    ]);
    expect(parseConfiguredServerStatuses({
      statuses: [
        { serverId: SERVER_ID, phase: "ready" },
        { serverId: SERVER_ID, phase: "ready" },
      ],
    })).toBeNull();
    expect(parseConfiguredServerStatuses({
      statuses: [{ serverId: SERVER_ID, phase: "ready", detail: "secret" }],
    })).toBeNull();
  });

  it("订阅 Rust 通道并用订阅标识精确退订", async () => {
    const events: { deliver?: (event: unknown) => void } = {};
    const ipc: TauriIpc = {
      createEventChannel(onMessage) {
        events.deliver = onMessage;
        return { channel: { kind: "statuses" } };
      },
      invoke: vi.fn(async (command) => command === "subscribe_configured_server_statuses" ? 7 : undefined) as TauriIpc["invoke"],
    };
    const onChange = vi.fn();
    const unsubscribe = await subscribeConfiguredServerStatuses(onChange, ipc);
    events.deliver?.({ statuses: [{ serverId: SERVER_ID, phase: "ready" }] });
    expect(onChange).toHaveBeenCalledWith([{ serverId: SERVER_ID, phase: "ready" }]);
    unsubscribe();
    expect(ipc.invoke).toHaveBeenLastCalledWith(
      "unsubscribe_configured_server_statuses",
      { request: { subscriptionId: 7 } },
    );
    events.deliver?.({ statuses: [] });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
