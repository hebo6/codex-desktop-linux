import { useEffect, useRef, type ReactNode } from "react";

import styles from "./ConversationWorkspace.module.css";

export function ConversationWorkspace({
  children,
  composer,
}: {
  readonly children: ReactNode;
  readonly composer: ReactNode;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleFocusShortcut = (event: KeyboardEvent) => {
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
      const input = workspace.querySelector<HTMLTextAreaElement>("[data-composer-input]");
      if (input === null || input.disabled) return;

      let target: HTMLElement = input;
      if (switchFocus) {
        const messages = workspace.querySelector<HTMLElement>("[data-conversation-scroller]");
        if (messages === null) return;
        if (!messages.contains(document.activeElement)) target = messages;
      }
      event.preventDefault();
      target.focus({ preventScroll: true });
    };

    window.addEventListener("keydown", handleFocusShortcut);
    return () => window.removeEventListener("keydown", handleFocusShortcut);
  }, []);

  return (
    <div className={styles.workspace} data-conversation-workspace ref={workspaceRef}>
      <div className={styles.content}>{children}</div>
      {composer}
    </div>
  );
}
