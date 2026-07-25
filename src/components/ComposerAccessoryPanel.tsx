import { useState, type ReactNode } from "react";

import styles from "./ComposerAccessoryPanel.module.css";

export function ComposerAccessoryPanel({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.panel} data-composer-accessory-panel>
      {children}
    </div>
  );
}

export function ComposerAccessoryRow({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <div className={styles.row}>{children}</div>;
}

export function ComposerAccessoryDisclosure({
  children,
  expanded,
  icon,
  label,
  live,
  onExpandedChange,
  summary,
}: {
  readonly children: ReactNode;
  readonly expanded: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly live?: "assertive" | "polite";
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly summary: ReactNode;
}) {
  const [detailMounted, setDetailMounted] = useState(expanded);
  const toggle = () => {
    if (!expanded) {
      setDetailMounted(true);
    }
    onExpandedChange(!expanded);
  };

  return (
    <section
      aria-label={label}
      aria-live={live}
      className={styles.disclosure}
      data-expanded={expanded}
    >
      <button
        aria-expanded={expanded}
        className={styles.summary}
        onClick={toggle}
        type="button"
      >
        <span className={styles.icon}>{icon}</span>
        <span className={styles.summaryCopy}>{summary}</span>
        <span aria-hidden="true" className={styles.chevron}>›</span>
      </button>
      <div className={styles.detailSize}>
        <div className={styles.detailClip}>
          <div className={styles.detail}>
            {detailMounted ? children : null}
          </div>
        </div>
      </div>
    </section>
  );
}
