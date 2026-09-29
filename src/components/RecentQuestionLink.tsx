import styles from "./ComposerAccessoryPanel.module.css";

export function RecentQuestionLink({ onClick }: { readonly onClick: () => void }) {
  return (
    <button className={styles.summary} onClick={onClick} type="button">
      <span aria-hidden="true" className={styles.icon}>
        <svg viewBox="0 0 24 24">
          <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
        </svg>
      </span>
      <span className={styles.summaryCopy}>查看最近提问</span>
      <span aria-hidden="true" className={styles.chevron}>↑</span>
    </button>
  );
}
