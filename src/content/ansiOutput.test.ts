import { describe, expect, it } from "vitest";

import { parseAnsiOutput } from "./ansiOutput";

describe("parseAnsiOutput", () => {
  it("保留普通文本并合并相同样式", () => {
    expect(parseAnsiOutput("第一行\r\n第二行\t完成\u0007")).toEqual([{
      style: defaultStyle(),
      text: "第一行\n第二行\t完成",
    }]);
  });

  it("解析常用样式并分别重置", () => {
    expect(
      parseAnsiOutput(
        "\u001b[1;2;3;4;7;9m样式\u001b[22;23;24;27;29m普通",
      ),
    ).toEqual([
      {
        style: {
          ...defaultStyle(),
          bold: true,
          dim: true,
          inverse: true,
          italic: true,
          strikethrough: true,
          underline: true,
        },
        text: "样式",
      },
      {
        style: defaultStyle(),
        text: "普通",
      },
    ]);
  });

  it("解析基础色、256 色和 True Color", () => {
    expect(
      parseAnsiOutput(
        "\u001b[31;104m基础\u001b[38;5;196;48;2;1;2;3m扩展" +
          "\u001b[38:2::4:5:6;48:5:231m冒号\u001b[0m结束",
      ),
    ).toEqual([
      {
        style: {
          ...defaultStyle(),
          background: { index: 12, kind: "basic" },
          foreground: { index: 1, kind: "basic" },
        },
        text: "基础",
      },
      {
        style: {
          ...defaultStyle(),
          background: { blue: 3, green: 2, kind: "rgb", red: 1 },
          foreground: { index: 196, kind: "indexed" },
        },
        text: "扩展",
      },
      {
        style: {
          ...defaultStyle(),
          background: { index: 231, kind: "indexed" },
          foreground: { blue: 6, green: 5, kind: "rgb", red: 4 },
        },
        text: "冒号",
      },
      {
        style: defaultStyle(),
        text: "结束",
      },
    ]);
  });

  it("移除非样式控制序列和 OSC 链接元数据", () => {
    expect(
      parseAnsiOutput(
        "前\u001b[2K中" +
          "\u001b]8;;javascript:alert(1)\u0007链接\u001b]8;;\u001b\\" +
          "\u009b31m红\u009b0m后",
      ).map(({ text }) => text).join(""),
    ).toBe("前中链接红后");
  });

  it("丢弃未结束的控制序列", () => {
    expect(parseAnsiOutput("保留\u001b[38;2;255")).toEqual([{
      style: defaultStyle(),
      text: "保留",
    }]);
  });
});

function defaultStyle() {
  return {
    background: null,
    bold: false,
    dim: false,
    foreground: null,
    inverse: false,
    italic: false,
    strikethrough: false,
    underline: false,
  };
}
