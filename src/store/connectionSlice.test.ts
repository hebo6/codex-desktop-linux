import { describe, expect, it } from "vitest";

import {
  connectionReducer,
  connectionViewChanged,
  connectionViewReset,
  initialConnectionState,
} from "./connectionSlice";

describe("connectionReducer", () => {
  it("默认保持未连接且不伪造错误详情", () => {
    const state = connectionReducer(undefined, { type: "unknown" });

    expect(state).toEqual({
      phase: "disconnected",
      detail: null,
    });
  });

  it("仅保存可序列化的连接视图状态并可重置", () => {
    const initializingState = connectionReducer(
      initialConnectionState,
      connectionViewChanged({
        phase: "initializing",
        detail: "等待 initialize 响应",
      }),
    );

    expect(initializingState).toEqual({
      phase: "initializing",
      detail: "等待 initialize 响应",
    });
    expect(connectionReducer(initializingState, connectionViewReset())).toEqual(
      initialConnectionState,
    );
  });
});
