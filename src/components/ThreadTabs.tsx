import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  ThreadStatusIndicator,
  type ThreadStatusKind,
} from "./ThreadStatusIndicator";
import styles from "./ThreadTabs.module.css";

export interface ThreadTabView {
  readonly id: string;
  readonly projectName: string;
  readonly projectPath?: string;
  readonly title: string;
  readonly status?: ThreadStatusKind;
}

interface TabContextMenuState {
  readonly tabId: string;
  readonly title: string;
  readonly trigger: HTMLButtonElement;
  readonly x: number;
  readonly y: number;
}

interface MenuPosition {
  readonly left: number;
  readonly top: number;
}

export function ThreadTabs({
  activeTabId,
  disabled = false,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onNew,
  tabs,
}: {
  readonly activeTabId: string | null;
  readonly disabled?: boolean;
  readonly onActivate: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onCloseOthers: (tabId: string) => void;
  readonly onCloseRight: (tabId: string) => void;
  readonly onNew: () => void;
  readonly tabs: readonly ThreadTabView[];
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuId = useId();
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(
    null,
  );
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId]);

  useLayoutEffect(() => {
    if (contextMenu === null || contextMenuRef.current === null) {
      return;
    }
    const bounds = contextMenuRef.current.getBoundingClientRect();
    setMenuPosition(fitMenuToViewport(contextMenu.x, contextMenu.y, bounds));
    contextMenuRef.current
      .querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
  }, [contextMenu]);

  useEffect(() => {
    if (contextMenu === null) {
      return;
    }
    const closeFromPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        contextMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", closeFromPointer);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeFromPointer);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (
      contextMenu !== null &&
      !tabs.some(({ id }) => id === contextMenu.tabId)
    ) {
      setContextMenu(null);
    }
  }, [contextMenu, tabs]);

  const openContextMenu = (
    tab: ThreadTabView,
    trigger: HTMLButtonElement,
    x: number,
    y: number,
  ) => {
    setMenuPosition(null);
    setContextMenu({ tabId: tab.id, title: tab.title, trigger, x, y });
  };

  const closeContextMenuAndRestoreFocus = () => {
    const trigger = contextMenu?.trigger;
    setContextMenu(null);
    trigger?.focus();
  };

  const runContextMenuAction = (action: (tabId: string) => void) => {
    if (contextMenu === null) {
      return;
    }
    const { tabId, trigger } = contextMenu;
    setContextMenu(null);
    trigger.focus();
    action(tabId);
  };

  const handleContextMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ),
    );
    const currentIndex = menuItems.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % menuItems.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = currentIndex < 0
        ? menuItems.length - 1
        : (currentIndex - 1 + menuItems.length) % menuItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenuAndRestoreFocus();
      return;
    }
    if (nextIndex !== null && menuItems.length > 0) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  };

  const contextMenuTabIndex = contextMenu === null
    ? -1
    : tabs.findIndex(({ id }) => id === contextMenu.tabId);
  const closeOthersDisabled = tabs.length <= 1;
  const closeRightDisabled =
    contextMenuTabIndex < 0 || contextMenuTabIndex === tabs.length - 1;

  return (
    <div aria-label="会话标签" className={styles.root}>
      <div className={styles.scroller} role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              className={styles.tab}
              data-active={active}
              key={tab.id}
              onContextMenu={(event) => {
                if (disabled) {
                  return;
                }
                const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
                  '[role="tab"]',
                );
                if (trigger === null) {
                  return;
                }
                event.preventDefault();
                openContextMenu(tab, trigger, event.clientX, event.clientY);
              }}
            >
              <button
                aria-controls={
                  contextMenu?.tabId === tab.id ? contextMenuId : undefined
                }
                aria-expanded={contextMenu?.tabId === tab.id}
                aria-haspopup="menu"
                aria-selected={active}
                className={styles.activate}
                disabled={disabled}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => {
                  if (
                    disabled ||
                    (event.key !== "ContextMenu" &&
                      !(event.shiftKey && event.key === "F10"))
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  openContextMenu(
                    tab,
                    event.currentTarget,
                    bounds.left + 24,
                    bounds.top + 24,
                  );
                }}
                ref={active ? activeRef : undefined}
                role="tab"
                title={`${tab.title}\n${tab.projectPath ?? tab.projectName}`}
                type="button"
              >
                <span className={styles.labels}>
                  <span className={styles.titleRow}>
                    <span className={styles.statusWrapper}>
                      <ThreadStatusIndicator status={tab.status ?? null} />
                    </span>
                    <span className={styles.title}>{tab.title}</span>
                    <span
                      className={styles.projectBadge}
                      title={tab.projectPath ?? tab.projectName}
                    >
                      {tab.projectName}
                    </span>
                  </span>
                </span>
              </button>
              <button
                aria-label={`关闭“${tab.title}”`}
                className={styles.close}
                disabled={disabled}
                onClick={() => onClose(tab.id)}
                title="关闭标签 Ctrl+W"
                type="button"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <path d="m4 4 8 8m0-8-8 8" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      <button
        aria-label="新建会话标签"
        className={styles.newTab}
        disabled={disabled}
        onClick={onNew}
        title="新建会话标签 Ctrl+N / Ctrl+T"
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {contextMenu === null
        ? null
        : createPortal(
            <div
              aria-label={`标签“${contextMenu.title}”操作`}
              className={styles.contextMenu}
              id={contextMenuId}
              onKeyDown={handleContextMenuKeyDown}
              ref={contextMenuRef}
              role="menu"
              style={{
                left: menuPosition?.left ?? contextMenu.x,
                top: menuPosition?.top ?? contextMenu.y,
                visibility: menuPosition === null ? "hidden" : "visible",
              }}
            >
              <button
                onClick={() => runContextMenuAction(onClose)}
                role="menuitem"
                type="button"
              >
                <span>关闭标签</span>
                <small>Ctrl+W</small>
              </button>
              <button
                disabled={closeOthersDisabled}
                onClick={() => runContextMenuAction(onCloseOthers)}
                role="menuitem"
                type="button"
              >
                <span>关闭其他标签页</span>
              </button>
              <button
                disabled={closeRightDisabled}
                onClick={() => runContextMenuAction(onCloseRight)}
                role="menuitem"
                type="button"
              >
                <span>关闭右侧标签页</span>
              </button>
            </div>,
            document.body,
          )}
    </div>
  );
}

function fitMenuToViewport(
  x: number,
  y: number,
  bounds: Pick<DOMRect, "height" | "width">,
): MenuPosition {
  const margin = 8;
  return {
    left: Math.max(
      margin,
      Math.min(x, window.innerWidth - bounds.width - margin),
    ),
    top: Math.max(
      margin,
      Math.min(y, window.innerHeight - bounds.height - margin),
    ),
  };
}
