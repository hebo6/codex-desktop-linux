import { act, render, screen } from "@testing-library/react";
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
      commandActions: [],
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
});
