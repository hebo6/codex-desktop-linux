import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlaintextCredentialConfirmDialog } from "./PlaintextCredentialConfirmDialog";

describe("PlaintextCredentialConfirmDialog", () => {
  it("确认前明确说明明文风险", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlaintextCredentialConfirmDialog
        onCancel={onCancel}
        onConfirm={onConfirm}
        open
      />,
    );

    expect(
      screen.getByRole("alertdialog", { name: "使用明文文件保存凭据？" }),
    ).toHaveTextContent("本次凭据将不加密地写入应用数据目录");
    expect(screen.getByRole("button", { name: "返回编辑" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "确认使用明文文件" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("按 Escape 返回编辑且不确认", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <PlaintextCredentialConfirmDialog
        onCancel={onCancel}
        onConfirm={onConfirm}
        open
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
