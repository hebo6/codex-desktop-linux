import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../styles/tokens.css";
import { RateLimitIndicator } from "./RateLimitIndicator";

describe("RateLimitIndicator", () => {
  it("圆环和详情都展示最紧迫窗口的剩余量", () => {
    render(
      <RateLimitIndicator
        data={{
          rateLimits: { planType: "plus", primary: { usedPercent: 20 } },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              planType: "plus",
              primary: { resetsAt: Math.floor(Date.now() / 1000) + 3600, usedPercent: 15, windowDurationMins: 300 },
              secondary: { resetsAt: Math.floor(Date.now() / 1000) + 86_400, usedPercent: 92, windowDurationMins: 10_080 },
            },
          },
        }}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
        refreshing={false}
        updatedAt={Date.now()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "账户剩余限额 8%" });
    expect(trigger).toHaveAttribute("data-attention", "danger");
    fireEvent.click(trigger);
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--z-popover")
        .trim(),
    ).toBe("40");
    expect(screen.getByRole("progressbar", { name: /剩余 8%/u })).toHaveAttribute("aria-valuenow", "8");
    expect(screen.getByText("套餐 plus")).toBeVisible();
  });

  it("读取失败时展示未知圆环和刷新入口", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    render(<RateLimitIndicator data={null} error="无法读取账户限额" loading={false} onRefresh={onRefresh} refreshing={false} updatedAt={null} />);

    fireEvent.click(screen.getByRole("button", { name: "账户剩余限额未知" }));
    expect(screen.getByText("无法读取账户限额")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("可用重置次数大于 0 时展示重置限额按钮且点击时触发回调", () => {
    const onConsumeResetCredit = vi.fn(() => Promise.resolve());
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    try {
      render(
        <RateLimitIndicator
          data={{
            rateLimits: { planType: "plus", primary: { usedPercent: 80 } },
            rateLimitResetCredits: { availableCount: 3, credits: null },
          }}
          error={null}
          loading={false}
          onRefresh={vi.fn()}
          refreshing={false}
          updatedAt={Date.now()}
          onConsumeResetCredit={onConsumeResetCredit}
          resetting={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /账户剩余限额/u }));

      const resetButton = screen.getByRole("button", { name: "重置限额" });
      expect(resetButton).toBeVisible();

      fireEvent.click(resetButton);
      expect(window.confirm).toHaveBeenCalledWith("确定要消耗一次重置次数来重置账户限额吗？");
      expect(onConsumeResetCredit).toHaveBeenCalledOnce();
    } finally {
      window.confirm = originalConfirm;
    }
  });
});
