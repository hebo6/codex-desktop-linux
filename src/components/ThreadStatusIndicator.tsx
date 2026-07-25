import styles from "./ThreadStatusIndicator.module.css";

export type ThreadStatusKind = "running" | "approval" | "input" | "error";

const STATUS_CONTENT: Readonly<
  Record<ThreadStatusKind, { readonly label: string; readonly text: string }>
> = Object.freeze({
  running: { label: "正在运行", text: "" },
  approval: { label: "等待审批", text: "审批" },
  input: { label: "等待输入", text: "待回复" },
  error: { label: "会话失败", text: "失败" },
});

export function ThreadStatusIndicator({
  status,
}: {
  readonly status: ThreadStatusKind;
}) {
  const content = STATUS_CONTENT[status];
  return (
    <span
      aria-label={content.label}
      className={styles.status}
      data-status={status}
      role="img"
    >
      {content.text}
    </span>
  );
}
