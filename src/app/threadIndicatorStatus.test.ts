import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "./useServerThreads";
import { threadIndicatorStatus } from "./threadIndicatorStatus";

function thread(status: ThreadSummary["status"]): Pick<ThreadSummary, "status"> {
  return { status };
}

describe("threadIndicatorStatus", () => {
  it("让错误和等待交互优先于待查看结果", () => {
    expect(
      threadIndicatorStatus(thread({ type: "systemError" }), {
        resultPending: true,
      }),
    ).toBe("error");
    expect(
      threadIndicatorStatus(
        thread({ type: "active", activeFlags: ["waitingOnApproval"] }),
        { resultPending: true },
      ),
    ).toBe("approval");
    expect(
      threadIndicatorStatus(
        thread({ type: "active", activeFlags: ["waitingOnUserInput"] }),
        { resultPending: true },
      ),
    ).toBe("input");
  });

  it("用待查看结果覆盖完成通知后的短暂运行状态", () => {
    expect(
      threadIndicatorStatus(
        thread({ type: "active", activeFlags: [] }),
        { resultPending: true },
      ),
    ).toBe("resultReady");
    expect(
      threadIndicatorStatus(thread({ type: "idle" }), {
        resultPending: true,
      }),
    ).toBe("resultReady");
  });
});
