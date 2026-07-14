import { useState, type ReactNode } from "react";

import styles from "./SafeMarkdown.module.css";

export function SafeMarkdown({
  onOpenLink,
  source,
  variant = "document",
}: {
  readonly onOpenLink?: (link: string) => void;
  readonly source: string;
  readonly variant?: "compact" | "document";
}) {
  if (variant === "compact") {
    return (
      <span className={`${styles.markdown} ${styles.compact}`}>
        {parseBlocks(source).map((block, index) => (
          <CompactMarkdownBlock
            block={block}
            key={`${block.type}:${index}`}
            leading={index > 0}
          />
        ))}
      </span>
    );
  }
  return (
    <div className={styles.markdown}>
      {parseBlocks(source).map((block, index) => (
        <MarkdownBlock block={block} key={`${block.type}:${index}`} {...(onOpenLink === undefined ? {} : { onOpenLink })} />
      ))}
    </div>
  );
}

function CompactMarkdownBlock({
  block,
  leading,
}: {
  readonly block: Block;
  readonly leading: boolean;
}) {
  const prefix = leading ? " " : "";
  const inline = (text: string) => renderInline(text, undefined, false);
  switch (block.type) {
    case "paragraph":
      return <>{prefix}{inline(block.text)}</>;
    case "quote":
      return <>{prefix}{inline(block.text)}</>;
    case "heading":
      return <>{prefix}<strong>{inline(block.text)}</strong></>;
    case "code":
      return <>{prefix}<code>{block.text}</code></>;
    case "list":
      return (
        <>
          {prefix}
          {block.items.map((item, index) => (
            <span key={index}>
              {index > 0 ? " · " : ""}
              {block.ordered ? `${index + 1}. ` : "• "}
              {item.checked === null ? "" : item.checked ? "☑ " : "☐ "}
              {inline(item.text)}
            </span>
          ))}
        </>
      );
    case "table":
      return (
        <>
          {prefix}
          {[block.header, ...block.rows].map((row, rowIndex) => (
            <span key={rowIndex}>
              {rowIndex > 0 ? " · " : ""}
              {row.map((cell, cellIndex) => (
                <span key={cellIndex}>
                  {cellIndex > 0 ? " | " : ""}
                  {inline(cell)}
                </span>
              ))}
            </span>
          ))}
        </>
      );
    case "rule":
      return <>{prefix}—</>;
  }
}

type Block =
  | { readonly type: "paragraph" | "quote"; readonly text: string }
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "code"; readonly language: string; readonly text: string }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | { readonly type: "table"; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly type: "rule" };

interface ListItem {
  readonly text: string;
  readonly checked: boolean | null;
}

function MarkdownBlock({
  block,
  onOpenLink,
}: {
  readonly block: Block;
  readonly onOpenLink?: (link: string) => void;
}) {
  const inline = (text: string) => renderInline(text, onOpenLink);
  switch (block.type) {
    case "paragraph":
      return <p>{inline(block.text)}</p>;
    case "quote":
      return <blockquote>{inline(block.text)}</blockquote>;
    case "heading": {
      const content = inline(block.text);
      const id = headingId(block.text);
      if (block.level === 1) return <h1 id={id}>{content}</h1>;
      if (block.level === 2) return <h2 id={id}>{content}</h2>;
      if (block.level === 3) return <h3 id={id}>{content}</h3>;
      if (block.level === 4) return <h4 id={id}>{content}</h4>;
      if (block.level === 5) return <h5 id={id}>{content}</h5>;
      return <h6 id={id}>{content}</h6>;
    }
    case "code":
      return <CodeBlock language={block.language} source={block.text} />;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          {item.checked === null ? null : <input aria-label={item.checked ? "已完成" : "未完成"} checked={item.checked} disabled readOnly type="checkbox" />}
          {inline(item.text)}
        </li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div className={styles.tableScroller}>
          <table>
            <thead><tr>{block.header.map((cell, index) => <th key={index}>{inline(cell)}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr />;
  }
}

function CodeBlock({ language, source }: { readonly language: string; readonly source: string }) {
  const [wrapped, setWrapped] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <section className={styles.codeBlock}>
      <header>
        <span>{language || "文本"}</span>
        <button aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)} type="button">{wrapped ? "不折行" : "折行"}</button>
        <button onClick={() => {
          void navigator.clipboard.writeText(source).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          }, () => undefined);
        }} type="button">{copied ? "已复制" : "复制"}</button>
      </header>
      <pre data-wrapped={wrapped}><code>{source}</code></pre>
    </section>
  );
}

function parseBlocks(source: string): readonly Block[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = /^\s*```([^`]*)$/u.exec(line);
    if (fence !== null) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? "")) {
        content.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: (fence[1] ?? "").trim(), text: content.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, text: stripRawHtml(heading[2] ?? "") });
      index += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (line.includes("|") && isTableDivider(lines[index + 1] ?? "")) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const listMatch = /^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/u.exec(line);
    if (listMatch !== null) {
      const ordered = listMatch[1] !== undefined;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const match = /^\s*(?:(\d+)[.)]|[-+*])\s+(.+)$/u.exec(lines[index] ?? "");
        if (match === null || (match[1] !== undefined) !== ordered) break;
        const task = /^\[([ xX])\]\s+(.+)$/u.exec(match[2] ?? "");
        items.push({
          text: stripRawHtml(task?.[2] ?? match[2] ?? ""),
          checked: task === null ? null : task[1]?.toLocaleLowerCase() === "x",
        });
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: stripRawHtml(quote.join("\n")) });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim().length > 0 && !startsBlock(lines, index)) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", text: stripRawHtml(paragraph.join("\n")) });
  }
  return blocks;
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*```/u.test(line)
    || /^(#{1,6})\s+/u.test(line)
    || /^\s*(?:\d+[.)]|[-+*])\s+/u.test(line)
    || /^\s*>/u.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)
    || (line.includes("|") && isTableDivider(lines[index + 1] ?? ""));
}

function renderInline(
  source: string,
  onOpenLink?: (link: string) => void,
  interactiveLinks = true,
): readonly ReactNode[] {
  const pattern = /(!?\[[^\]]*\]\([^)]*\)|`[^`]*`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|<https?:\/\/[^>]+>)/giu;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${match.index}:${token}`;
    const link = /^(!?)\[([^\]]*)\]\(([^)]*)\)$/u.exec(token);
    if (link !== null) {
      const image = link[1] === "!";
      const label = link[2] || link[3] || "链接";
      const target = link[3] ?? "";
      const content = image ? `图片：${label}` : label;
      nodes.push(interactiveLinks
        ? (
          <button className={image ? styles.imageReference : styles.link} key={key} onClick={() => onOpenLink?.(target)} type="button">
            {content}
          </button>
        )
        : <span className={image ? styles.imageReference : styles.link} key={key}>{content}</span>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("<")) {
      const target = token.slice(1, -1);
      nodes.push(interactiveLinks
        ? <button className={styles.link} key={key} onClick={() => onOpenLink?.(target)} type="button">{target}</button>
        : <span className={styles.link} key={key}>{target}</span>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < source.length) nodes.push(source.slice(lastIndex));
  return nodes;
}

function stripRawHtml(source: string): string {
  return source.replace(/<\/?[A-Za-z][^>]*>/gu, "");
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => stripRawHtml(cell.trim()));
}

function headingId(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/\s+/gu, "-").replace(/[^\p{Letter}\p{Number}_-]/gu, "");
}
