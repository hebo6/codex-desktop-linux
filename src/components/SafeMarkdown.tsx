import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import "katex/dist/katex.min.css";

import {
  compactMarkdownRemarkPlugins,
  markdownRehypeOptions,
  markdownRehypePlugins,
  markdownRemarkPlugins,
} from "../content/markdown";
import {
  syntaxHighlighter as sharedSyntaxHighlighter,
  type HighlightedLines,
  type SyntaxHighlighter,
} from "../content/syntaxHighlighting";
import {
  markdownFenceLanguageName,
  sourceLanguageForMarkdownFence,
} from "../content/syntaxLanguages";
import syntaxTokenStyles from "./SyntaxToken.module.css";
import { isEscapeDismissal } from "./keyboardEvents";
import { MermaidPreview } from "./MermaidPreview";
import styles from "./SafeMarkdown.module.css";

export { markdownToPlainText } from "../content/markdown";

interface MarkdownContextValue {
  readonly onOpenLink?: (link: string) => void;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly shellCommandDisabled: boolean;
  readonly syntaxHighlighter: SyntaxHighlighter;
  readonly variant: "compact" | "document";
}

const MarkdownContext = createContext<MarkdownContextValue>({
  shellCommandDisabled: false,
  syntaxHighlighter: sharedSyntaxHighlighter,
  variant: "document",
});
const LinkLabelContext = createContext(false);

export function SafeMarkdown({
  onOpenLink,
  onRunShellCommand,
  shellCommandDisabled = false,
  source,
  syntaxHighlighter = sharedSyntaxHighlighter,
  variant = "document",
}: {
  readonly onOpenLink?: (link: string) => void;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly shellCommandDisabled?: boolean;
  readonly source: string;
  readonly syntaxHighlighter?: SyntaxHighlighter;
  readonly variant?: "compact" | "document";
}) {
  const Container = variant === "compact" ? "span" : "div";
  return (
    <MarkdownContext value={{
      shellCommandDisabled,
      syntaxHighlighter,
      variant,
      ...(onOpenLink === undefined ? {} : { onOpenLink }),
      ...(onRunShellCommand === undefined ? {} : { onRunShellCommand }),
    }}>
      <Container className={styles.markdown + (variant === "compact" ? " " + styles.compact : "")}>
        <Markdown
          components={markdownComponents}
          rehypePlugins={markdownRehypePlugins}
          remarkPlugins={variant === "compact" ? compactMarkdownRemarkPlugins : markdownRemarkPlugins}
          remarkRehypeOptions={markdownRehypeOptions}
          skipHtml
        >
          {source}
        </Markdown>
      </Container>
    </MarkdownContext>
  );
}

// 组件类型保持稳定，流式更新不会重挂载代码块并清空折行/确认状态
const markdownComponents: Components = {
  pre: MarkdownPre,
  p: MarkdownParagraph,
  span: MarkdownSpan,
  table: MarkdownTable,
  input: MarkdownCheckbox,
};

function MarkdownPre({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const context = useContext(MarkdownContext);
  const code = node?.data?.markdownCode;
  if (code === undefined) return <pre>{children}</pre>;
  return (
    <CodeBlock
      closed={code.closed}
      language={code.language}
      shellCommandDisabled={context.shellCommandDisabled}
      source={code.source}
      syntaxHighlighter={context.syntaxHighlighter}
      {...(context.onRunShellCommand === undefined ? {} : { onRunShellCommand: context.onRunShellCommand })}
    />
  );
}

function MarkdownParagraph({ node: _node, children, ...props }: ComponentProps<"p"> & ExtraProps) {
  const { variant } = useContext(MarkdownContext);
  return variant === "compact" ? <span>{children}</span> : <p {...props}>{children}</p>;
}

function MarkdownSpan({ node, children, ...props }: ComponentProps<"span"> & ExtraProps) {
  const { onOpenLink, variant } = useContext(MarkdownContext);
  const insideLink = useContext(LinkLabelContext);
  const link = node?.data?.markdownLink;
  if (link === undefined) return <span {...props}>{children}</span>;
  const className = link.image ? styles.imageReference : styles.link;
  return onOpenLink === undefined || variant === "compact" || insideLink
    ? <span className={className} id={props.id}>{children}</span>
    : (
      <button aria-label={props["aria-label"]} className={className} id={props.id} onClick={() => onOpenLink(link.target)} type="button">
        <LinkLabelContext value>{children}</LinkLabelContext>
      </button>
    );
}

function MarkdownTable({ node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  return <div className={styles.tableScroller}><table {...props} /></div>;
}

function MarkdownCheckbox({ node: _node, ...props }: ComponentProps<"input"> & ExtraProps) {
  return <input {...props} aria-label={props.checked ? "已完成" : "未完成"} disabled readOnly type="checkbox" />;
}

const EXECUTABLE_SHELL_LANGUAGES = new Set(["bash", "sh", "zsh"]);

function CodeBlock({
  closed,
  language,
  onRunShellCommand,
  shellCommandDisabled,
  source,
  syntaxHighlighter,
}: {
  readonly closed: boolean;
  readonly language: string;
  readonly onRunShellCommand?: (command: string) => Promise<boolean>;
  readonly shellCommandDisabled: boolean;
  readonly source: string;
  readonly syntaxHighlighter: SyntaxHighlighter;
}) {
  const [wrapped, setWrapped] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [highlightedSource, setHighlightedSource] = useState<{
    readonly language: string;
    readonly lines: HighlightedLines;
    readonly source: string;
  } | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationId = useId();
  const confirmationTitleId = useId();
  const fenceLanguageName = markdownFenceLanguageName(language);
  const isMermaid = fenceLanguageName === "mermaid";
  const showDiagram = isMermaid && closed && !showSource;
  const sourceLanguage = sourceLanguageForMarkdownFence(language);
  const executable =
    onRunShellCommand !== undefined &&
    source.trim().length > 0 &&
    EXECUTABLE_SHELL_LANGUAGES.has(fenceLanguageName);

  useEffect(() => {
    setHighlightedSource(null);
    if (!closed || source.length === 0 || sourceLanguage === null) {
      return;
    }
    let disposed = false;
    void syntaxHighlighter.highlight(source, sourceLanguage.id).then(
      (lines) => {
        if (!disposed && highlightedText(lines) === source) {
          setHighlightedSource({
            language: sourceLanguage.id,
            lines,
            source,
          });
        }
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [closed, source, sourceLanguage, syntaxHighlighter]);

  useEffect(() => {
    if (!confirmationOpen) {
      return;
    }
    cancelButtonRef.current?.focus();
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        confirmationRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setConfirmationOpen(false);
    };
    const closeFromFocusOutside = (event: FocusEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        confirmationRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setConfirmationOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (!isEscapeDismissal(event)) {
        return;
      }
      event.preventDefault();
      setConfirmationOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("focusin", closeFromFocusOutside);
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("focusin", closeFromFocusOutside);
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [confirmationOpen]);

  useEffect(() => {
    if (shellCommandDisabled) {
      setConfirmationOpen(false);
    }
  }, [shellCommandDisabled]);

  const execute = async () => {
    if (onRunShellCommand === undefined || shellCommandDisabled || submitting) {
      return;
    }
    setConfirmationOpen(false);
    setSubmitting(true);
    triggerRef.current?.focus();
    try {
      await onRunShellCommand(source);
    } catch {
      // Execution errors are presented by the conversation layer.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={styles.codeBlock}>
      <header>
        <span>{sourceLanguage?.label ?? (fenceLanguageName || "文本")}</span>
        {isMermaid && closed ? (
          <button onClick={() => setShowSource((value) => !value)} type="button">
            {showSource ? "图表" : "源码"}
          </button>
        ) : null}
        {!showDiagram ? (
          <button aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)} type="button">{wrapped ? "不折行" : "折行"}</button>
        ) : null}
        <button onClick={() => {
          void navigator.clipboard.writeText(source).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          }, () => undefined);
        }} type="button">{copied ? "已复制" : "复制"}</button>
        {executable ? (
          <button
            aria-controls={confirmationId}
            aria-expanded={confirmationOpen}
            aria-haspopup="dialog"
            aria-label="执行 Shell 命令"
            className={styles.shellRunButton}
            disabled={shellCommandDisabled || submitting}
            onClick={() => setConfirmationOpen((value) => !value)}
            ref={triggerRef}
            type="button"
          >
            {submitting ? "执行中" : "执行"}
          </button>
        ) : null}
      </header>
      {confirmationOpen ? (
        <div
          aria-labelledby={confirmationTitleId}
          aria-modal={false}
          className={styles.shellConfirmation}
          id={confirmationId}
          ref={confirmationRef}
          role="alertdialog"
        >
          <strong id={confirmationTitleId}>确认执行这段 Shell 命令？</strong>
          <p>当前项目 · 不受沙箱限制</p>
          <div className={styles.shellConfirmationActions}>
            <button
              onClick={() => {
                setConfirmationOpen(false);
                triggerRef.current?.focus();
              }}
              ref={cancelButtonRef}
              type="button"
            >
              取消
            </button>
            <button
              className={styles.shellConfirmButton}
              onClick={() => void execute()}
              type="button"
            >
              执行
            </button>
          </div>
        </div>
      ) : null}
      {showDiagram ? <MermaidPreview source={source} /> : (
        <pre data-wrapped={wrapped}>
          <code>
            {
              highlightedSource?.source === source &&
              highlightedSource.language === sourceLanguage?.id
                ? renderHighlightedLines(highlightedSource.lines)
                : source
            }
          </code>
        </pre>
      )}
    </section>
  );
}

function highlightedText(lines: HighlightedLines): string {
  return lines
    .map((line) => line.map((token) => token.content).join(""))
    .join("\n");
}

function renderHighlightedLines(lines: HighlightedLines): readonly ReactNode[] {
  const nodes: ReactNode[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    for (const [tokenIndex, token] of line.entries()) {
      nodes.push(
        <span
          className={syntaxTokenStyles.token}
          key={`${lineIndex}:${tokenIndex}`}
          style={token.style}
        >
          {token.content}
        </span>,
      );
    }
    if (lineIndex < lines.length - 1) {
      nodes.push("\n");
    }
  }
  return nodes;
}
