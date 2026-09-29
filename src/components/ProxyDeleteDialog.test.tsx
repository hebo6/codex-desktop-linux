import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ProxyId, ProxyProfile } from "../configuration";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { ProxyDeleteDialog } from "./ProxyDeleteDialog";

const PROXY: ProxyProfile = {
  proxyId: "11111111-1111-4111-8111-111111111111" as ProxyId,
  name: "开发代理",
  version: 1,
  configuration: {
    type: "socks5",
    host: "127.0.0.1",
    port: 1080,
    authentication: "none",
    dnsResolution: "proxy",
    connectTimeoutMs: 30_000,
  },
  credentialConfigured: false,
  referencedServerCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function createProps(
  overrides: Partial<ComponentProps<typeof ProxyDeleteDialog>> = {},
): ComponentProps<typeof ProxyDeleteDialog> {
  return {
    proxy: PROXY,
    servers: [],
    deleting: false,
    error: null,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe("ProxyDeleteDialog", () => {
  it("限制焦点在删除确认中，Esc 关闭后恢复触发器焦点", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)} type="button">删除代理配置</button>
        <ProxyDeleteDialog {...createProps({
          proxy: open ? PROXY : null,
          onCancel: () => setOpen(false),
        })} />
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "删除代理配置" });
    await user.click(trigger);
    const cancel = screen.getByRole("button", { name: "取消" });
    const confirm = screen.getByRole("button", { name: "确认删除" });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("叠放在另一模态之上时，Esc 仅关闭代理删除确认", () => {
    const onCloseLower = vi.fn();
    const onCancel = vi.fn();
    const view = (proxy: ProxyProfile | null) => <>
      <KeyboardShortcutsDialog onClose={onCloseLower} open />
      <ProxyDeleteDialog {...createProps({ proxy, onCancel })} />
    </>;
    const { rerender } = render(view(null));
    const lowerSearch = screen.getByRole("searchbox", { name: "搜索键盘快捷键" });
    expect(lowerSearch).toHaveFocus();
    rerender(view(PROXY));
    fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCloseLower).not.toHaveBeenCalled();
    rerender(view(null));
    expect(lowerSearch).toHaveFocus();
  });

  it.each(["已处理", "输入法合成", "长按重复"])("忽略%s的 Esc", (reason) => {
    const onCancel = vi.fn();
    render(<ProxyDeleteDialog {...createProps({ onCancel })} />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
      isComposing: reason === "输入法合成",
      repeat: reason === "长按重复",
    });
    if (reason === "已处理") event.preventDefault();
    fireEvent(screen.getByRole("button", { name: "取消" }), event);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "altKey", "metaKey"])("不将带 %s 的 Tab 当作焦点导航", (modifier) => {
    render(<ProxyDeleteDialog {...createProps()} />);
    const confirm = screen.getByRole("button", { name: "确认删除" });
    confirm.focus();
    expect(fireEvent.keyDown(confirm, { key: "Tab", [modifier]: true })).toBe(true);
    expect(confirm).toHaveFocus();
  });

  it("删除期间消费 Esc、保留模态焦点，并在完成后恢复取消按钮", () => {
    const onCancel = vi.fn();
    const props = createProps({ onCancel, deleting: true });
    const { rerender } = render(<ProxyDeleteDialog {...props} />);
    const dialog = screen.getByRole("alertdialog", { name: "删除代理" });
    expect(dialog).toHaveFocus();
    expect(fireEvent.keyDown(dialog, { key: "Escape" })).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(false);
    expect(dialog).toHaveFocus();
    rerender(<ProxyDeleteDialog {...props} deleting={false} />);
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  });
});
