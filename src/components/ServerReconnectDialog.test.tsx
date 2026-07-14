import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ServerReconnectDialog,
  type ServerReconnectDialogProps,
} from "./ServerReconnectDialog";

function createProps(
  overrides: Partial<ServerReconnectDialogProps> = {},
): ServerReconnectDialogProps {
  return {
    serverName: "生产环境",
    onReconnect: vi.fn(),
    onLater: vi.fn(),
    ...overrides,
  };
}

describe("ServerReconnectDialog", () => {
  it("没有待处理服务器时不渲染", () => {
    render(<ServerReconnectDialog {...createProps({ serverName: null })} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("说明新配置生效方式并默认聚焦立即重连", () => {
    render(<ServerReconnectDialog {...createProps()} />);

    const dialog = screen.getByRole("dialog", { name: "立即重连服务器？" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/现有连接仍在使用保存前的配置/u);
    expect(within(dialog).getByText(/生产环境/u)).toBeVisible();
    expect(within(dialog).getByText(/影响所有共享该连接的窗口/u)).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "立即重连" }),
    ).toHaveFocus();
  });

  it("分别提交立即重连和稍后应用选择", () => {
    const onReconnect = vi.fn();
    const onLater = vi.fn();
    render(
      <ServerReconnectDialog {...createProps({ onReconnect, onLater })} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "立即重连" }));
    fireEvent.click(screen.getByRole("button", { name: "稍后应用" }));

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onLater).toHaveBeenCalledTimes(1);
  });

  it("将 Escape 和遮罩关闭解释为稍后应用", () => {
    const onLater = vi.fn();
    render(<ServerReconnectDialog {...createProps({ onLater })} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onLater).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    expect(onLater).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(dialog.parentElement!);
    expect(onLater).toHaveBeenCalledTimes(2);
  });

  it("将焦点限制在模态框内并在关闭后恢复触发器焦点", async () => {
    const user = userEvent.setup();

    function FocusHarness() {
      const [serverName, setServerName] = useState<string | null>(null);
      return (
        <>
          <button onClick={() => setServerName("生产环境")} type="button">
            保存服务器
          </button>
          <ServerReconnectDialog
            onLater={() => setServerName(null)}
            onReconnect={() => setServerName(null)}
            serverName={serverName}
          />
        </>
      );
    }

    render(<FocusHarness />);
    const opener = screen.getByRole("button", { name: "保存服务器" });
    await user.click(opener);
    const laterButton = screen.getByRole("button", { name: "稍后应用" });
    const reconnectButton = screen.getByRole("button", {
      name: "立即重连",
    });
    expect(reconnectButton).toHaveFocus();

    await user.tab();
    expect(laterButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(reconnectButton).toHaveFocus();

    await user.click(laterButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("叠放时仅由最上层弹窗处理 Escape", () => {
    const lowerLater = vi.fn();
    const upperLater = vi.fn();
    const { rerender } = render(
      <>
        <ServerReconnectDialog
          onLater={lowerLater}
          onReconnect={vi.fn()}
          serverName="下层服务器"
        />
        <ServerReconnectDialog
          onLater={upperLater}
          onReconnect={vi.fn()}
          serverName="上层服务器"
        />
      </>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(lowerLater).not.toHaveBeenCalled();
    expect(upperLater).toHaveBeenCalledTimes(1);

    rerender(
      <ServerReconnectDialog
        onLater={lowerLater}
        onReconnect={vi.fn()}
        serverName="下层服务器"
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(lowerLater).toHaveBeenCalledTimes(1);
  });
});
