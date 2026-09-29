import type { Element, Root as HtmlRoot } from "hast";
import type { Root } from "mdast";
import type { CompileContext } from "mdast-util-from-markdown";
import type { Options as MarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified, type PluggableList, type Plugin } from "unified";
import { visit } from "unist-util-visit";

import { compactMarkdownTree, markdownTreeToPlainText } from "./markdownText";
import { remarkMathDelimiters } from "./remarkMathDelimiters";

interface MarkdownCode {
  readonly source: string;
  readonly language: string;
  readonly closed: boolean;
}

interface MarkdownLink {
  readonly target: string;
  readonly image: boolean;
}

declare module "mdast" {
  interface Data {
    fenceClosed?: boolean;
    openingFence?: string;
  }
}

declare module "hast" {
  interface Data {
    markdownCode?: MarkdownCode;
    markdownLink?: MarkdownLink;
  }
}

// 围栏事件由标准解析器产生，引用、列表和不同长度的围栏共用同一规则
const remarkFenceState: Plugin<[], Root> = function () {
  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      codeFencedFence: recordFence,
      mathFlowFence: recordFence,
    },
  });
  return (tree) => {
    visit(tree, "code", (node, index, parent) => {
      if (node.lang !== "math" || node.data?.fenceClosed !== true || parent === undefined || index === undefined) return;
      // math 围栏先统一为数学节点，正文、摘要与纯文本共用这一语义
      parent.children[index] = {
        type: "math",
        value: node.value,
        data: {
          hName: "pre",
          hChildren: [{
            type: "element",
            tagName: "code",
            properties: { className: ["language-math", "math-display"] },
            children: [{ type: "text", value: node.value }],
          }],
        },
      };
    });
    visit(tree, "heading", (node) => {
      const text = markdownTreeToPlainText({ type: "root", children: [node] });
      node.data ??= {};
      node.data.hProperties = {
        id: text.trim().toLocaleLowerCase().replace(/\s+/gu, "-").replace(/[^\p{Letter}\p{Number}_-]/gu, ""),
      };
    });
    visit(tree, "math", (node, index, parent) => {
      if (node.data?.fenceClosed !== false || parent === undefined || index === undefined) return;
      // 未闭合的显示公式保留为正文，避免每次流式更新都调用 KaTeX
      parent.children[index] = {
        type: "paragraph",
        children: [{ type: "text", value: `${node.data.openingFence}\n${node.value}` }],
      };
    });
  };
};

function recordFence(this: CompileContext, token: Parameters<CompileContext["sliceSerialize"]>[0]): void {
  // 第二个围栏到来时，栈顶可能是解析器的文本缓冲 fragment
  const node = this.stack.findLast((entry) => entry.type === "code" || entry.type === "math");
  if (node === undefined) return;
  node.data ??= {};
  if (node.data.fenceClosed === undefined) {
    node.data.fenceClosed = false;
    node.data.openingFence = this.sliceSerialize(token);
  } else {
    node.data.fenceClosed = true;
  }
}

export const markdownRemarkPlugins: PluggableList = [
  remarkGfm,
  remarkMath,
  remarkMathDelimiters,
  remarkFenceState,
];

const remarkCompact: Plugin<[], Root> = () => compactMarkdownTree;
export const compactMarkdownRemarkPlugins: PluggableList = [...markdownRemarkPlugins, remarkCompact];

const parser = unified().use(remarkParse).use(markdownRemarkPlugins);

export function markdownToPlainText(source: string): string {
  // 此管线只转换 mdast；PluggableList 会擦除 unified 的输出树类型
  return markdownTreeToPlainText(parser.runSync(parser.parse(source)) as Root);
}

export const markdownRehypeOptions: NonNullable<MarkdownOptions["remarkRehypeOptions"]> = {
  footnoteLabel: "脚注",
  footnoteBackLabel: "返回正文",
  handlers: {
    code(state, node) {
      const closed = node.data?.fenceClosed !== false;
      const language = node.lang ?? "";
      const code: Element = {
        type: "element",
        tagName: "code",
        properties: {},
        children: [{ type: "text", value: node.value }],
      };
      const pre: Element = {
        type: "element",
        tagName: "pre",
        properties: {},
        data: { markdownCode: { source: node.value, language, closed } },
        children: [code],
      };
      state.patch(node, pre);
      return pre;
    },
  },
};

// URL 只作为按钮的业务数据传递，不写入可导航或可加载资源的 DOM 属性
// 这样 file: 和带行号的相对路径仍由项目的 LinkResolver 统一校验
const rehypeLinkReferences: Plugin<[], HtmlRoot> = () => (tree) => {
  visit(tree, "element", (node) => {
    if (node.tagName !== "a" && node.tagName !== "img") return;
    const image = node.tagName === "img";
    const target = node.properties[image ? "src" : "href"];
    if (typeof target !== "string") return;
    node.data = { ...node.data, markdownLink: { target, image } };
    if (image) {
      node.children = [{ type: "text", value: `图片：${String(node.properties.alt ?? "")}` }];
    }
    node.tagName = "span";
    delete node.properties.href;
    delete node.properties.src;
  });
};

export const markdownRehypePlugins: PluggableList = [
  rehypeLinkReferences,
  [rehypeSanitize, {
    ...defaultSchema,
    // 原始 HTML 被移除；脚注 ID 已由 remark-rehype 加 user-content- 前缀
    clobberPrefix: "",
    attributes: {
      ...defaultSchema.attributes,
      code: [["className", "language-math", "math-inline", "math-display"]],
    },
  }],
  [rehypeKatex, { trust: false }],
];
