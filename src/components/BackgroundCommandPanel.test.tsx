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
        onTerminateAll={vi.fn(async () => undefined)}
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
      aggregatedOutput:
        "第一行输出\n第二行输出\n\u001b[32m最后一行输出\u001b[0m\n",
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
        onTerminateAll={vi.fn(async () => undefined)}
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
    expect(screen.getByLabelText("命令输出")).toHaveTextContent(
      "第一行输出 第二行输出 最后一行输出",
    );
    expect(screen.getByText("最后一行输出")).toHaveStyle({
      color: "var(--ansi-color-2)",
    });
  });

  it("可以终止当前会话中的所有运行命令", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00Z"));
    const termination = deferred<void>();
    const onTerminateAll = vi.fn(() => termination.promise);
    const commands = [
      {
        command: "sleep 60",
        commandActions: [] as never[],
        cwd: "/workspace/project",
        durationMs: 3_000,
        id: "command-running-1",
        processId: "42",
        status: "inProgress",
        type: "commandExecution",
      },
      {
        command: "pnpm test",
        commandActions: [] as never[],
        cwd: "/workspace/project",
        durationMs: 3_000,
        id: "command-running-2",
        processId: "43",
        status: "inProgress",
        type: "commandExecution",
      },
    ] as const;

    render(
      <BackgroundCommandPanel
        error={null}
        loaded
        onLocate={vi.fn()}
        onTerminate={vi.fn()}
        onTerminateAll={onTerminateAll}
        terminals={commands.map((command) => ({
          command: command.command,
          cwd: command.cwd,
          itemId: command.id,
          observedAt: Date.now(),
          processId: command.processId,
        }))}
        terminatingProcessIds={new Set()}
        turns={[{
          id: "turn-running",
          items: [...commands],
          itemsView: "full",
          status: "inProgress",
        }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: /2 个命令正在运行/u,
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "终止所有命令",
    }));

    expect(onTerminateAll).toHaveBeenCalledWith(["42", "43"]);
    expect(screen.getByRole("button", {
      name: "正在终止所有命令",
    })).toBeDisabled();

    await act(async () => {
      termination.resolve();
      await termination.promise;
    });

    expect(screen.getByRole("button", {
      name: "终止所有命令",
    })).toBeEnabled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
