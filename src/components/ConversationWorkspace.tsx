import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { isEscapeDismissal } from "./keyboardEvents";

import styles from "./ConversationWorkspace.module.css";

export function ConversationWorkspace({
  children,
  composer,
  focusMode = false,
  composerExpanded = false,
  onShowComposer,
  onHideComposer,
}: {
  readonly children: ReactNode;
  readonly composer: ReactNode;
  readonly focusMode?: boolean;
  readonly composerExpanded?: boolean;
  readonly onShowComposer?: () => void;
  readonly onHideComposer?: () => void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousLayout = useRef({ focusMode, composerExpanded });

  useLayoutEffect(() => {
    const previous = previousLayout.current;
    previousLayout.current = { focusMode, composerExpanded };
    if (previous.focusMode === focusMode && previous.composerExpanded === composerExpanded) return;
    const workspace = workspaceRef.current;
    const target = focusMode && composerExpanded
      ? workspace?.querySelector<HTMLElement>(COMPOSER_FOCUS_TARGET)
      : workspace?.querySelector<HTMLElement>("[data-conversation-scroller]") ?? workspace;
    target?.focus({ preventScroll: true });
  }, [focusMode, composerExpanded]);

  useEffect(() => {
    const handleFocusShortcut = (event: KeyboardEvent) => {
      if (
        focusMode && composerExpanded && isEscapeDismissal(event) &&
        document.querySelector('[aria-modal="true"]') === null &&
        !Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]'))
          .some((element) => element.closest("[hidden], [inert]") === null)
      ) {
        event.preventDefault();
        onHideComposer?.();
        return;
      }
      const switchFocus = event.key === "F6" && !event.ctrlKey;
      const focusComposer = event.key.toLowerCase() === "l" && event.ctrlKey;
      if (
        (!switchFocus && !focusComposer) ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        document.querySelector('[aria-modal="true"]') !== null
      ) {
        return;
      }
      const workspace = workspaceRef.current;
      if (workspace === null) return;
      const input = workspace.querySelector<HTMLTextAreaElement | HTMLButtonElement>(COMPOSER_FOCUS_TARGET);
      if (input === null || input.disabled) return;

      let target: HTMLElement = input;
      if (switchFocus) {
        const messages = workspace.querySelector<HTMLElement>("[data-conversation-scroller]");
        if (messages === null) return;
        if (!messages.contains(document.activeElement)) target = messages;
      }
      event.preventDefault();
      if (focusMode) {
        if (target === input && !composerExpanded) {
          onShowComposer?.();
          return;
        }
        if (target !== input && composerExpanded) onHideComposer?.();
      }
      target.focus({ preventScroll: true });
    };

    window.addEventListener("keydown", handleFocusShortcut);
    return () => window.removeEventListener("keydown", handleFocusShortcut);
  }, [focusMode, composerExpanded, onShowComposer, onHideComposer]);

  return (
    <div className={styles.workspace} data-conversation-workspace data-focus-mode={focusMode} ref={workspaceRef} tabIndex={-1}>
      <div className={styles.content}>{children}</div>
      <div
        aria-label={focusMode && composerExpanded ? "临时输入" : undefined}
        className={styles.composerArea}
        data-focus-composer
        role={focusMode && composerExpanded ? "dialog" : undefined}
      >
        {composer}
      </div>
    </div>
  );
}

const COMPOSER_FOCUS_TARGET = "[data-composer-input], [data-composer-focus-target]";
