import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackgroundCommandPanel } from "./BackgroundCommandPanel";

afterEach(() => {
  vi.useRealTimers();
});

describe("BackgroundCommandPanel", () => {
  it("命令运行满三秒后才显示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00Z"));
    const observedAt = Date.now();
    const command = {
      id: "command-running",
      type: "commandExecution",
      command: "sleep 60",
      commandActions: [] as never[],
      cwd: "/workspace/project",
      durationMs: 0,
      processId: "42",
      status: "inProgress",
    } as const;

    render(
      <BackgroundCommandPanel
        error={null}
        loaded
        onLocate={vi.fn()}
        onTerminate={vi.fn()}
        terminals={[{
          command: command.command,
          cwd: command.cwd,
          itemId: command.id,
          observedAt,
          processId: command.processId,
        }]}
        terminatingProcessIds={new Set()}
        turns={[{
          id: "turn-completed",
          items: [command],
          itemsView: "full",
          status: "completed",
        }]}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "运行中命令" }),
    ).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2_999));
    expect(
      screen.queryByRole("region", { name: "运行中命令" }),
    ).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(
      screen.getByRole("region", { name: "运行中命令" }),
    ).toBeVisible();
  });

  it("展开后显示完整命令和聚合输出", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00Z"));
    const observedAt = Date.now();
    const command = {
      aggregatedOutput: "第一行输出\n第二行输出\n最后一行输出\n",
      command: "pnpm test -- --runInBand && pnpm build",
      commandActions: [] as never[],
      cwd: "/workspace/project",
      durationMs: 0,
      id: "command-running",
      processId: "42",
      status: "inProgress",
      type: "commandExecution",
    } as const;

    render(
      <BackgroundCommandPanel
        error={null}
        loaded
        onLocate={vi.fn()}
        onTerminate={vi.fn()}
        terminals={[{
          command: command.command,
          cwd: command.cwd,
          itemId: command.id,
          observedAt,
          processId: command.processId,
        }]}
        terminatingProcessIds={new Set()}
        turns={[{
          id: "turn-running",
          items: [command],
          itemsView: "full",
          status: "inProgress",
        }]}
      />,
    );

    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.click(screen.getByRole("button", {
      name: /1 个命令正在运行/u,
    }));

    expect(screen.getByText(command.command)).toBeVisible();
    expect(screen.getByLabelText("命令输出").textContent).toBe(
      command.aggregatedOutput,
    );
  });
});
