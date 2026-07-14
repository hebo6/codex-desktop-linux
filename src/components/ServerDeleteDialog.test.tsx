import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ServerId, ServerProfile } from "../configuration";
import {
  ServerDeleteDialog,
  type ServerDeleteDialogProps,
} from "./ServerDeleteDialog";

const SERVER_ID = "f2eb0af3-9330-4f17-a96f-7c708aae3333" as ServerId;

function server(): ServerProfile {
  return {
    serverId: SERVER_ID,
    name: "生产环境",
    version: 7,
    configuration: {
      type: "remoteWebSocket",
      url: "wss://codex.example.test/app-server",
      authentication: "none",
      nonSensitiveHeaders: {},
      connectTimeoutMs: 10_000,
      tlsCertificatePolicy: "strict",
      plaintextConfirmed: false,
    },
    credentialConfigured: false,
    activeWindowCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function createProps(
  overrides: Partial<ServerDeleteDialogProps> = {},
): ServerDeleteDialogProps {
  return {
    server: server(),
    affectedWindowCount: 0,
    checkingWindowReferences: false,
    saving: false,
    errorSummary: null,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe("ServerDeleteDialog", () => {
  it("没有待删除服务器时不渲染", () => {
    render(<ServerDeleteDialog {...createProps({ server: null })} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("说明删除范围并将初始焦点放在取消按钮", () => {
    render(<ServerDeleteDialog {...createProps()} />);

    const dialog = screen.getByRole("dialog", { name: "删除服务器？" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(
      /只会删除此设备上的连接配置和已保存凭据/,
    );
    expect(within(dialog).getByText(/生产环境/)).toBeVisible();
    expect(
      within(dialog).getByText(
        "只会删除此设备上的连接配置和已保存凭据，不会删除服务端会话或任何远程文件",
      ),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(
      getComputedStyle(
        within(dialog).getByRole("button", { name: "删除服务器" }),
      ).color,
    ).toBe("rgb(255, 255, 255)");
  });

  it("将焦点限制在模态框内并在关闭后恢复触发器焦点", async () => {
    const user = userEvent.setup();

    function FocusHarness() {
      const [selectedServer, setSelectedServer] =
        useState<ServerProfile | null>(null);
      return (
        <>
          <button onClick={() => setSelectedServer(server())} type="button">
            打开删除确认
          </button>
          <ServerDeleteDialog
            {...createProps({
              server: selectedServer,
              onCancel: () => setSelectedServer(null),
            })}
          />
        </>
      );
    }

    render(<FocusHarness />);
    const opener = screen.getByRole("button", { name: "打开删除确认" });
    await user.click(opener);
    const cancelButton = screen.getByRole("button", { name: "取消" });
    const deleteButton = screen.getByRole("button", { name: "删除服务器" });
    expect(cancelButton).toHaveFocus();

    await user.tab();
    expect(deleteButton).toHaveFocus();
    await user.tab();
    expect(cancelButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(deleteButton).toHaveFocus();

    await user.click(cancelButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("确认时提交服务器标识和预期版本", () => {
    const onConfirm = vi.fn();
    render(<ServerDeleteDialog {...createProps({ onConfirm })} />);

    fireEvent.click(screen.getByRole("button", { name: "删除服务器" }));

    expect(onConfirm).toHaveBeenCalledWith(SERVER_ID, 7);
  });

  it("允许通过取消按钮、Esc 和遮罩取消", () => {
    const onCancel = vi.fn();
    render(<ServerDeleteDialog {...createProps({ onCancel })} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onCancel).toHaveBeenCalledTimes(2);

    fireEvent.click(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("保存期间禁止确认和所有关闭方式", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ServerDeleteDialog
        {...createProps({ saving: true, onCancel, onConfirm })}
      />,
    );

    const cancelButton = screen.getByRole("button", { name: "取消" });
    const confirmButton = screen.getByRole("button", { name: "正在删除" });
    expect(cancelButton).toBeDisabled();
    expect(confirmButton).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("dialog")).toHaveFocus();

    fireEvent.click(cancelButton);
    fireEvent.click(confirmButton);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("服务器使用中说明解除方式并禁用确认", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ServerDeleteDialog
        {...createProps({
          affectedWindowCount: 3,
          onCancel,
          onConfirm,
        })}
      />,
    );

    expect(screen.getByText("此服务器正被 3 个窗口使用")).toBeVisible();
    expect(
      screen.getByText(
        "必须先关闭相关窗口或将这些窗口切换到其他服务器，然后才能删除",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "删除服务器" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("刷新窗口引用期间保留取消能力并锁定确认", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ServerDeleteDialog
        {...createProps({
          checkingWindowReferences: true,
          onCancel,
          onConfirm,
        })}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "正在确认" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("展示删除错误", () => {
    render(
      <ServerDeleteDialog
        {...createProps({ errorSummary: "删除服务器失败" })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("删除服务器失败");
  });
});
