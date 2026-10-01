import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { overflowTitleProps } from "./overflowTitle";

describe("overflowTitleProps", () => {
  it("悬浮时仅对被截断的文字提供全文，变宽后清除提示", () => {
    const label = "子代理 · started · /root/image_loader_tests";
    render(<div {...overflowTitleProps}>{label}</div>);
    const line = screen.getByText(label);
    const width = vi.spyOn(line, "clientWidth", "get").mockReturnValue(400);
    vi.spyOn(line, "scrollWidth", "get").mockReturnValue(400);

    fireEvent.mouseEnter(line);
    expect(line.title).toBe("");
    fireEvent.mouseLeave(line);

    width.mockReturnValue(200);
    fireEvent.mouseEnter(line);
    expect(line.title).toBe(label);
    fireEvent.mouseLeave(line);

    width.mockReturnValue(500);
    fireEvent.mouseEnter(line);
    expect(line.title).toBe("");
  });

  it("聚焦时读取最新文字，保留按钮的名称和点击操作", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <button {...overflowTitleProps} onClick={onClick}>查看图片 · /remote/old.png</button>,
    );
    const button = screen.getByRole("button", { name: "查看图片 · /remote/old.png" });
    vi.spyOn(button, "clientWidth", "get").mockReturnValue(100);
    vi.spyOn(button, "scrollWidth", "get").mockReturnValue(300);
    fireEvent.focus(button);
    expect(button.title).toBe("查看图片 · /remote/old.png");
    fireEvent.blur(button);

    rerender(
      <button {...overflowTitleProps} onClick={onClick}>查看图片 · /remote/new.png</button>,
    );
    fireEvent.focus(button);
    expect(button.title).toBe("查看图片 · /remote/new.png");
    expect(button).toHaveAccessibleName("查看图片 · /remote/new.png");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
