import { useEffect, useState } from "react";

import type { ThreadStatusKind } from "../app/threadIndicatorStatus";
import styles from "./ThreadStatusIndicator.module.css";

export type { ThreadStatusKind } from "../app/threadIndicatorStatus";

const STATUS_CONTENT: Readonly<
  Record<ThreadStatusKind, { readonly label: string; readonly text: string }>
> = Object.freeze({
  running: { label: "正在运行", text: "" },
  approval: { label: "等待审批", text: "审批" },
  input: { label: "等待输入", text: "待回复" },
  resultReady: { label: "任务已完成，等待查看", text: "" },
  error: { label: "会话失败", text: "失败" },
});

const RESULT_DISMISS_DURATION_MS = 160;

export function ThreadStatusIndicator({
  status,
}: {
  readonly status: ThreadStatusKind | null;
}) {
  const [retainedStatus, setRetainedStatus] =
    useState<ThreadStatusKind | null>(status);
  const visibleStatus = status ?? retainedStatus;
  const dismissing = status === null && retainedStatus === "resultReady";

  useEffect(() => {
    if (status !== null) {
      setRetainedStatus(status);
      return;
    }
    if (retainedStatus !== "resultReady") {
      setRetainedStatus(null);
      return;
    }
    const timeout = window.setTimeout(
      () => setRetainedStatus(null),
      RESULT_DISMISS_DURATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [retainedStatus, status]);

  if (visibleStatus === null) {
    return null;
  }
  const content = STATUS_CONTENT[visibleStatus];
  return (
    <span
      aria-label={content.label}
      className={styles.status}
      data-dismissing={dismissing}
      data-status={visibleStatus}
      role="img"
      title={content.label}
    >
      {visibleStatus === "resultReady" ? (
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6.25" />
          <path d="m5 8.1 2 2 4-4.2" />
        </svg>
      ) : content.text}
    </span>
  );
}
