import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnsiCommandOutput } from "./AnsiCommandOutput";

describe("AnsiCommandOutput", () => {
  it("将 ANSI 样式渲染为安全的 React 节点", () => {
    render(
      <AnsiCommandOutput
        aria-label="命令输出"
        output={
          "\u001b[1;31m失败\u001b[0m " +
          "\u001b[38;5;196;48;2;1;2;3m详情\u001b[0m" +
          "\u001b]8;;javascript:alert(1)\u0007不可点击\u001b]8;;\u0007"
        }
      />,
    );

    expect(screen.getByLabelText("命令输出")).toHaveTextContent(
      "失败 详情不可点击",
    );
    expect(screen.getByText("失败")).toHaveStyle({
      color: "var(--ansi-color-1)",
      fontWeight: "600",
    });
    expect(screen.getByText("详情")).toHaveStyle({
      backgroundColor: "rgb(1 2 3)",
      color: "rgb(255 0 0)",
    });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("没有样式时不创建多余节点", () => {
    const { container } = render(
      <AnsiCommandOutput output="普通输出" />,
    );

    expect(container.querySelector("samp")).toHaveTextContent("普通输出");
    expect(container.querySelector("samp > span")).not.toBeInTheDocument();
  });
});
