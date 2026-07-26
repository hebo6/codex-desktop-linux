import { useEffect, useRef } from "react";

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

export function ThreadTabs({
  activeTabId,
  disabled = false,
  onActivate,
  onClose,
  onNew,
  tabs,
}: {
  readonly activeTabId: string | null;
  readonly disabled?: boolean;
  readonly onActivate: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onNew: () => void;
  readonly tabs: readonly ThreadTabView[];
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId]);

  return (
    <div aria-label="会话标签" className={styles.root}>
      <div className={styles.scroller} role="tablist">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div className={styles.tab} data-active={active} key={tab.id}>
              <button
                aria-selected={active}
                className={styles.activate}
                disabled={disabled}
                onClick={() => onActivate(tab.id)}
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
    </div>
  );
}
