import { useId, useRef, useState } from "react";

import type { AsyncUserInputQuestion } from "../protocol/generated/types/ServerNotification";
import styles from "./AsyncQuestionMessage.module.css";

export interface AsyncQuestionMessageProps {
  readonly questions: readonly AsyncUserInputQuestion[];
  readonly onReply?: (text: string) => Promise<boolean>;
  readonly disabled: boolean;
}

export function AsyncQuestionMessage({
  questions,
  onReply,
  disabled,
}: AsyncQuestionMessageProps) {
  const sendingRef = useRef(false);
  const [sendingIndex, setSendingIndex] = useState<number | null>(null);
  const [errorIndex, setErrorIndex] = useState<number | null>(null);

  const reply = async (index: number, text: string): Promise<boolean> => {
    if (disabled || onReply === undefined || sendingRef.current || text.trim() === "") {
      return false;
    }
    sendingRef.current = true;
    setSendingIndex(index);
    setErrorIndex(null);
    try {
      const accepted = await onReply(text);
      if (!accepted) setErrorIndex(index);
      return accepted;
    } catch {
      setErrorIndex(index);
      return false;
    } finally {
      sendingRef.current = false;
      setSendingIndex(null);
    }
  };

  if (questions.length === 0) return null;

  return (
    <div aria-label="异步提问" className={styles.questions} role="region">
      {questions.map((question, index) => (
        <Question
          disabled={disabled || onReply === undefined || sendingIndex !== null}
          error={errorIndex === index}
          key={`${index}:${question.title}`}
          onReply={(text) => reply(index, text)}
          question={question}
          sending={sendingIndex === index}
        />
      ))}
    </div>
  );
}

function Question({
  question,
  disabled,
  sending,
  error,
  onReply,
}: {
  readonly question: AsyncUserInputQuestion;
  readonly disabled: boolean;
  readonly sending: boolean;
  readonly error: boolean;
  readonly onReply: (text: string) => Promise<boolean>;
}) {
  const titleId = useId();
  const [customReply, setCustomReply] = useState(false);
  const [draft, setDraft] = useState("");
  const hasOptions = (question.options?.length ?? 0) > 0;

  const submitDraft = async () => {
    if (await onReply(draft)) setDraft("");
  };

  return (
    <section aria-labelledby={titleId} className={styles.question}>
      <h3 className={styles.title} dir="auto" id={titleId}>{question.title}</h3>
      {hasOptions ? (
        <div aria-label="回复选项" className={styles.options} role="group">
          {question.options?.map((option, index) => (
            <button
              className={styles.option}
              dir="auto"
              disabled={disabled}
              key={`${index}:${option}`}
              onClick={() => { void onReply(option); }}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {customReply || !hasOptions ? (
        <div className={styles.customReply}>
          <label>
            <span>自定义回复</span>
            <textarea
              dir="auto"
              disabled={sending}
              onChange={(event) => setDraft(event.currentTarget.value)}
              rows={3}
              value={draft}
            />
          </label>
          <div className={styles.actions}>
            {hasOptions ? (
              <button
                className={styles.action}
                disabled={sending}
                onClick={() => setCustomReply(false)}
                type="button"
              >
                收起自定义回复
              </button>
            ) : null}
            <button
              className={styles.sendAction}
              disabled={disabled || draft.trim() === ""}
              onClick={() => { void submitDraft(); }}
              type="button"
            >
              发送回复
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            className={styles.action}
            disabled={sending}
            onClick={() => setCustomReply(true)}
            type="button"
          >
            自定义回复
          </button>
          <span className={styles.hint}>点击选项直接发送</span>
        </div>
      )}
      {sending ? <p className={styles.hint} role="status">发送中…</p> : null}
      {error ? (
        <p className={styles.error} role="status">
          发送结果未确认，请检查聊天记录后再重试
        </p>
      ) : null}
    </section>
  );
}
