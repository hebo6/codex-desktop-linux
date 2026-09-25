import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../styles/tokens.css";
import { RateLimitIndicator } from "./RateLimitIndicator";

describe("RateLimitIndicator", () => {
  it("Alt+L 与点击共用开关状态，长按不重复切换，关闭后保留可用焦点", () => {
    const { unmount } = render(
      <RateLimitIndicator data={null} error={null} loading={false} onRefresh={vi.fn()} refreshing={false} updatedAt={null} />,
    );
    const trigger = screen.getByRole("button", { name: "账户剩余限额未知" });
    expect(trigger).toHaveAttribute("aria-keyshortcuts", "Alt+L");

    expect(fireEvent.keyDown(window, { altKey: true, key: "l" })).toBe(false);
    expect(screen.getByRole("dialog", { name: "账户剩余限额详情" })).toBeVisible();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { altKey: true, key: "l", repeat: true });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const refresh = screen.getByRole("button", { name: "刷新" });
    refresh.focus();
    fireEvent.keyDown(refresh, { altKey: true, key: "L" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { altKey: true, key: "l" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { altKey: true, key: "l" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { altKey: true, key: "l" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(window, { altKey: true, key: "l" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    unmount();
    expect(fireEvent.keyDown(window, { altKey: true, key: "l" })).toBe(true);
  });

  it.each([
    { altKey: false },
    { ctrlKey: true },
    { shiftKey: true },
    { metaKey: true },
    { isComposing: true },
    { repeat: true },
    { key: "u" },
  ])("不响应其他组合、输入法合成或重复事件：%j", (overrides) => {
    render(
      <RateLimitIndicator data={null} error={null} loading={false} onRefresh={vi.fn()} refreshing={false} updatedAt={null} />,
    );

    fireEvent.keyDown(window, { altKey: true, key: "l", ...overrides });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("不响应已被其他控件处理的快捷键", () => {
    render(
      <RateLimitIndicator data={null} error={null} loading={false} onRefresh={vi.fn()} refreshing={false} updatedAt={null} />,
    );
    const event = new KeyboardEvent("keydown", { altKey: true, key: "l", cancelable: true });
    event.preventDefault();

    fireEvent(window, event);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("圆环优先展示普通 5 小时限额，详情展示所有窗口", () => {
    render(
      <RateLimitIndicator
        accountEmail="alice@example.com"
        data={{
          rateLimits: { planType: "plus", primary: { usedPercent: 20 } },
          rateLimitsByLimitId: {
            spark: {
              limitName: "GPT-5.3-Codex-Spark",
              planType: "plus",
              primary: { usedPercent: 10, windowDurationMins: 300 },
            },
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

    const trigger = screen.getByRole("button", { name: "账户剩余限额 85%" });
    expect(trigger).toHaveAttribute("data-attention", "normal");
    expect(trigger).toHaveAttribute("title", "Codex · 5 小时窗口剩余 85%（Alt+L）");
    fireEvent.click(trigger);
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue("--z-popover")
        .trim(),
    ).toBe("40");
    expect(screen.getByRole("progressbar", { name: /剩余 8%/u })).toHaveAttribute("aria-valuenow", "8");
    expect(screen.getByRole("progressbar", { name: "GPT-5.3-Codex-Spark · 5 小时窗口剩余 90%" })).toBeVisible();
    expect(screen.getByText("alice@example.com · 套餐 plus")).toBeVisible();
  });

  it.each([false, true])("普通周限额优先于 Spark 5 小时和周限额，普通限额先返回：%s", (codexFirst) => {
    const codex = {
      limitName: "Codex",
      secondary: { usedPercent: 35, windowDurationMins: 10_080 },
    };
    const spark = {
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 5, windowDurationMins: 10_080 },
    };
    const { container } = render(
      <RateLimitIndicator
        data={{
          rateLimits: codex,
          rateLimitsByLimitId: codexFirst ? { codex, spark } : { spark, codex },
        }}
        error={null}
        loading={false}
        onRefresh={vi.fn()}
        refreshing={false}
        updatedAt={null}
      />,
    );

    const trigger = screen.getByRole("button", { name: "账户剩余限额 65%" });
    expect(trigger).toHaveTextContent("65");
    expect(trigger).toHaveAttribute("title", "Codex · 7 天窗口剩余 65%（Alt+L）");
    expect(container.querySelector('circle[pathLength="100"]')).toHaveAttribute("stroke-dasharray", "65 35");
    fireEvent.click(trigger);
    expect(screen.getByRole("progressbar", { name: "Codex · 7 天窗口剩余 65%" })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "GPT-5.3-Codex-Spark · 5 小时窗口剩余 90%" })).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "GPT-5.3-Codex-Spark · 7 天窗口剩余 95%" })).toBeVisible();
  });

  it("读取失败时展示未知圆环和刷新入口", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    render(<RateLimitIndicator data={null} error="无法读取账户限额" loading={false} onRefresh={onRefresh} refreshing={false} updatedAt={null} />);

    fireEvent.click(screen.getByRole("button", { name: "账户剩余限额未知" }));
    expect(screen.getByText("无法读取账户限额")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it.each([
    [0, "刚刚"],
    [1_500, "1秒前"],
    [59_999, "59秒前"],
    [60_000, "1分钟前"],
    [3_599_999, "59分钟前"],
    [3_600_000, "1小时前"],
    [86_399_999, "23小时前"],
    [86_400_000, "1天前"],
    [3 * 86_400_000, "3天前"],
  ])("经过 %i 毫秒时显示更新时间 %s", (elapsedMs, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));

    try {
      const updatedAt = Date.now() - elapsedMs;
      const { unmount } = render(
        <RateLimitIndicator
          data={null}
          error={null}
          loading={false}
          onRefresh={vi.fn()}
          refreshing={false}
          updatedAt={updatedAt}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "账户剩余限额未知" }));

      const time = screen.getByText(expected, { selector: "time" });
      expect(time.closest("footer")).toHaveTextContent(`更新于 ${expected}`);
      expect(time).toHaveAttribute("dateTime", new Date(updatedAt).toISOString());
      expect(time).toHaveAttribute("title", new Date(updatedAt).toLocaleString());
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("打开时自动更新相对时间，关闭时停止计时，再次打开和收到新数据时重新计算", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));

    try {
      const props = {
        data: null,
        error: null,
        loading: false,
        onRefresh: vi.fn(),
        refreshing: false,
        updatedAt: Date.now() - 59_000,
      };
      const { rerender, unmount } = render(<RateLimitIndicator {...props} />);
      const trigger = screen.getByRole("button", { name: "账户剩余限额未知" });
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.click(trigger);
      expect(screen.getByText("59秒前")).toBeVisible();

      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText("1分钟前")).toBeVisible();

      fireEvent.click(trigger);
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.advanceTimersByTime(60_000));
      fireEvent.click(trigger);
      expect(screen.getByText("2分钟前")).toBeVisible();

      rerender(<RateLimitIndicator {...props} updatedAt={Date.now()} />);
      expect(screen.getByText("刚刚")).toBeVisible();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText("1秒前")).toBeVisible();

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("补齐最近 14 个自然日并将无消耗日期记为 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 24, 12));

    try {
      const { container } = render(
        <RateLimitIndicator
          data={{ rateLimits: { planType: "plus", primary: { usedPercent: 20 } } }}
          error={null}
          loading={false}
          onRefresh={vi.fn()}
          refreshing={false}
          tokenUsageData={{
            dailyUsageBuckets: [
              { startDate: "2026-08-22", tokens: 200 },
              { startDate: "2026-08-24", tokens: 400 },
            ],
            summary: {},
          }}
          updatedAt={null}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /账户剩余限额/u }));

      const days = container.querySelectorAll('svg[viewBox="0 0 320 85"] > g');
      expect(days).toHaveLength(14);
      expect(screen.getByText("08-23")).toBeVisible();

      fireEvent.mouseEnter(days[12]!);
      expect(screen.getByText("0 tokens")).toBeVisible();
      expect(days[12]!.querySelectorAll("rect")[1]).toHaveAttribute("height", "0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("可用重置次数大于 0 时支持折叠展开，并在无详情时显示快速重置", () => {
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

      const headerButton = screen.getByRole("button", { name: /可用限额重置次数 3/u });
      expect(headerButton).toBeVisible();
      expect(screen.queryByText("暂无详细凭证信息")).toBeNull();

      fireEvent.click(headerButton);
      expect(screen.getByText("暂无详细凭证信息")).toBeVisible();

      const quickResetButton = screen.getByRole("button", { name: "快速重置" });
      expect(quickResetButton).toBeVisible();

      fireEvent.click(quickResetButton);
      expect(window.confirm).toHaveBeenCalledWith("确定要消耗一次重置次数来重置账户限额吗？");
      expect(onConsumeResetCredit).toHaveBeenCalledOnce();
      expect(onConsumeResetCredit).toHaveBeenCalledWith();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it("可用重置次数大于 0 且包含详情时，展开并支持针对特定凭证重置", () => {
    const onConsumeResetCredit = vi.fn(() => Promise.resolve());
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);

    try {
      render(
        <RateLimitIndicator
          data={{
            rateLimits: { planType: "plus", primary: { usedPercent: 80 } },
            rateLimitResetCredits: {
              availableCount: 2,
              credits: [
                {
                  id: "credit-123",
                  status: "available",
                  resetType: "codexRateLimits",
                  title: "新用户福利凭证",
                  description: "赠送的限额重置凭证",
                  grantedAt: Math.floor(Date.now() / 1000),
                  expiresAt: Math.floor(Date.now() / 1000) + 3600,
                },
              ],
            },
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

      fireEvent.click(screen.getByRole("button", { name: /可用限额重置次数 2/u }));

      expect(screen.getByText("新用户福利凭证")).toBeVisible();
      expect(screen.getByText("赠送的限额重置凭证")).toBeVisible();

      const useButton = screen.getByRole("button", { name: "使用" });
      expect(useButton).toBeVisible();

      fireEvent.click(useButton);
      expect(window.confirm).toHaveBeenCalledWith("确定要使用凭证“新用户福利凭证”重置限额吗？");
      expect(onConsumeResetCredit).toHaveBeenCalledOnce();
      expect(onConsumeResetCredit).toHaveBeenCalledWith("credit-123");
    } finally {
      window.confirm = originalConfirm;
    }
  });
});
