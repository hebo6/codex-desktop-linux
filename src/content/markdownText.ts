import type {
  Definition,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import type {} from "remark-math";

export function markdownTreeToPlainText(tree: Root): string {
  return plainBlocks(tree.children).trim();
}

export function compactMarkdownTree(tree: Root): Root {
  const definitions: Definition[] = [];
  collectDefinitions(tree.children, definitions);
  return {
    ...tree,
    children: [
      { type: "paragraph", children: compactBlocks(tree.children) },
      ...definitions,
    ],
  };
}

function plainBlocks(nodes: readonly RootContent[]): string {
  return nodes.map(plainNode).filter((value) => value.length > 0).join("\n");
}

function plainNode(node: RootContent): string {
  switch (node.type) {
    case "definition":
    case "html":
    case "yaml":
      return "";
    case "text":
    case "inlineCode":
    case "code":
    case "inlineMath":
    case "math":
      return node.value;
    case "break":
      return "\n";
    case "thematicBreak":
      return "—";
    case "image":
    case "imageReference":
      return `图片：${node.alt ?? ""}`;
    case "footnoteReference":
      return `[${node.label ?? node.identifier}]`;
    case "footnoteDefinition":
      return `[${node.label ?? node.identifier}] ${plainBlocks(node.children)}`;
    case "list":
      return node.children.map((item, index) => plainListItem(item, listMarker(node, index))).join("\n");
    case "listItem":
    case "blockquote":
      return plainBlocks(node.children);
    case "table":
      return node.children.map(plainNode).join("\n");
    case "tableRow":
      return node.children.map(plainNode).join("\t");
    case "heading":
    case "paragraph":
    case "tableCell":
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
      return node.children.map(plainNode).join("");
  }
}

function plainListItem(item: ListItem, marker: string): string {
  const content = plainBlocks(item.children);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${marker}${taskMarker(item)} ${first}`.trimEnd(),
    ...rest.map((line) => line.length === 0 ? "" : `  ${line}`),
  ].join("\n");
}

function listMarker(list: List, index: number): string {
  return list.ordered ? `${(list.start ?? 1) + index}.` : "•";
}

function taskMarker(item: ListItem): string {
  return item.checked === true ? " ☑" : item.checked === false ? " ☐" : "";
}

function compactBlocks(nodes: readonly RootContent[]): PhrasingContent[] {
  return joinPhrasing(nodes.map(compactNode).filter((group) => group.length > 0), " ");
}

function compactNode(node: RootContent): PhrasingContent[] {
  switch (node.type) {
    case "definition":
    case "html":
    case "yaml":
      return [];
    case "text":
      return [{ ...node, value: node.value.replace(/\r\n?|\n/gu, " ") }];
    case "break":
      return [text(" ")];
    case "thematicBreak":
      return [text("—")];
    case "code":
      return [{ type: "inlineCode", value: node.value }];
    case "math":
      return [{
        type: "inlineMath",
        value: node.value,
        data: {
          hName: "code",
          hProperties: { className: ["language-math", "math-inline"] },
          hChildren: [{ type: "text", value: node.value }],
        },
      }];
    case "inlineCode":
    case "inlineMath":
    case "image":
    case "imageReference":
      return [node];
    case "footnoteReference":
      return [text(`[${node.label ?? node.identifier}]`)];
    case "footnoteDefinition":
      return [text(`[${node.label ?? node.identifier}] `), ...compactBlocks(node.children)];
    case "heading":
      return [{ type: "strong", children: node.children.flatMap(compactNode) }];
    case "paragraph":
    case "tableCell":
      return node.children.flatMap(compactNode);
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
      return [{ ...node, children: node.children.flatMap(compactNode) }];
    case "blockquote":
    case "listItem":
      return compactBlocks(node.children);
    case "list":
      return joinPhrasing(node.children.map((item, index) => [
        text(`${listMarker(node, index)}${taskMarker(item)} `),
        ...compactBlocks(item.children),
      ]), " · ");
    case "table":
      return joinPhrasing(node.children.map(compactNode), " · ");
    case "tableRow":
      return joinPhrasing(node.children.map(compactNode), " | ");
  }
}

function joinPhrasing(groups: readonly PhrasingContent[][], separator: string): PhrasingContent[] {
  return groups.flatMap((group, index) => (
    index === 0 ? group : [text(separator), ...group]
  ));
}

function text(value: string): PhrasingContent {
  return { type: "text", value };
}

function collectDefinitions(nodes: readonly RootContent[], definitions: Definition[]): void {
  for (const node of nodes) {
    if (node.type === "definition") {
      definitions.push(node);
    } else if ("children" in node) {
      collectDefinitions(node.children, definitions);
    }
  }
}
