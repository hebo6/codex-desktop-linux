import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TabCloseDialog } from "./TabCloseDialog";

describe("TabCloseDialog", () => {
  it("说明未发送内容风险并允许确认关闭", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <TabCloseDialog
        closing={false}
        confirmation={{ draftCount: 2, kind: "others", tabCount: 3 }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole("dialog", { name: "关闭多个标签页？" }))
      .toHaveTextContent("确定要关闭其他 3 个标签页吗？");
    expect(screen.getByText(/其中 2 个新任务包含未发送内容/u))
      .toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "仍然关闭" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
