import type { Root, RootContent } from "mdast";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { remarkMathDelimiters } from "./remarkMathDelimiters";

const processor = unified().use(remarkParse).use(remarkMath).use(remarkMathDelimiters);
const parse = (source: string): Root => processor.parse(source);

function descendants(node: Root | RootContent): RootContent[] {
  return "children" in node
    ? node.children.flatMap((child) => [child, ...descendants(child)])
    : [];
}

const formulas = (source: string) => descendants(parse(source))
  .filter((node) => node.type === "math" || node.type === "inlineMath")
  .map(({ type, value }) => ({ type, value }));

const text = (source: string) => descendants(parse(source))
  .filter((node) => node.type === "text")
  .map((node) => node.value).join("");

describe("remarkMathDelimiters", () => {
  it("与标准美元分隔符共用数学节点", () => {
    expect(formulas(String.raw`$a$ 和 \(b^2\)` + "\n\n$$\nc\n$$\n\n\\[\nd\n\\]"))
      .toEqual([
        { type: "inlineMath", value: "a" },
        { type: "inlineMath", value: "b^2" },
        { type: "math", value: "c" },
        { type: "math", value: "d" },
      ]);
  });

  it("解析截图中的多行公式并保留 LaTeX 指令", () => {
    const value = String.raw`\underbrace{2 \times 2 \times \cdots \times 2}_{n\text{ 个}} = 2^n`;
    expect(formulas(`因为每座塔有两种状态\n\\[\n${value}\n\\]\n例如三座塔`))
      .toEqual([{ type: "math", value }]);
  });

  it("支持独占一行的块公式以及行尾空白", () => {
    expect(formulas("\\[ 2^n \\]  \n下一行")).toEqual([{ type: "math", value: "2^n" }]);
    expect(formulas(String.raw`前文 \[2^n\] 后文`)).toEqual([]);
    expect(formulas(String.raw`\[2^n\] 后文`)).toEqual([]);
  });

  it("代码与转义分隔符不会产生数学节点", () => {
    const source = [
      "`" + String.raw`\(a\)` + "`",
      "```latex",
      String.raw`\[b\]`,
      "```",
      "",
      String.raw`    \[c\]`,
      "",
      String.raw`\\(d\\) 和 \\[e\\]`,
    ].join("\n");
    expect(formulas(source)).toEqual([]);
  });

  it("保留未闭合的流式公式分隔符", () => {
    for (const source of [String.raw`前文 \(x^2`, "\\[\nx^2", String.raw`\[x^2\] 尾文`]) {
      expect(formulas(source)).toEqual([]);
      expect(text(source)).toBe(source);
    }
    expect(formulas(String.raw`前文 \(x^2\)`)).toEqual([{ type: "inlineMath", value: "x^2" }]);
  });

  it("嵌套列表和引用保留所属容器并去掉容器前缀", () => {
    const tree = parse("> - 说明\n>\n>   \\[\n>   a + b\n>   \\]\n>\n>   - \\(c\\)");
    expect(tree.children[0]?.type).toBe("blockquote");
    expect(formulas("> - 说明\n>\n>   \\[\n>   a + b\n>   \\]\n>\n>   - \\(c\\)"))
      .toEqual([{ type: "math", value: "a + b" }, { type: "inlineMath", value: "c" }]);
    expect(descendants(tree).filter((node) => node.type === "listItem")).toHaveLength(2);
  });

  it("块公式不能跨出引用或列表容器寻找闭合符", () => {
    expect(formulas("> \\[\n> a\n\\]")).toEqual([]);
    expect(formulas("- \\[\n  a\n\n\\]")).toEqual([]);
  });

  it("成对反斜杠不提前关闭行内公式", () => {
    expect(formulas(String.raw`\(a \\) + b\)`))
      .toEqual([{ type: "inlineMath", value: String.raw`a \\) + b` }]);
  });

  it("逐字符流式追加只在分隔符闭合后产生公式", () => {
    for (const source of [String.raw`说明 \(\frac{a}{b}\)`, "说明\n\\[\n\\frac{a}{b}\n\\]"]) {
      for (let end = 0; end < source.length; end += 1) {
        expect(formulas(source.slice(0, end))).toEqual([]);
      }
      expect(formulas(source)).toHaveLength(1);
    }
  });

  it("不解析链接地址，允许链接文字和强调中的公式", () => {
    const tree = parse(String.raw`[地址](https://example.com/\(x\)) 与 **\(y\)**`);
    const link = descendants(tree).find((node) => node.type === "link");
    expect(link?.url).toBe("https://example.com/(x)");
    expect(formulas(String.raw`[地址](https://example.com/\(x\)) 与 **\(y\)**`))
      .toEqual([{ type: "inlineMath", value: "y" }]);
    expect(formulas(String.raw`[\(x\)](https://example.com)`))
      .toEqual([{ type: "inlineMath", value: "x" }]);
  });

  it("允许公式内部空行和 Windows 换行符", () => {
    expect(formulas("\\[\r\na +\r\n\r\nb\r\n\\]"))
      .toEqual([{ type: "math", value: "a +\r\n\r\nb" }]);
    expect(formulas("\\(a +\nb\\)"))
      .toEqual([{ type: "inlineMath", value: "a + b" }]);
  });
});
