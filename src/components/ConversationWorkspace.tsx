import type { ReactNode } from "react";

import styles from "./ConversationWorkspace.module.css";

export function ConversationWorkspace({
  children,
  composer,
}: {
  readonly children: ReactNode;
  readonly composer: ReactNode;
}) {
  return (
    <div className={styles.workspace}>
      <div className={styles.content}>{children}</div>
      {composer}
    </div>
  );
}
