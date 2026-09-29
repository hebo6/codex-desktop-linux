import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { compactMarkdownTree, markdownTreeToPlainText } from "./markdownText";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function parse(source: string): Root {
  return parser.parse(source);
}

describe("markdownTreeToPlainText", () => {
  it("从标题、任务列表和表格提取一致的可读文本", () => {
    expect(markdownTreeToPlainText(parse("# 标题\n\n- [x] **完成**\n\n| 文件 | 状态 |\n| --- | --- |\n| foo-bar.ts | [通过](https://example.com) |")))
      .toBe("标题\n• ☑ 完成\n文件\t状态\nfoo-bar.ts\t通过");
  });

  it("保留有序列表起始数字、嵌套缩进和任务状态", () => {
    expect(markdownTreeToPlainText(parse("3. 第三项\n   - [ ] 子任务\n     7. 孙项\n\n   后续段落\n4. 第四项")))
      .toBe("3. 第三项\n  • ☐ 子任务\n    7. 孙项\n  后续段落\n4. 第四项");
  });

  it("保留软换行和代码内容，图片使用替代文本，数学源码只出现一次", () => {
    expect(markdownTreeToPlainText(parse("第一行\n第二行  \n第三行 ![**图片**](./image.png)\n\n`**代码**` 与 $2^n$\n\n```latex\n\\[x\\]\n```\n\n$$\n\\underbrace{2 \\times 2}_{n\\text{ 个}}\n$$")))
      .toBe("第一行\n第二行\n第三行 图片：图片\n**代码** 与 2^n\n\\[x\\]\n\\underbrace{2 \\times 2}_{n\\text{ 个}}");
  });

  it("隐藏 HTML 和链接定义，并保留引用标签和稳定脚注标记", () => {
    expect(markdownTreeToPlainText(parse("<script>危险</script>\n\n[**引用**][target] 与 ![图][image] 和注释[^note]\n\n[target]: https://example.com\n[image]: ./image.png\n\n[^note]: 脚注 *内容*")))
      .toBe("引用 与 图片：图 和注释[note]\n[note] 脚注 内容");
  });
});

describe("compactMarkdownTree", () => {
  it("展平为一个段落并保留标题、强调和链接的行内结构", () => {
    const tree = compactMarkdownTree(parse("# 标题\n\n正文 *强调* 与 [**链接**](https://example.com)\n下一行\n\n> 引用\n\n---"));
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "strong", children: [{ type: "text", value: "标题" }] },
        { type: "text", value: " " },
        { type: "text", value: "正文 " },
        { type: "emphasis", children: [{ type: "text", value: "强调" }] },
        { type: "text", value: " 与 " },
        { type: "link", url: "https://example.com", children: [{ type: "strong", children: [{ type: "text", value: "链接" }] }] },
        { type: "text", value: " 下一行" },
        { type: "text", value: " " },
        { type: "text", value: "引用" },
        { type: "text", value: " " },
        { type: "text", value: "—" },
      ],
    });
  });

  it("使用紧凑列表和表格分隔符", () => {
    const tree = compactMarkdownTree(parse("3. 三\n4. 四\n\n- [x] 完成\n- [ ] 待办\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"));
    expect(markdownTreeToPlainText(tree))
      .toBe("3. 三 · 4. 四 • ☑ 完成 · • ☐ 待办 A | B · 1 | 2");
  });

  it("保留空表格单元格的列位置", () => {
    const tree = compactMarkdownTree(parse("| A | | C |\n| --- | --- | --- |\n| | B | |"));
    expect(markdownTreeToPlainText(tree)).toBe("A |  | C ·  | B |");
  });

  it("代码与独立公式转换为行内节点且不会重新解析内容", () => {
    const tree = compactMarkdownTree(parse("```text\n**原样** [链接](x)\n```\n\n$$\n\\text{**原样**} + x\n$$"));
    expect(tree.children).toEqual([{
      type: "paragraph",
      children: [
        { type: "inlineCode", value: "**原样** [链接](x)" },
        { type: "text", value: " " },
        {
          type: "inlineMath",
          value: "\\text{**原样**} + x",
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value: "\\text{**原样**} + x" }],
          },
        },
      ],
    }]);
  });

  it("保留嵌套链接定义、行内引用和图片，删除 HTML，脚注使用文本标记", () => {
    const tree = compactMarkdownTree(parse("[引用][target] ![图][image] <b>文字</b>[^note]\n\n> [target]: https://example.com\n\n[image]: ./image.png\n\n[^note]: 注释内容"));
    expect(tree.children.map((node) => node.type)).toEqual(["paragraph", "definition", "definition"]);
    expect(tree.children[0]).toMatchObject({
      type: "paragraph",
      children: expect.arrayContaining([
        { type: "text", value: "[note]" },
        expect.objectContaining({ type: "linkReference", identifier: "target" }),
        expect.objectContaining({ type: "imageReference", identifier: "image" }),
      ]),
    });
    expect(markdownTreeToPlainText(tree)).toBe("引用 图片：图 文字[note] [note] 注释内容");
  });

  it("不修改共享的原始语法树", () => {
    const tree = parse("# 标题\n\n```text\n原样\n```\n\n$$\nx\n$$");
    const before = structuredClone(tree);
    compactMarkdownTree(tree);
    expect(tree).toEqual(before);
  });
});
