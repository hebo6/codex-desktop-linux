import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExternalLinkDialog } from "./ExternalLinkDialog";

describe("ExternalLinkDialog", () => {
  it("展示规范化网页并可仅在本次运行信任域名", () => {
    const onConfirm = vi.fn();
    render(
      <ExternalLinkDialog
        link={{ type: "external", domain: "example.com", url: "https://example.com/path" }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        opening={false}
      />,
    );
    expect(screen.getByText("https://example.com/path")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "本次运行期间信任此域名" }));
    fireEvent.click(screen.getByRole("button", { name: "打开网页" }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("将键盘焦点限制在最上层对话框", () => {
    render(
      <ExternalLinkDialog
        link={{ type: "external", domain: "example.com", url: "https://example.com" }}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        opening={false}
      />,
    );
    const trust = screen.getByRole("checkbox", { name: "本次运行期间信任此域名" });
    const cancel = screen.getByRole("button", { name: "取消" });
    const open = screen.getByRole("button", { name: "打开网页" });
    expect(cancel).toHaveFocus();
    open.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(trust).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(open).toHaveFocus();
  });
});
