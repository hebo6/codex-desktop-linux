import { useId } from "react";

import type { AsyncQuestionView } from "../app/useAsyncQuestions";
import {
  ComposerAccessoryDisclosure,
  ComposerAccessoryRow,
} from "./ComposerAccessoryPanel";
import styles from "./AsyncQuestionPanel.module.css";

export interface AsyncQuestionPanelProps {
  readonly questions: readonly AsyncQuestionView[];
  readonly selectedKey: string | null;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onSelect: (key: string) => void;
  readonly onDraftChange: (key: string, draft: string) => void;
  readonly onCustomAnswerChange: (key: string, customAnswer: boolean) => void;
  readonly onAnswer: (key: string, answer: string) => void;
  readonly onIgnore: (key: string) => void;
  readonly onRetry: () => void;
}

export function AsyncQuestionPanel({
  questions,
  selectedKey,
  expanded,
  disabled,
  error,
  onExpandedChange,
  onSelect,
  onDraftChange,
  onCustomAnswerChange,
  onAnswer,
  onIgnore,
  onRetry,
}: AsyncQuestionPanelProps) {
  const questionId = useId();
  const selectedIndex = selectedKey === null
    ? 0
    : questions.findIndex(({ key }) => key === selectedKey);
  const question = questions[selectedIndex];
  const storageError = error === null ? null : (
    <div className={styles.error}>
      <p role="status">{error}</p>
      <button className={styles.action} onClick={onRetry} type="button">
        重试
      </button>
    </div>
  );

  if (questions.length === 0) {
    return storageError === null ? null : (
      <ComposerAccessoryRow>{storageError}</ComposerAccessoryRow>
    );
  }

  const sending = question?.status === "sending";
  const answerDisabled = disabled || sending;
  const previous = questions[selectedIndex - 1];
  const next = questions[selectedIndex + 1];
  const hasOptions = question?.options !== null &&
    question?.options !== undefined && question.options.length > 0;

  return (
    <ComposerAccessoryDisclosure
      expanded={expanded}
      icon={<QuestionIcon />}
      label="异步提问"
      onExpandedChange={onExpandedChange}
      summary={`待回答 · ${questions.length}`}
    >
      <div className={styles.content}>
        {question === undefined ? null : (
          <div aria-labelledby={questionId} className={styles.question}>
            <div className={styles.header}>
              <span className={styles.hint}>
                {hasOptions ? "可随时回答 · 点击选项直接发送" : "可随时回答"}
              </span>
              {questions.length < 2 ? null : (
                <nav aria-label="切换待回答问题" className={styles.navigation}>
                  <button
                    className={styles.action}
                    disabled={previous === undefined}
                    onClick={() => {
                      if (previous !== undefined) {
                        onSelect(previous.key);
                      }
                    }}
                    type="button"
                  >
                    上一题
                  </button>
                  <span aria-live="polite">
                    {selectedIndex + 1} / {questions.length}
                  </span>
                  <button
                    className={styles.action}
                    disabled={next === undefined}
                    onClick={() => {
                      if (next !== undefined) {
                        onSelect(next.key);
                      }
                    }}
                    type="button"
                  >
                    下一题
                  </button>
                </nav>
              )}
            </div>
            <h3 className={styles.title} dir="auto" id={questionId}>
              {question.title}
            </h3>
            {hasOptions ? (
              <div aria-label="回答选项" className={styles.options} role="group">
                {question.options?.map((option, index) => (
                  <button
                    aria-pressed={question.answer === option}
                    className={styles.option}
                    disabled={answerDisabled}
                    key={`${index}:${option}`}
                    onClick={() => onAnswer(question.key, option)}
                    type="button"
                  >
                    <span dir="auto">{option}</span>
                    {question.answer === option ? (
                      <span aria-hidden="true" className={styles.selected}>✓</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            {question.customAnswer || !hasOptions ? (
              <div className={styles.customAnswer}>
                <label>
                  <span>自定义回答</span>
                  <textarea
                    dir="auto"
                    disabled={sending}
                    onChange={(event) =>
                      onDraftChange(question.key, event.currentTarget.value)}
                    rows={3}
                    value={question.draft}
                  />
                </label>
                <div className={styles.customActions}>
                  {hasOptions ? (
                    <button
                      className={styles.action}
                      disabled={sending}
                      onClick={() => onCustomAnswerChange(question.key, false)}
                      type="button"
                    >
                      收起自定义回答
                    </button>
                  ) : null}
                  <button
                    className={styles.sendAction}
                    disabled={answerDisabled || question.draft.trim() === ""}
                    onClick={() => onAnswer(question.key, question.draft)}
                    type="button"
                  >
                    发送回答
                  </button>
                </div>
              </div>
            ) : null}
            {sending ? (
              <p className={styles.hint} role="status">发送中…</p>
            ) : null}
            {question.error === null ? null : (
              <p
                className={question.status === "uncertain"
                  ? styles.warning
                  : styles.failure}
                role="status"
              >
                {question.error}
              </p>
            )}
            <div className={styles.footer}>
              {hasOptions && !question.customAnswer ? (
                <button
                  className={styles.action}
                  disabled={sending}
                  onClick={() => onCustomAnswerChange(question.key, true)}
                  type="button"
                >
                  自定义回答
                </button>
              ) : null}
              <button
                className={styles.action}
                disabled={sending}
                onClick={() => onIgnore(question.key)}
                type="button"
              >
                忽略此问题
              </button>
            </div>
          </div>
        )}
        {storageError}
      </div>
    </ComposerAccessoryDisclosure>
  );
}

function QuestionIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z" />
      <path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3" />
      <path d="M12 15h.01" />
    </svg>
  );
}
