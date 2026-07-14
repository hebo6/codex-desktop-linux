import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { ThreadSummary } from "../app/useServerThreads";
import { useModalLayer } from "./modalStack";
import styles from "./ThreadQuickSwitcher.module.css";

interface ThreadQuickSwitcherProps {
  readonly open: boolean;
  readonly threads: readonly ThreadSummary[];
  readonly currentThreadId: string | null;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: string) => void;
}

export function ThreadQuickSwitcher(props: ThreadQuickSwitcherProps) {
  if (!props.open) {
    return null;
  }
  return <ThreadQuickSwitcherContent {...props} />;
}

function ThreadQuickSwitcherContent({
  threads,
  currentThreadId,
  onClose,
  onOpenThread,
}: ThreadQuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const isTopmostModal = useModalLayer();
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

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => setSelectedIndex(0), [query]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) =>
          results.length === 0
            ? 0
            : (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) %
              results.length,
        );
        return;
      }
      if (event.key === "Enter") {
        const selected = results[selectedIndex];
        if (selected !== undefined) {
          event.preventDefault();
          onOpenThread(selected.id);
          onClose();
        }
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) {
        return;
      }
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [isTopmostModal, onClose, onOpenThread, results, selectedIndex]);

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.dialog}
        ref={panelRef}
        role="dialog"
      >
        <h2 id={titleId} hidden>
          快速切换会话
        </h2>
        <label className={styles.search}>
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索会话"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按标题或工作目录搜索"
            ref={inputRef}
            value={query}
          />
        </label>
        <div
          aria-label="会话搜索结果"
          className={styles.results}
          role="listbox"
        >
          {results.length === 0 ? (
            <p className={styles.empty}>没有匹配的会话</p>
          ) : (
            results.map((thread, index) => (
              <button
                aria-selected={index === selectedIndex}
                data-selected={index === selectedIndex}
                key={thread.id}
                onClick={() => {
                  onOpenThread(thread.id);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                role="option"
                type="button"
              >
                <span>
                  <strong>
                    {title(thread)}
                    {thread.id === currentThreadId ? " · 当前" : ""}
                  </strong>
                  <small>{thread.cwd}</small>
                </span>
                <time>{formatTime(thread.updatedAt)}</time>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
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
