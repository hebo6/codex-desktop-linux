import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  KEYBOARD_SHORTCUT_GROUPS,
  type KeyboardShortcutGroup,
} from "./keyboardShortcuts";
import { useModalLayer } from "./modalStack";
import styles from "./KeyboardShortcutsDialog.module.css";

interface KeyboardShortcutsDialogProps {
  readonly onClose: () => void;
  readonly open: boolean;
}

export function KeyboardShortcutsDialog(
  props: KeyboardShortcutsDialogProps,
) {
  if (!props.open) {
    return null;
  }
  return <KeyboardShortcutsDialogContent {...props} />;
}

function KeyboardShortcutsDialogContent({
  onClose,
}: KeyboardShortcutsDialogProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const isTopmostModal = useModalLayer();
  const groups = useMemo(() => filterShortcutGroups(query), [query]);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    searchRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) {
        return;
      }
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
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
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isTopmostModal, onClose]);

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
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <h2 id={titleId}>键盘快捷键</h2>
          <button aria-label="关闭键盘快捷键" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <label className={styles.search}>
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索键盘快捷键"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索功能或按键"
            ref={searchRef}
            type="search"
            value={query}
          />
        </label>
        <div className={styles.groups}>
          {groups.length === 0 ? (
            <p className={styles.empty}>没有匹配的快捷键</p>
          ) : (
            groups.map((group) => (
              <section key={group.title}>
                <h3>{group.title}</h3>
                <dl>
                  {group.shortcuts.map((shortcut) => (
                    <div key={shortcut.label}>
                      <dt>{shortcut.label}</dt>
                      <dd>
                        {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function filterShortcutGroups(query: string): readonly KeyboardShortcutGroup[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return KEYBOARD_SHORTCUT_GROUPS;
  }
  return KEYBOARD_SHORTCUT_GROUPS.flatMap((group) => {
    const shortcuts = group.shortcuts.filter((shortcut) =>
      `${shortcut.label}\n${shortcut.keys.join("\n")}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
    return shortcuts.length === 0 ? [] : [{ ...group, shortcuts }];
  });
}
