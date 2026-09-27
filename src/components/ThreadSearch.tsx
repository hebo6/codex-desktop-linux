import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";

import type { ThreadSummary } from "../app/useServerThreads";
import { SearchIcon } from "./SidebarIcons";
import styles from "./ThreadSearch.module.css";

interface ThreadSearchProps {
  readonly threads: readonly ThreadSummary[];
  readonly currentThreadId: string | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: string) => void;
}

export function ThreadSearch({
  threads,
  currentThreadId,
  inputRef,
  onClose,
  onOpenThread,
}: ThreadSearchProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const resultsId = useId();
  const selectedRef = useRef<HTMLButtonElement>(null);
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? threads
      : threads.filter((thread) =>
          `${title(thread)}\n${thread.cwd}\n${thread.preview}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
  }, [query, threads]);
  const activeIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  return (
    <section
      aria-label="搜索会话"
      className={styles.section}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }
      }}
    >
      <div className={styles.search}>
        <SearchIcon />
        <input
          aria-activedescendant={results.length > 0 ? `${resultsId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={resultsId}
          aria-expanded="true"
          aria-label="搜索会话"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex(
                results.length === 0
                  ? 0
                  : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length,
              );
            } else if (event.key === "Enter") {
              const selected = results[activeIndex];
              if (selected !== undefined) {
                event.preventDefault();
                onOpenThread(selected.id);
              }
            }
          }}
          placeholder="搜索标题、目录或内容"
          ref={inputRef}
          role="combobox"
          value={query}
        />
        <button
          aria-label="关闭会话搜索"
          className={styles.close}
          onClick={onClose}
          title="关闭搜索（Esc）"
          type="button"
        >
          <svg aria-hidden="true" height="16" viewBox="0 0 24 24" width="16">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <div
        aria-label="会话搜索结果"
        className={styles.results}
        data-inline
        id={resultsId}
        role="listbox"
      >
        {results.map((thread, index) => (
          <button
            aria-selected={index === activeIndex}
            data-selected={index === activeIndex}
            id={`${resultsId}-${index}`}
            key={thread.id}
            onClick={() => onOpenThread(thread.id)}
            onFocus={() => setSelectedIndex(index)}
            onMouseEnter={() => setSelectedIndex(index)}
            ref={index === activeIndex ? selectedRef : null}
            role="option"
            tabIndex={-1}
            title={`${title(thread)}\n${thread.cwd}`}
            type="button"
          >
            <strong>
              {title(thread)}
              {thread.id === currentThreadId ? " · 当前" : ""}
            </strong>
            <span>
              <small>{thread.cwd}</small>
              <time>{formatTime(thread.updatedAt)}</time>
            </span>
          </button>
        ))}
      </div>
      {results.length === 0 ? (
        <p className={styles.empty} role="status">没有匹配的会话</p>
      ) : null}
    </section>
  );
}

function title(thread: ThreadSummary): string {
  const name = thread.name?.trim();
  if (name) {
    return name;
  }
  return thread.preview.trim().split(/\r?\n/u, 1)[0]?.trim() || "未命名会话";
}

function formatTime(value: number): string {
  return new Date(value * 1_000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
