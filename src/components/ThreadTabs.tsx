import { useEffect, useRef } from "react";

import styles from "./ThreadTabs.module.css";

export interface ThreadTabView {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: "running" | "approval" | "input" | "error";
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
                title={tab.subtitle === undefined
                  ? tab.title
                  : `${tab.subtitle} / ${tab.title}`}
                type="button"
              >
                {tab.status === undefined ? null : (
                  <span
                    aria-label={statusLabel(tab.status)}
                    className={styles.status}
                    data-status={tab.status}
                    role="img"
                  />
                )}
                <span>{tab.title}</span>
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
        title="新建会话标签 Ctrl+T"
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
    </div>
  );
}

function statusLabel(status: NonNullable<ThreadTabView["status"]>): string {
  switch (status) {
    case "running":
      return "正在运行";
    case "approval":
      return "等待审批";
    case "input":
      return "等待输入";
    case "error":
      return "会话失败";
  }
}
