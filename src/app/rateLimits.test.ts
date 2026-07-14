import { describe, expect, it } from "vitest";

import type { GetAccountRateLimitsResponse } from "../protocol/generated";
import {
  collectRemainingLimitWindows,
  mergeRateLimitUpdate,
  mostUrgentLimitWindow,
  rateLimitAttention,
  remainingPercent,
} from "./rateLimits";

describe("rateLimits", () => {
  it("把已用百分比转换为受限的剩余百分比", () => {
    expect(remainingPercent(73)).toBe(27);
    expect(remainingPercent(120)).toBe(0);
    expect(remainingPercent(-10)).toBe(100);
  });

  it("从多限额窗口选择剩余最少的一项", () => {
    const data = {
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          limitName: "Codex",
          primary: { resetsAt: 2_000_000_000, usedPercent: 20, windowDurationMins: 300 },
          secondary: { resetsAt: 2_000_100_000, usedPercent: 92, windowDurationMins: 10_080 },
        },
      },
    } satisfies GetAccountRateLimitsResponse;
    const windows = collectRemainingLimitWindows(data);

    expect(windows.map(({ remainingPercent: value }) => value)).toEqual([8, 80]);
    expect(mostUrgentLimitWindow(windows)?.id).toBe("codex:secondary");
  });

  it("稀疏通知只覆盖非空字段并更新对应限额桶", () => {
    const current = {
      rateLimits: { limitId: "codex", limitName: "Codex", planType: "plus", primary: { usedPercent: 20 } },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", limitName: "Codex", planType: "plus", primary: { usedPercent: 20 } },
      },
    } satisfies GetAccountRateLimitsResponse;
    const merged = mergeRateLimitUpdate(current, {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 40 },
    });

    expect(merged.rateLimits.limitName).toBe("Codex");
    expect(merged.rateLimits.planType).toBe("plus");
    expect(merged.rateLimitsByLimitId?.codex?.primary?.usedPercent).toBe(40);
  });

  it("仅在剩余 25% 以下提高关注度", () => {
    expect(rateLimitAttention(26)).toBe("normal");
    expect(rateLimitAttention(25)).toBe("warning");
    expect(rateLimitAttention(11)).toBe("warning");
    expect(rateLimitAttention(10)).toBe("danger");
    expect(rateLimitAttention(null)).toBe("unknown");
  });
});
