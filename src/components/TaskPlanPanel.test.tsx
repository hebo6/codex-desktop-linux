import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActiveTurnPlan } from "../app/useTurnPlan";
import { ComposerAccessoryPanel } from "./ComposerAccessoryPanel";
import { TaskPlanPanel } from "./TaskPlanPanel";

const PLAN = {
  explanation: "先完成实现，再统一验证",
  steps: [
    { status: "completed", step: "确认协议" },
    { status: "inProgress", step: "实现附着容器" },
    { status: "pending", step: "运行测试" },
  ],
  turnId: "turn-1",
} satisfies ActiveTurnPlan;

describe("TaskPlanPanel", () => {
  it("折叠态展示剩余任务和当前步骤，展开后展示完整计划", async () => {
    render(
      <ComposerAccessoryPanel>
        <TaskPlanPanel plan={PLAN} />
      </ComposerAccessoryPanel>,
    );

    const summary = screen.getByRole("button", {
      name: "任务计划 · 剩余 2 项 · 实现附着容器",
    });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(summary);

    expect(summary).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => {
      expect(screen.getByText("先完成实现，再统一验证")).toBeVisible();
    });
    expect(screen.getByText("确认协议")).toBeVisible();
    expect(screen.getByText("实现附着容器")).toBeVisible();
    expect(screen.getByText("运行测试")).toBeVisible();
  });

  it("没有任务计划时隐藏空附着容器", () => {
    render(
      <ComposerAccessoryPanel>
        <TaskPlanPanel plan={null} />
      </ComposerAccessoryPanel>,
    );

    expect(screen.queryByRole("region", { name: "任务计划" }))
      .not.toBeInTheDocument();
    expect(document.querySelector("[data-composer-accessory-panel]"))
      .not.toBeVisible();
  });
});
